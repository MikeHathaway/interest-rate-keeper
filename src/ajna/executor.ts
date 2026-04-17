import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type EstimateFeesPerGasReturnType,
  type PublicClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ajnaPoolAbi, erc20Abi } from "./abi.js";
import { requireAjnaPrivateKey } from "./runtime.js";
import { DryRunExecutionBackend, StepwiseExecutionBackend } from "../execute.js";
import {
    type AddCollateralStep,
    type AddQuoteStep,
    type DrawDebtStep,
    type HexAddress,
    type KeeperConfig,
    type RemoveCollateralStep,
  type RemoveQuoteStep,
  type RepayDebtStep
} from "../types.js";

interface LiveAjnaRuntime {
  poolAddress: HexAddress;
  rpcUrl: string;
  borrowerAddress?: HexAddress;
  recipientAddress?: HexAddress;
}

interface ContractWriteSpec {
  address: HexAddress;
  abi: typeof ajnaPoolAbi;
  functionName:
    | "addQuoteToken"
    | "removeQuoteToken"
    | "drawDebt"
    | "repayDebt"
    | "addCollateral"
    | "removeCollateral"
    | "updateInterest";
  args: readonly unknown[];
}

function assertLiveAjnaConfig(config: KeeperConfig): LiveAjnaRuntime {
  if (!config.poolAddress) {
    throw new Error("live Ajna execution requires config.poolAddress");
  }

  if (!config.rpcUrl) {
    throw new Error("live Ajna execution requires config.rpcUrl");
  }

  const runtime: LiveAjnaRuntime = {
    poolAddress: config.poolAddress,
    rpcUrl: config.rpcUrl
  };

  if (config.borrowerAddress !== undefined) {
    runtime.borrowerAddress = config.borrowerAddress;
  }

  if (config.recipientAddress !== undefined) {
    runtime.recipientAddress = config.recipientAddress;
  }

  return runtime;
}

async function waitForSuccess(publicClient: PublicClient, hash: Hex): Promise<Hex> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`transaction ${hash} reverted`);
  }

  return hash;
}

async function requireAllowance(
  publicClient: PublicClient,
  tokenAddress: HexAddress,
  owner: HexAddress,
  spender: HexAddress,
  amount: bigint,
  label: string
): Promise<void> {
  if (amount <= 0n) {
    return;
  }

  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender]
  });

  if (allowance < amount) {
    throw new Error(
      `${label} allowance too low for ${tokenAddress}; approve at least ${amount.toString()} before running live execution`
    );
  }
}

function resolveFeeCapWei(fees: EstimateFeesPerGasReturnType): bigint | undefined {
  if ("maxFeePerGas" in fees && fees.maxFeePerGas !== undefined) {
    return fees.maxFeePerGas;
  }

  if ("gasPrice" in fees && fees.gasPrice !== undefined) {
    return fees.gasPrice;
  }

  return undefined;
}

export function estimateGasCostWei(
  estimatedGas: bigint,
  feeCapWei: bigint
): bigint {
  return estimatedGas * feeCapWei;
}

export function assertGasCostWithinCap(
  estimatedGas: bigint,
  feeCapWei: bigint,
  maxGasCostWei: bigint | undefined,
  functionName: ContractWriteSpec["functionName"]
): void {
  if (maxGasCostWei === undefined) {
    return;
  }

  const estimatedCostWei = estimateGasCostWei(estimatedGas, feeCapWei);
  if (estimatedCostWei > maxGasCostWei) {
    throw new Error(
      `${functionName} estimated gas cost ${estimatedCostWei.toString()} exceeds maxGasCostWei ${maxGasCostWei.toString()}`
    );
  }
}

export function createAjnaExecutionBackend(config: KeeperConfig) {
  const runtime = assertLiveAjnaConfig(config);
  const account = privateKeyToAccount(requireAjnaPrivateKey());
  const publicClient = createPublicClient({
    transport: http(runtime.rpcUrl, { batch: true })
  });
  const walletClient = createWalletClient({
    account,
    transport: http(runtime.rpcUrl, { batch: true })
  });

  let tokenAddressesPromise:
    | Promise<{ quoteTokenAddress: HexAddress; collateralAddress: HexAddress }>
    | undefined;

  async function resolvePoolTokens() {
    if (!tokenAddressesPromise) {
      tokenAddressesPromise = Promise.all([
        publicClient.readContract({
          address: runtime.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "quoteTokenAddress"
        }),
        publicClient.readContract({
          address: runtime.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "collateralAddress"
        })
      ]).then(([quoteTokenAddress, collateralAddress]) => ({
        quoteTokenAddress,
        collateralAddress
      }));
    }

    return tokenAddressesPromise;
  }

  const borrowerAddress = runtime.borrowerAddress ?? account.address;
  const defaultRecipientAddress = runtime.recipientAddress ?? account.address;

  async function submitContractCall(spec: ContractWriteSpec): Promise<{ transactionHash: Hex }> {
    const [estimatedGas, fees] = await Promise.all([
      publicClient.estimateContractGas({
        account,
        address: spec.address,
        abi: spec.abi,
        functionName: spec.functionName as never,
        args: spec.args as never
      }),
      publicClient
        .estimateFeesPerGas({ chain: undefined })
        .catch(async () => ({
          gasPrice: await publicClient.getGasPrice()
        }))
    ]);
    const feeCapWei =
      resolveFeeCapWei(fees) ?? (await publicClient.getGasPrice());
    assertGasCostWithinCap(
      estimatedGas,
      feeCapWei,
      config.maxGasCostWei,
      spec.functionName
    );

    const hash = await walletClient.writeContract({
      account,
      chain: undefined,
      address: spec.address,
      abi: spec.abi,
      functionName: spec.functionName as never,
      args: spec.args as never
    });

    return {
      transactionHash: await waitForSuccess(publicClient, hash)
    };
  }

  return new StepwiseExecutionBackend({
    ADD_QUOTE: async (step) => {
      const addQuoteStep = step as AddQuoteStep;
      const { quoteTokenAddress } = await resolvePoolTokens();
      await requireAllowance(
        publicClient,
        quoteTokenAddress,
        account.address,
        runtime.poolAddress,
        addQuoteStep.amount,
        "quote token"
      );
      return submitContractCall({
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "addQuoteToken",
        args: [
          addQuoteStep.amount,
          BigInt(addQuoteStep.bucketIndex),
          BigInt(addQuoteStep.expiry)
        ]
      });
    },
    REMOVE_QUOTE: async (step) => {
      const removeQuoteStep = step as RemoveQuoteStep;
      return submitContractCall({
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "removeQuoteToken",
        args: [removeQuoteStep.amount, BigInt(removeQuoteStep.bucketIndex)]
      });
    },
    DRAW_DEBT: async (step) => {
      const drawDebtStep = step as DrawDebtStep;
      const collateralAmount = drawDebtStep.collateralAmount ?? 0n;
      if (collateralAmount > 0n) {
        const { collateralAddress } = await resolvePoolTokens();
        await requireAllowance(
          publicClient,
          collateralAddress,
          account.address,
          runtime.poolAddress,
          collateralAmount,
          "collateral token"
        );
      }
      return submitContractCall({
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "drawDebt",
        args: [
          borrowerAddress,
          drawDebtStep.amount,
          BigInt(drawDebtStep.limitIndex),
          collateralAmount
        ]
      });
    },
    REPAY_DEBT: async (step) => {
      const repayDebtStep = step as RepayDebtStep;
      const { quoteTokenAddress } = await resolvePoolTokens();
      await requireAllowance(
        publicClient,
        quoteTokenAddress,
        account.address,
        runtime.poolAddress,
        repayDebtStep.amount,
        "quote token"
      );
      return submitContractCall({
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "repayDebt",
        args: [
          borrowerAddress,
          repayDebtStep.amount,
          repayDebtStep.collateralAmountToPull ?? 0n,
          repayDebtStep.recipient ?? defaultRecipientAddress,
          BigInt(repayDebtStep.limitIndex ?? 0)
        ]
      });
    },
    ADD_COLLATERAL: async (step) => {
      const addCollateralStep = step as AddCollateralStep;
      if (addCollateralStep.expiry === undefined) {
        throw new Error("Ajna ADD_COLLATERAL execution requires an expiry value");
      }

      const { collateralAddress } = await resolvePoolTokens();
      await requireAllowance(
        publicClient,
        collateralAddress,
        account.address,
        runtime.poolAddress,
        addCollateralStep.amount,
        "collateral token"
      );
      return submitContractCall({
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "addCollateral",
        args: [
          addCollateralStep.amount,
          BigInt(addCollateralStep.bucketIndex),
          BigInt(addCollateralStep.expiry)
        ]
      });
    },
    REMOVE_COLLATERAL: async (step) => {
      const removeCollateralStep = step as RemoveCollateralStep;
      if (removeCollateralStep.bucketIndex === undefined) {
        throw new Error("Ajna REMOVE_COLLATERAL execution requires bucketIndex");
      }
      return submitContractCall({
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "removeCollateral",
        args: [
          removeCollateralStep.amount,
          BigInt(removeCollateralStep.bucketIndex)
        ]
      });
    },
    UPDATE_INTEREST: async () =>
      submitContractCall({
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "updateInterest",
        args: []
      })
  });
}

export { DryRunExecutionBackend };

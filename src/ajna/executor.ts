import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ajnaPoolAbi, erc20Abi } from "./abi.js";
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

function resolvePrivateKey(): Hex {
  const candidate = process.env.AJNA_KEEPER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!candidate) {
    throw new Error(
      "live Ajna execution requires AJNA_KEEPER_PRIVATE_KEY or PRIVATE_KEY in the environment"
    );
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(candidate)) {
    throw new Error("private key must be a 32-byte hex string");
  }

  return candidate as Hex;
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

export function createAjnaExecutionBackend(config: KeeperConfig) {
  const runtime = assertLiveAjnaConfig(config);
  const account = privateKeyToAccount(resolvePrivateKey());
  const publicClient = createPublicClient({
    transport: http(runtime.rpcUrl)
  });
  const walletClient = createWalletClient({
    account,
    transport: http(runtime.rpcUrl)
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

      const hash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "addQuoteToken",
        args: [
          addQuoteStep.amount,
          BigInt(addQuoteStep.bucketIndex),
          BigInt(addQuoteStep.expiry)
        ]
      });

      return {
        transactionHash: await waitForSuccess(publicClient, hash)
      };
    },
    REMOVE_QUOTE: async (step) => {
      const removeQuoteStep = step as RemoveQuoteStep;
      const hash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "removeQuoteToken",
        args: [removeQuoteStep.amount, BigInt(removeQuoteStep.bucketIndex)]
      });

      return {
        transactionHash: await waitForSuccess(publicClient, hash)
      };
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

      const hash = await walletClient.writeContract({
        account,
        chain: undefined,
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

      return {
        transactionHash: await waitForSuccess(publicClient, hash)
      };
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

      const hash = await walletClient.writeContract({
        account,
        chain: undefined,
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

      return {
        transactionHash: await waitForSuccess(publicClient, hash)
      };
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

      const hash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "addCollateral",
        args: [
          addCollateralStep.amount,
          BigInt(addCollateralStep.bucketIndex),
          BigInt(addCollateralStep.expiry)
        ]
      });

      return {
        transactionHash: await waitForSuccess(publicClient, hash)
      };
    },
    REMOVE_COLLATERAL: async (step) => {
      const removeCollateralStep = step as RemoveCollateralStep;
      if (removeCollateralStep.bucketIndex === undefined) {
        throw new Error("Ajna REMOVE_COLLATERAL execution requires bucketIndex");
      }

      const hash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "removeCollateral",
        args: [
          removeCollateralStep.amount,
          BigInt(removeCollateralStep.bucketIndex)
        ]
      });

      return {
        transactionHash: await waitForSuccess(publicClient, hash)
      };
    },
    UPDATE_INTEREST: async () => {
      const hash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: runtime.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "updateInterest",
        args: []
      });

      return {
        transactionHash: await waitForSuccess(publicClient, hash)
      };
    }
  });
}

export { DryRunExecutionBackend };

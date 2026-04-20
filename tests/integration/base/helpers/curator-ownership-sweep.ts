// Synthetic-pool sweep to find the operator bucket-ownership threshold at
// which curator REMOVE_QUOTE starts surfacing.
//
// The real pinned archetypes are an imperfect experiment here: dog/USDC has
// ~100% operator ownership and PRIME/USDC has ~9%, but we have no clean way
// to vary real-chain USDC balances. Instead we build a fresh synthetic Ajna
// pool (mock ERC20 quote + collateral), add two borrowers to clear the
// noOfLoans > 1 gate, warp time + call updateInterest to initialize EMAs,
// then deposit the operator's LP at a controlled fraction of the target
// bucket's total deposit. Running the standard AjnaRpcSnapshotSource +
// curator config then tells us whether an exact REMOVE_QUOTE candidate
// surfaces at that fraction.

import { privateKeyToAccount } from "viem/accounts";
import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  resolveKeeperConfig
} from "../../../../src/index.js";
import { readPoolSnapshotMetadata } from "../../../../src/core/snapshot/metadata.js";
import {
  advanceAndApplyEligibleUpdatesDirect,
  approveToken,
  deployMockToken,
  deployPoolThroughFactory,
  DEFAULT_ANVIL_PRIVATE_KEY,
  LOCAL_RPC_URL,
  type MockArtifact,
  mintToken
} from "./shared.js";

export interface SweepFractionResult {
  fractionBps: number;
  operatorFraction: number;
  operatorDepositWad: bigint;
  bucketDepositBeforeOperatorWad: bigint;
  bucketDepositAfterOperatorWad: bigint;
  noOfLoans: number;
  currentRateBps: number;
  targetRateBps: number;
  predictedNextRateBps: number;
  predictedNextOutcome: string;
  secondsUntilNextRateUpdate: number;
  managedInventoryUpwardEligible: boolean | undefined;
  managedInventoryIneligibilityReason: string | undefined;
  candidateSurfaced: boolean;
  candidateSummary?: string;
  predictedRateBpsAfterNextUpdate?: number;
  planningRateBps?: number;
  planningLookaheadUpdates?: number;
  removeQuoteAmountWad?: bigint;
}

export interface SweepInput {
  account: { address: `0x${string}` };
  publicClient: any;
  walletClient: any;
  testClient: any;
  artifact: MockArtifact;
  fractions: readonly number[]; // e.g. [0.10, 0.30, 0.50, 0.80, 0.95]
  targetBucketIndex?: number;
  baseLenderDepositQuoteToken?: bigint;
  debtAmountsQuoteToken?: readonly bigint[];
  collateralAmountsCollateralToken?: readonly bigint[];
  emaWarmupCycles?: number;
  targetOffsetBps?: number;
  toleranceBps?: number;
}

// Two impersonated borrower addresses. Using deterministic low-byte
// addresses avoids any collision with anvil-pre-funded accounts or Ajna
// protocol-known addresses. Both get impersonated + ETH-funded before use.
const BORROWER_A_ADDRESS =
  "0x00000000000000000000000000000000000000b1" as `0x${string}`;
const BORROWER_B_ADDRESS =
  "0x00000000000000000000000000000000000000b2" as `0x${string}`;
const OPERATOR_ADDRESS =
  "0x0000000000000000000000000000000000000aaa" as `0x${string}`;

async function prepareImpersonatedActor(params: {
  testClient: any;
  publicClient: any;
  walletClient: any;
  artifact: MockArtifact;
  address: `0x${string}`;
  defaultAccount: { address: `0x${string}` };
  quoteTokenAddress: `0x${string}`;
  collateralTokenAddress: `0x${string}`;
  quoteAmount: bigint;
  collateralAmount: bigint;
  poolAddress: `0x${string}`;
}): Promise<void> {
  await params.testClient.impersonateAccount({ address: params.address });
  await params.testClient.setBalance({
    address: params.address,
    value: 10n ** 22n
  });

  if (params.quoteAmount > 0n) {
    await mintToken(
      params.walletClient,
      params.publicClient,
      params.artifact,
      params.quoteTokenAddress,
      params.address,
      params.quoteAmount
    );
    await params.publicClient.waitForTransactionReceipt({
      hash: await params.walletClient.writeContract({
        account: params.address,
        chain: undefined,
        address: params.quoteTokenAddress,
        abi: params.artifact.abi,
        functionName: "approve",
        args: [params.poolAddress, 2n ** 255n]
      })
    });
  }

  if (params.collateralAmount > 0n) {
    await mintToken(
      params.walletClient,
      params.publicClient,
      params.artifact,
      params.collateralTokenAddress,
      params.address,
      params.collateralAmount
    );
    await params.publicClient.waitForTransactionReceipt({
      hash: await params.walletClient.writeContract({
        account: params.address,
        chain: undefined,
        address: params.collateralTokenAddress,
        abi: params.artifact.abi,
        functionName: "approve",
        args: [params.poolAddress, 2n ** 255n]
      })
    });
  }
}

async function runOneFractionTrial(
  input: SweepInput,
  operatorFraction: number
): Promise<SweepFractionResult> {
  const {
    account,
    publicClient,
    walletClient,
    testClient,
    artifact
  } = input;
  const targetBucketIndex = input.targetBucketIndex ?? 3000;
  const baseLenderDepositWad =
    (input.baseLenderDepositQuoteToken ?? 10_000n) * 10n ** 18n;
  const debtAmountsWad = (
    input.debtAmountsQuoteToken ?? [3_000n, 2_000n]
  ).map((amount) => amount * 10n ** 18n);
  const collateralAmountsWad = (
    input.collateralAmountsCollateralToken ?? [6_000n, 4_000n]
  ).map((amount) => amount * 10n ** 18n);
  const emaWarmupCycles = input.emaWarmupCycles ?? 3;
  const targetOffsetBps = input.targetOffsetBps ?? 200;
  const toleranceBps = input.toleranceBps ?? 50;

  // We don't use testClient.snapshot/revert here: reverting reliably but
  // viem's walletClient caches account nonces, and a post-revert cached nonce
  // can silently desync from the reverted chain state. Instead every trial
  // deploys brand-new mock tokens and a brand-new pool, so prior trial state
  // is irrelevant to the current trial. Leftover impersonation state for
  // borrower / operator addresses is harmless: impersonateAccount is
  // idempotent and each borrower's drawDebt / operator's addQuoteToken targets
  // the fresh pool address.
  {
    const quoteToken = await deployMockToken(
      walletClient,
      publicClient,
      artifact,
      `Curator Sweep Quote ${Math.round(operatorFraction * 10_000)}`,
      `CSQ${Math.round(operatorFraction * 10_000)}`
    );
    const collateralToken = await deployMockToken(
      walletClient,
      publicClient,
      artifact,
      `Curator Sweep Collateral ${Math.round(operatorFraction * 10_000)}`,
      `CSC${Math.round(operatorFraction * 10_000)}`
    );

    // Default account hosts the base lender role and owns enough quote
    // inventory to seed the bucket + (later) fund the operator if needed.
    await mintToken(
      walletClient,
      publicClient,
      artifact,
      quoteToken,
      account.address,
      baseLenderDepositWad * 100n
    );
    await mintToken(
      walletClient,
      publicClient,
      artifact,
      collateralToken,
      account.address,
      collateralAmountsWad.reduce(
        (acc, amount) => acc + amount,
        0n
      ) * 10n
    );

    const poolAddress = await deployPoolThroughFactory(
      walletClient,
      publicClient,
      collateralToken,
      quoteToken
    );

    await approveToken(
      walletClient,
      publicClient,
      quoteToken,
      poolAddress,
      2n ** 255n,
      artifact.abi
    );
    await approveToken(
      walletClient,
      publicClient,
      collateralToken,
      poolAddress,
      2n ** 255n,
      artifact.abi
    );

    // Base lender seeds the target bucket with a fixed deposit that will
    // define the operator-fraction denominator after the operator also
    // deposits at the end.
    const latestBlock = await publicClient.getBlock();
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        account,
        chain: undefined,
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "addQuoteToken",
        args: [
          baseLenderDepositWad,
          BigInt(targetBucketIndex),
          latestBlock.timestamp + 3600n
        ]
      })
    });

    // Two borrowers to satisfy the `noOfLoans > 1` eligibility gate. Each
    // draws debt at the target bucket index; both need fresh collateral.
    const borrowerAddresses = [BORROWER_A_ADDRESS, BORROWER_B_ADDRESS];
    for (let borrowerIndex = 0; borrowerIndex < borrowerAddresses.length; borrowerIndex += 1) {
      const borrowerAddress = borrowerAddresses[borrowerIndex]!;
      await prepareImpersonatedActor({
        testClient,
        publicClient,
        walletClient,
        artifact,
        address: borrowerAddress,
        defaultAccount: account,
        quoteTokenAddress: quoteToken,
        collateralTokenAddress: collateralToken,
        quoteAmount: 0n,
        collateralAmount: collateralAmountsWad[borrowerIndex]!,
        poolAddress
      });
      await publicClient.waitForTransactionReceipt({
        hash: await walletClient.writeContract({
          account: borrowerAddress,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "drawDebt",
          args: [
            borrowerAddress,
            debtAmountsWad[borrowerIndex]!,
            BigInt(targetBucketIndex),
            collateralAmountsWad[borrowerIndex]!
          ]
        })
      });
      await testClient.stopImpersonatingAccount({ address: borrowerAddress });
    }

    // EMA warmup: warp the minimum 12h rate-update interval count times and
    // trigger updateInterest each time so debtEma, depositEma, etc. become
    // nonzero. This is what the production managed-diagnostics.ts gate
    // requires to call the pool "EMA-initialized used pool".
    await advanceAndApplyEligibleUpdatesDirect(
      account,
      publicClient,
      walletClient,
      testClient,
      poolAddress,
      emaWarmupCycles
    );

    // Read the bucket state AFTER warmup so we compute operator fraction
    // against the accrued-interest deposit, not the initial deposit.
    const bucketInfoBeforeOperator = await publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "bucketInfo",
      args: [BigInt(targetBucketIndex)]
    });
    const bucketDepositBeforeOperatorWad = bucketInfoBeforeOperator[3];

    // Solve for operator deposit D such that D / (B + D) = fraction, where
    // B is the existing bucket deposit. Rearranging: D = B * f / (1 - f).
    // Using bigint math with 4-decimal fractionBps precision.
    const fractionBps = Math.round(operatorFraction * 10_000);
    const operatorDepositWad =
      (bucketDepositBeforeOperatorWad * BigInt(fractionBps)) /
      BigInt(10_000 - fractionBps);

    // Operator impersonation + deposit into the same bucket. The operator's
    // lp will sit on top of the existing deposit and give them exactly the
    // target fraction of the new bucket total.
    await prepareImpersonatedActor({
      testClient,
      publicClient,
      walletClient,
      artifact,
      address: OPERATOR_ADDRESS,
      defaultAccount: account,
      quoteTokenAddress: quoteToken,
      collateralTokenAddress: collateralToken,
      quoteAmount: operatorDepositWad,
      collateralAmount: 0n,
      poolAddress
    });
    const operatorExpiryBlock = await publicClient.getBlock();
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        account: OPERATOR_ADDRESS,
        chain: undefined,
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "addQuoteToken",
        args: [
          operatorDepositWad,
          BigInt(targetBucketIndex),
          operatorExpiryBlock.timestamp + 3600n
        ]
      })
    });

    const bucketInfoAfterOperator = await publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "bucketInfo",
      args: [BigInt(targetBucketIndex)]
    });
    const bucketDepositAfterOperatorWad = bucketInfoAfterOperator[3];

    // At this point the bucket has (roughly) (B + D) deposit and the
    // operator's share is D. Run the keeper's snapshot source with curator
    // mode on, configured to steer rate upward from current.
    const currentRateInfo = await publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "interestRateInfo"
    });
    const [currentRateWad] = currentRateInfo;
    const currentRateBps = Number(
      (currentRateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n
    );
    const targetRateBps = currentRateBps + targetOffsetBps;

    const chainNow = Number((await publicClient.getBlock()).timestamp);
    process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;
    const config = resolveKeeperConfig({
      chainId: 8453,
      poolAddress,
      poolId: `8453:${poolAddress.toLowerCase()}`,
      rpcUrl: LOCAL_RPC_URL,
      simulationSenderAddress: OPERATOR_ADDRESS,
      borrowerAddress: OPERATOR_ADDRESS,
      targetRateBps,
      toleranceBps,
      toleranceMode: "absolute",
      completionPolicy: "next_move_would_overshoot",
      executionBufferBps: 0,
      removeQuoteBucketIndex: targetBucketIndex,
      borrowSimulationLookaheadUpdates: 2,
      maxQuoteTokenExposure: "1000000000000000000000000",
      maxBorrowExposure: "1000000000000000000000",
      snapshotAgeMaxSeconds: 3600,
      minTimeBeforeRateWindowSeconds: 120,
      minExecutableActionQuoteToken: "1",
      recheckBeforeSubmit: true,
      enableSimulationBackedLendSynthesis: true,
      enableSimulationBackedBorrowSynthesis: false,
      enableManagedInventoryUpwardControl: true,
      enableManagedDualUpwardControl: false,
      enableHeuristicLendSynthesis: false,
      enableHeuristicBorrowSynthesis: false
    });

    const snapshot = await new AjnaRpcSnapshotSource(config, {
      publicClient,
      now: () => chainNow
    }).getSnapshot();
    const metadata = readPoolSnapshotMetadata(snapshot);
    const noOfLoans = Number(metadata.noOfLoans ?? "0");

    const removeQuoteCandidate = snapshot.candidates.find(
      (c) =>
        c.candidateSource === "simulation" &&
        c.intent === "LEND" &&
        c.minimumExecutionSteps.some((step) => step.type === "REMOVE_QUOTE")
    );

    return {
      fractionBps,
      operatorFraction,
      operatorDepositWad,
      bucketDepositBeforeOperatorWad,
      bucketDepositAfterOperatorWad,
      noOfLoans,
      currentRateBps,
      targetRateBps,
      predictedNextRateBps: snapshot.predictedNextRateBps,
      predictedNextOutcome: snapshot.predictedNextOutcome,
      secondsUntilNextRateUpdate: snapshot.secondsUntilNextRateUpdate,
      managedInventoryUpwardEligible:
        metadata.managedInventoryUpwardEligible,
      managedInventoryIneligibilityReason:
        metadata.managedInventoryIneligibilityReason,
      candidateSurfaced: removeQuoteCandidate !== undefined,
      ...(removeQuoteCandidate === undefined
        ? {}
        : (() => {
            const removeStep = removeQuoteCandidate.minimumExecutionSteps.find(
              (
                step
              ): step is Extract<
                typeof step,
                { type: "REMOVE_QUOTE" }
              > => step.type === "REMOVE_QUOTE"
            );
            return {
              candidateSummary: `${removeQuoteCandidate.intent}:${removeQuoteCandidate.minimumExecutionSteps
                .map((s) => s.type)
                .join("+")}`,
              predictedRateBpsAfterNextUpdate:
                removeQuoteCandidate.predictedRateBpsAfterNextUpdate,
              ...(removeQuoteCandidate.planningRateBps === undefined
                ? {}
                : { planningRateBps: removeQuoteCandidate.planningRateBps }),
              ...(removeQuoteCandidate.planningLookaheadUpdates === undefined
                ? {}
                : {
                    planningLookaheadUpdates:
                      removeQuoteCandidate.planningLookaheadUpdates
                  }),
              ...(removeStep === undefined
                ? {}
                : { removeQuoteAmountWad: removeStep.amount })
            };
          })())
    };
  }
}

export async function sweepSyntheticOwnershipFractions(
  input: SweepInput
): Promise<SweepFractionResult[]> {
  const results: SweepFractionResult[] = [];
  for (const fraction of input.fractions) {
    if (fraction <= 0 || fraction >= 1) {
      throw new Error(
        `sweep fraction must be strictly between 0 and 1: got ${fraction}`
      );
    }
    const result = await runOneFractionTrial(input, fraction);
    results.push(result);
  }
  return results;
}

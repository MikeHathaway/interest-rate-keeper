// Constructs a synthetic Ajna pool specifically engineered to satisfy every
// condition the dual managed-upward synthesis needs, then runs the exact
// synthesis with the debug listener captured. The point is to test whether
// dual mode fails on real archetypes (PRIME/USDC etc.) because of the
// keeper's search logic OR because of the archetype's pool state.
//
// The fixture ensures:
//   1. Operator owns ~95% of the target bucket's deposit (single-action
//      ownership threshold from the earlier sweep finding).
//   2. Operator is also the borrower on the same account (the managed-dual
//      eligibility gate `sameAccountManagedBorrower === true`).
//   3. Operator has generous collateral headroom — the existing debt is a
//      tiny fraction of what the collateral could support, so `drawDebt`
//      won't revert for meaningful additional amounts.
//   4. A second borrower (default anvil account) creates the noOfLoans > 1
//      state the managed-eligibility gate requires.
//   5. EMAs are warmed up through 3 rate-update cycles so the pool is
//      "EMA-initialized used pool" per the eligibility gate.
//
// If dual synthesis still produces no improving candidate under these
// conditions, the failure is deeper than pool-state variance — the dual
// code path has a structural issue. If it does surface, the docs can say
// "dual is ship-able on pools where [these conditions] hold."

import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  resolveKeeperConfig
} from "../../../../src/index.js";
import { readPoolSnapshotMetadata } from "../../../../src/core/snapshot/metadata.js";
import {
  setDualSynthesisDebugTrace,
  type DualSynthesisEvaluationEvent
} from "../../../../src/ajna/synthesize/dual/exact.js";
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

// Operator address (impersonated) — acts as both the lender-with-dominant-
// bucket-ownership AND the same-account borrower. Second borrower lives at
// the default anvil account so noOfLoans ≥ 2.
const OPERATOR_ADDRESS =
  "0x0000000000000000000000000000000000000aaa" as `0x${string}`;

export interface DualViableProbeResult {
  poolAddress: `0x${string}`;
  targetBucketIndex: number;
  operatorBucketOwnershipFraction: number;
  operatorCollateralWad: bigint;
  operatorExistingDebtWad: bigint;
  collateralHeadroomRatio: number;
  currentRateBps: number;
  targetRateBps: number;
  predictedNextRateBps: number;
  managedInventoryUpwardEligible: boolean | undefined;
  managedInventoryIneligibilityReason: string | undefined;
  noOfLoans: number;
  singleActionCandidateSurfaced: boolean;
  singleActionCandidateSummary:
    | {
        id: string;
        intent: string;
        predictedRateBpsAfterNextUpdate: number;
        planningRateBps?: number | undefined;
        resultingDistanceToTargetBps: number;
      }
    | undefined;
  allCandidateSummaries: Array<{
    intent: string;
    steps: string[];
    predictedRateBpsAfterNextUpdate: number;
    resultingDistanceToTargetBps: number;
  }>;
  dualCandidateSurfaced: boolean;
  dualCandidate:
    | {
        id: string;
        predictedRateBpsAfterNextUpdate: number;
        planningRateBps?: number | undefined;
        planningLookaheadUpdates?: number | undefined;
        removeQuoteAmountWad: bigint;
        drawDebtAmountWad: bigint;
        limitIndex: number;
        collateralAmountWad: bigint;
      }
    | undefined;
  dualEvaluations: {
    total: number;
    improving: number;
    failed: number;
    byCombination: Array<{
      key: string;
      total: number;
      improving: number;
      failed: number;
      bestTerminalDistance: number | null;
      bestTerminalRateBps: number | null;
    }>;
  };
}

export interface DualViableFixtureInput {
  account: { address: `0x${string}` };
  publicClient: any;
  walletClient: any;
  testClient: any;
  artifact: MockArtifact;
  // Ownership of the target bucket the operator controls after base-lender
  // + operator deposits. 0.95 is the single-action-comfortable default;
  // lower values let us test whether dual surfaces in regimes where
  // single-action alone doesn't saturate STEP_UP.
  operatorBucketOwnershipFraction?: number;
}

export async function probeSyntheticDualViablePool(
  input: DualViableFixtureInput
): Promise<DualViableProbeResult> {
  const { account, publicClient, walletClient, testClient, artifact } = input;
  process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

  // Deploy fresh mock tokens and a fresh pool — self-contained fixture.
  const quoteToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Dual Viable Quote",
    "DVQ"
  );
  const collateralToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Dual Viable Collateral",
    "DVC"
  );

  // All amounts below are in whole units; scale to 18-decimal WAD for the
  // pool. Ajna pools use WAD for quote amounts regardless of underlying
  // decimals; mock tokens use 18 decimals so the WAD view matches.
  const defaultAccountBaseLenderDepositWad = 10_000n * 10n ** 18n;
  const defaultAccountDebtWad = 3_000n * 10n ** 18n;
  const defaultAccountCollateralWad = 6_000n * 10n ** 18n;

  // Operator's deposit sized to hit the requested ownership fraction.
  // Solve: operatorDeposit / (operatorDeposit + baseLenderDeposit) = f
  // → operatorDeposit = baseLenderDeposit * f / (1 - f)
  const requestedFraction = input.operatorBucketOwnershipFraction ?? 0.95;
  const fractionBps = Math.round(requestedFraction * 10_000);
  if (fractionBps <= 0 || fractionBps >= 10_000) {
    throw new Error(
      `operatorBucketOwnershipFraction must be in (0, 1); got ${requestedFraction}`
    );
  }
  const operatorBucketDepositWad =
    (defaultAccountBaseLenderDepositWad * BigInt(fractionBps)) /
    BigInt(10_000 - fractionBps);
  const operatorExistingDebtWad = 5_000n * 10n ** 18n;
  // Generous collateral headroom: operator deposits ~20× what their
  // existing debt requires at a 1:2 collateral-to-debt protocol-implied
  // ratio. This leaves huge room for the keeper's drawDebt search to land
  // on meaningful additional debt without reverting.
  const operatorCollateralWad = 100_000n * 10n ** 18n;

  const targetBucketIndex = 3000;
  const emaWarmupCycles = 3;
  const targetOffsetBps = 200;
  const toleranceBps = 50;

  // Mint abundant balances to the default account, then transfer tokens to
  // the operator after impersonation (the mock token's mint is callable by
  // any account but we keep all minting through the default-account path
  // for consistency with existing test helpers).
  await mintToken(
    walletClient,
    publicClient,
    artifact,
    quoteToken,
    account.address,
    defaultAccountBaseLenderDepositWad * 100n
  );
  await mintToken(
    walletClient,
    publicClient,
    artifact,
    collateralToken,
    account.address,
    defaultAccountCollateralWad * 100n
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

  // 1. Default account — base lender at target bucket (the "other lender"
  //    share that we'll dilute to 5% by the operator's later deposit).
  const lenderBlock = await publicClient.getBlock();
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "addQuoteToken",
      args: [
        defaultAccountBaseLenderDepositWad,
        BigInt(targetBucketIndex),
        lenderBlock.timestamp + 3600n
      ]
    })
  });

  // 2. Default account — borrower #1 (just to get noOfLoans ≥ 2 after the
  //    operator also borrows).
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "drawDebt",
      args: [
        account.address,
        defaultAccountDebtWad,
        BigInt(targetBucketIndex),
        defaultAccountCollateralWad
      ]
    })
  });

  // 3. Operator — set up as lender + borrower on the same account. Mint
  //    tokens, impersonate, approve, deposit quote, deposit collateral, and
  //    draw modest debt so the operator has a live loan with lots of
  //    collateral left unused.
  await testClient.impersonateAccount({ address: OPERATOR_ADDRESS });
  await testClient.setBalance({
    address: OPERATOR_ADDRESS,
    value: 10n ** 22n
  });
  await mintToken(
    walletClient,
    publicClient,
    artifact,
    quoteToken,
    OPERATOR_ADDRESS,
    operatorBucketDepositWad
  );
  await mintToken(
    walletClient,
    publicClient,
    artifact,
    collateralToken,
    OPERATOR_ADDRESS,
    operatorCollateralWad
  );
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account: OPERATOR_ADDRESS,
      chain: undefined,
      address: quoteToken,
      abi: artifact.abi,
      functionName: "approve",
      args: [poolAddress, 2n ** 255n]
    })
  });
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account: OPERATOR_ADDRESS,
      chain: undefined,
      address: collateralToken,
      abi: artifact.abi,
      functionName: "approve",
      args: [poolAddress, 2n ** 255n]
    })
  });
  const operatorBlock = await publicClient.getBlock();
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account: OPERATOR_ADDRESS,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "addQuoteToken",
      args: [
        operatorBucketDepositWad,
        BigInt(targetBucketIndex),
        operatorBlock.timestamp + 3600n
      ]
    })
  });
  // Operator draws modest existing debt while posting ALL of their
  // collateral up front. This leaves most of the collateral unused —
  // precisely the headroom the dual synthesis needs to safely search over
  // larger drawDebt amounts without reverting.
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account: OPERATOR_ADDRESS,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "drawDebt",
      args: [
        OPERATOR_ADDRESS,
        operatorExistingDebtWad,
        BigInt(targetBucketIndex),
        operatorCollateralWad
      ]
    })
  });
  await testClient.stopImpersonatingAccount({ address: OPERATOR_ADDRESS });

  // 4. EMA warmup — the managed-diagnostics gate requires nonzero EMAs +
  //    noOfLoans > 1. Both hold now; warmup lets the rate drift to a
  //    meaningful baseline.
  await advanceAndApplyEligibleUpdatesDirect(
    account,
    publicClient,
    walletClient,
    testClient,
    poolAddress,
    emaWarmupCycles
  );

  // Re-impersonate operator for the snapshot source's simulation path (it
  // calls lenderInfo / borrowerInfo under this address; the impersonation
  // set-up isn't needed for reads, but the config gates on the sender
  // being a resolvable live account).
  await testClient.impersonateAccount({ address: OPERATOR_ADDRESS });
  await testClient.setBalance({
    address: OPERATOR_ADDRESS,
    value: 10n ** 22n
  });

  const [currentRateWad] = (await publicClient.readContract({
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "interestRateInfo"
  })) as readonly [bigint, bigint];
  const currentRateBps = Number(
    (currentRateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n
  );
  const targetRateBps = currentRateBps + targetOffsetBps;

  const chainNow = Number((await publicClient.getBlock()).timestamp);

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
    drawDebtLimitIndexes: [targetBucketIndex, targetBucketIndex - 500, targetBucketIndex + 500],
    borrowSimulationLookaheadUpdates: 2,
    maxQuoteTokenExposure: "1000000000000000000000000",
    maxBorrowExposure: "1000000000000000000000000",
    snapshotAgeMaxSeconds: 3600,
    minTimeBeforeRateWindowSeconds: 120,
    minExecutableActionQuoteToken: "1",
    recheckBeforeSubmit: true,
    enableSimulationBackedLendSynthesis: true,
    enableSimulationBackedBorrowSynthesis: true,
    enableManagedInventoryUpwardControl: true,
    enableManagedDualUpwardControl: true,
    enableHeuristicLendSynthesis: false,
    enableHeuristicBorrowSynthesis: false
  });

  // Capture every dual-synthesis evaluation so we can see what tuples the
  // exact search tried and which produced `improvesConvergence: true`.
  const dualEvents: DualSynthesisEvaluationEvent[] = [];
  setDualSynthesisDebugTrace((event) => {
    dualEvents.push(event);
  });

  let snapshot;
  try {
    snapshot = await new AjnaRpcSnapshotSource(config, {
      publicClient,
      now: () => chainNow
    }).getSnapshot();
  } finally {
    setDualSynthesisDebugTrace(undefined);
    await testClient.stopImpersonatingAccount({ address: OPERATOR_ADDRESS });
  }

  const metadata = readPoolSnapshotMetadata(snapshot);

  const removeDrawEvents = dualEvents.filter(
    (e) => e.path === "remove_quote_plus_draw_debt"
  );
  const improvingEvents = removeDrawEvents.filter(
    (e) => e.improvesConvergence
  );
  const failedEvents = removeDrawEvents.filter((e) => e.evaluationFailed);

  const byCombinationMap = new Map<
    string,
    DualSynthesisEvaluationEvent[]
  >();
  for (const event of removeDrawEvents) {
    const key = `bucket=${event.bucketIndex}/limit=${event.limitIndex}/collateral=${event.collateralAmount.toString()}`;
    const bucket = byCombinationMap.get(key) ?? [];
    bucket.push(event);
    byCombinationMap.set(key, bucket);
  }
  const byCombination = Array.from(byCombinationMap.entries()).map(
    ([key, events]) => {
      const bestEvaluated = events
        .filter((e) => !e.evaluationFailed)
        .reduce<
          DualSynthesisEvaluationEvent | undefined
        >((best, e) => {
          if (
            best === undefined ||
            e.candidateTerminalDistance < best.candidateTerminalDistance
          ) {
            return e;
          }
          return best;
        }, undefined);
      return {
        key,
        total: events.length,
        improving: events.filter((e) => e.improvesConvergence).length,
        failed: events.filter((e) => e.evaluationFailed).length,
        bestTerminalDistance:
          bestEvaluated?.candidateTerminalDistance ?? null,
        bestTerminalRateBps: bestEvaluated?.candidateTerminalRateBps ?? null
      };
    }
  );

  // Find the dual candidate in the snapshot — intent=LEND_AND_BORROW with
  // both a REMOVE_QUOTE and a DRAW_DEBT step.
  const dualCandidate = snapshot.candidates.find(
    (c) =>
      c.candidateSource === "simulation" &&
      c.intent === "LEND_AND_BORROW" &&
      c.minimumExecutionSteps.some((s) => s.type === "REMOVE_QUOTE") &&
      c.minimumExecutionSteps.some((s) => s.type === "DRAW_DEBT")
  );

  // Find any single-action REMOVE_QUOTE candidate (intent=LEND).
  const singleActionCandidate = snapshot.candidates.find(
    (c) =>
      c.candidateSource === "simulation" &&
      c.intent === "LEND" &&
      c.minimumExecutionSteps.some((s) => s.type === "REMOVE_QUOTE")
  );
  const singleActionCandidateSummary = singleActionCandidate
    ? {
        id: singleActionCandidate.id,
        intent: singleActionCandidate.intent,
        predictedRateBpsAfterNextUpdate:
          singleActionCandidate.predictedRateBpsAfterNextUpdate,
        ...(singleActionCandidate.planningRateBps === undefined
          ? {}
          : { planningRateBps: singleActionCandidate.planningRateBps }),
        resultingDistanceToTargetBps:
          singleActionCandidate.resultingDistanceToTargetBps
      }
    : undefined;

  const allCandidateSummaries = snapshot.candidates.map((c) => ({
    intent: c.intent,
    steps: c.minimumExecutionSteps.map((s) => s.type),
    predictedRateBpsAfterNextUpdate: c.predictedRateBpsAfterNextUpdate,
    resultingDistanceToTargetBps: c.resultingDistanceToTargetBps
  }));

  const dualCandidateSummary = (() => {
    if (dualCandidate === undefined) {
      return undefined;
    }
    const removeStep = dualCandidate.minimumExecutionSteps.find(
      (s): s is Extract<typeof s, { type: "REMOVE_QUOTE" }> =>
        s.type === "REMOVE_QUOTE"
    );
    const drawStep = dualCandidate.minimumExecutionSteps.find(
      (s): s is Extract<typeof s, { type: "DRAW_DEBT" }> =>
        s.type === "DRAW_DEBT"
    );
    if (removeStep === undefined || drawStep === undefined) {
      return undefined;
    }
    return {
      id: dualCandidate.id,
      predictedRateBpsAfterNextUpdate:
        dualCandidate.predictedRateBpsAfterNextUpdate,
      planningRateBps: dualCandidate.planningRateBps,
      planningLookaheadUpdates: dualCandidate.planningLookaheadUpdates,
      removeQuoteAmountWad: removeStep.amount,
      drawDebtAmountWad: drawStep.amount,
      limitIndex: drawStep.limitIndex,
      collateralAmountWad: drawStep.collateralAmount ?? 0n
    };
  })();

  // Bucket ownership fraction: operator deposit / (operator + default
  // account deposit). Uses the raw deposits because each deposit maps 1:1
  // to initial LP (no interest accrued at bucket level yet).
  const totalBucketDeposit =
    operatorBucketDepositWad + defaultAccountBaseLenderDepositWad;
  const operatorBucketOwnershipFraction =
    Number((operatorBucketDepositWad * 10_000n) / totalBucketDeposit) /
    10_000;
  const collateralHeadroomRatio =
    operatorExistingDebtWad === 0n
      ? Number.POSITIVE_INFINITY
      : Number(
          (operatorCollateralWad * 100n) / operatorExistingDebtWad
        ) / 100;

  return {
    poolAddress,
    targetBucketIndex,
    operatorBucketOwnershipFraction,
    operatorCollateralWad,
    operatorExistingDebtWad,
    collateralHeadroomRatio,
    currentRateBps,
    targetRateBps,
    predictedNextRateBps: snapshot.predictedNextRateBps,
    managedInventoryUpwardEligible: metadata.managedInventoryUpwardEligible,
    managedInventoryIneligibilityReason:
      metadata.managedInventoryIneligibilityReason,
    noOfLoans: Number(metadata.noOfLoans ?? "0"),
    singleActionCandidateSurfaced: singleActionCandidate !== undefined,
    singleActionCandidateSummary,
    allCandidateSummaries,
    dualCandidateSurfaced: dualCandidate !== undefined,
    dualCandidate: dualCandidateSummary,
    dualEvaluations: {
      total: removeDrawEvents.length,
      improving: improvingEvents.length,
      failed: failedEvents.length,
      byCombination
    }
  };
}

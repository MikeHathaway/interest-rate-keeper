import { distanceToTargetBand } from "./planner.js";
import {
  type CyclePlan,
  type ExecutionStep,
  type GuardFailure,
  type KeeperConfig,
  type PoolSnapshot
} from "./types.js";

const SEMANTIC_SNAPSHOT_METADATA_KEYS = [
  "poolAddress",
  "currentRateWad",
  "currentDebtWad",
  "debtEmaWad",
  "depositEmaWad",
  "debtColEmaWad",
  "lupt0DebtEmaWad",
  "lastInterestRateUpdateTimestamp"
] as const;

function stepAmount(step: ExecutionStep): bigint {
  switch (step.type) {
    case "ADD_QUOTE":
    case "REMOVE_QUOTE":
    case "DRAW_DEBT":
    case "REPAY_DEBT":
    case "ADD_COLLATERAL":
    case "REMOVE_COLLATERAL":
      return step.amount;
    case "UPDATE_INTEREST":
      return 0n;
  }
}

function minimumExecutableAmountForStep(step: ExecutionStep, config: KeeperConfig): bigint {
  switch (step.type) {
    case "ADD_QUOTE":
    case "REMOVE_QUOTE":
    case "REPAY_DEBT":
      return config.minExecutableQuoteTokenAmount;
    case "DRAW_DEBT":
      return config.minExecutableBorrowAmount;
    case "ADD_COLLATERAL":
    case "REMOVE_COLLATERAL":
      return config.minExecutableCollateralAmount;
    case "UPDATE_INTEREST":
      return 0n;
  }
}

function quoteExposureForStep(step: ExecutionStep): bigint {
  switch (step.type) {
    case "ADD_QUOTE":
      return step.amount;
    default:
      return 0n;
  }
}

function borrowExposureForStep(step: ExecutionStep): bigint {
  switch (step.type) {
    case "DRAW_DEBT":
      return step.amount;
    default:
      return 0n;
  }
}

function semanticSnapshotMetadataSignature(snapshot: PoolSnapshot): string | undefined {
  const metadata = snapshot.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const key of SEMANTIC_SNAPSHOT_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value !== "string" && typeof value !== "number") {
      return undefined;
    }
    parts.push(String(value));
  }

  return parts.join(":");
}

function findCandidate(snapshot: PoolSnapshot, candidateId: string) {
  return snapshot.candidates.find((candidate) => candidate.id === candidateId);
}

function coarseSnapshotSignature(snapshot: PoolSnapshot): string {
  return [
    snapshot.poolId,
    String(snapshot.chainId),
    String(snapshot.currentRateBps),
    snapshot.predictedNextOutcome,
    String(snapshot.predictedNextRateBps),
    snapshot.planningRateBps === undefined ? "-" : String(snapshot.planningRateBps),
    snapshot.planningLookaheadUpdates === undefined
      ? "-"
      : String(snapshot.planningLookaheadUpdates)
  ].join(":");
}

function projectedRateBps(snapshot: PoolSnapshot): number {
  return snapshot.planningRateBps ?? snapshot.predictedNextRateBps;
}

function currentAndProjectedRatesAreInBand(
  snapshot: PoolSnapshot,
  plan: CyclePlan
): boolean {
  return (
    distanceToTargetBand(snapshot.currentRateBps, plan.targetBand) === 0 &&
    distanceToTargetBand(projectedRateBps(snapshot), plan.targetBand) === 0
  );
}

function sameSemanticPoolState(previousSnapshot: PoolSnapshot, freshSnapshot: PoolSnapshot): boolean {
  if (freshSnapshot.snapshotFingerprint === previousSnapshot.snapshotFingerprint) {
    return true;
  }

  const previousMetadataSignature = semanticSnapshotMetadataSignature(previousSnapshot);
  const freshMetadataSignature = semanticSnapshotMetadataSignature(freshSnapshot);
  if (previousMetadataSignature && freshMetadataSignature) {
    return previousMetadataSignature === freshMetadataSignature;
  }

  return coarseSnapshotSignature(previousSnapshot) === coarseSnapshotSignature(freshSnapshot);
}

function snapshotGuards(
  plan: CyclePlan,
  snapshot: PoolSnapshot,
  config: KeeperConfig
): GuardFailure | undefined {
  if (snapshot.snapshotAgeSeconds > config.snapshotAgeMaxSeconds) {
    return {
      code: "STALE_SNAPSHOT",
      reason: "snapshot is older than the configured freshness window"
    };
  }

  const executesUpdateInterest = plan.requiredSteps.some(
    (step) => step.type === "UPDATE_INTEREST"
  );
  const hasMutatingStep = plan.requiredSteps.some((step) => step.type !== "UPDATE_INTEREST");
  const dueWindowIsAlreadyOpen = snapshot.secondsUntilNextRateUpdate <= 0;

  if (
    snapshot.secondsUntilNextRateUpdate < config.minTimeBeforeRateWindowSeconds &&
    !executesUpdateInterest &&
    !(dueWindowIsAlreadyOpen && hasMutatingStep)
  ) {
    return {
      code: "UNSAFE_TIME_WINDOW",
      reason: "execution is too close to the next rate update boundary"
    };
  }

  return undefined;
}

export function validatePlan(
  plan: CyclePlan,
  snapshot: PoolSnapshot,
  config: KeeperConfig
): GuardFailure | undefined {
  const snapshotFailure = snapshotGuards(plan, snapshot, config);
  if (snapshotFailure) {
    return snapshotFailure;
  }

  let totalQuoteExposure = 0n;
  let totalBorrowExposure = 0n;

  for (const step of plan.requiredSteps) {
    const amount = stepAmount(step);
    const minimumStepAmount = minimumExecutableAmountForStep(step, config);
    if (amount > 0n && amount < minimumStepAmount) {
      return {
        code: "MIN_EXECUTION_AMOUNT",
        reason: `step ${step.type} is below the minimum executable amount`
      };
    }

    if (
      step.type === "DRAW_DEBT" &&
      (step.collateralAmount ?? 0n) > 0n &&
      (step.collateralAmount ?? 0n) < config.minExecutableCollateralAmount
    ) {
      return {
        code: "MIN_EXECUTION_AMOUNT",
        reason: "draw-debt collateral amount is below the minimum executable collateral amount"
      };
    }

    totalQuoteExposure += quoteExposureForStep(step);
    totalBorrowExposure += borrowExposureForStep(step);
  }

  if (totalQuoteExposure > config.maxQuoteTokenExposure) {
    return {
      code: "QUOTE_CAP_EXCEEDED",
      reason: "plan exceeds the configured quote token exposure cap"
    };
  }

  if (totalBorrowExposure > config.maxBorrowExposure) {
    return {
      code: "BORROW_CAP_EXCEEDED",
      reason: "plan exceeds the configured borrow exposure cap"
    };
  }

  return undefined;
}

export function preSubmitRecheck(
  plan: CyclePlan,
  previousSnapshot: PoolSnapshot,
  freshSnapshot: PoolSnapshot,
  config: KeeperConfig
): GuardFailure | undefined {
  const snapshotFailure = snapshotGuards(plan, freshSnapshot, config);
  if (snapshotFailure) {
    return snapshotFailure;
  }

  if (!sameSemanticPoolState(previousSnapshot, freshSnapshot)) {
    return {
      code: "POOL_STATE_CHANGED",
      reason: "pool state changed between planning and execution"
    };
  }

  if (
    plan.selectedCandidateId
  ) {
    const previousCandidate = findCandidate(previousSnapshot, plan.selectedCandidateId);
    const freshCandidate = findCandidate(freshSnapshot, plan.selectedCandidateId);

    if (!freshCandidate) {
      return {
        code: "CANDIDATE_INVALIDATED",
        reason: "selected candidate is no longer valid in the fresh snapshot"
      };
    }

    if (
      previousCandidate?.validationSignature !== undefined ||
      freshCandidate.validationSignature !== undefined
    ) {
      if (previousCandidate?.validationSignature !== freshCandidate.validationSignature) {
        return {
          code: "CANDIDATE_INVALIDATED",
          reason: "selected candidate context changed between planning and execution"
        };
      }
    }
  }

  if (plan.intent !== "NO_OP" && currentAndProjectedRatesAreInBand(freshSnapshot, plan)) {
    return {
      code: "POOL_STATE_CHANGED",
      reason: "pool is already safely inside the target band before execution"
    };
  }

  return undefined;
}

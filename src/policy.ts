import { distanceToTargetBand } from "./planner.js";
import {
  type CyclePlan,
  type ExecutionStep,
  type GuardFailure,
  type KeeperConfig,
  type PoolSnapshot
} from "./types.js";

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

  if (
    snapshot.secondsUntilNextRateUpdate < config.minTimeBeforeRateWindowSeconds &&
    !executesUpdateInterest
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
    if (amount > 0n && amount < config.minExecutableActionQuoteToken) {
      return {
        code: "MIN_EXECUTION_AMOUNT",
        reason: `step ${step.type} is below the minimum executable amount`
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

  if (freshSnapshot.snapshotFingerprint !== previousSnapshot.snapshotFingerprint) {
    return {
      code: "POOL_STATE_CHANGED",
      reason: "pool state changed between planning and execution"
    };
  }

  if (
    plan.selectedCandidateId &&
    !freshSnapshot.candidates.some(
      (candidate) => candidate.id === plan.selectedCandidateId
    )
  ) {
    return {
      code: "CANDIDATE_INVALIDATED",
      reason: "selected candidate is no longer valid in the fresh snapshot"
    };
  }

  if (
    distanceToTargetBand(freshSnapshot.currentRateBps, plan.targetBand) === 0 &&
    plan.intent !== "NO_OP"
  ) {
    return {
      code: "POOL_STATE_CHANGED",
      reason: "pool moved into the target band before execution"
    };
  }

  return undefined;
}

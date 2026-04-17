import { distanceToTargetBand, withExecutionBuffer } from "./planner.js";
import {
  managedDistanceImprovementBps,
  maximumManagedReleasedQuoteAmount,
  normalizedManagedSensitivityBpsPer10PctRelease,
  releasedQuoteInventoryAmount,
  stepsUseManagedDual,
  stepsUseManagedRemoveQuote
} from "./managed-controls.js";
import {
  readManagedControlSnapshotMetadata,
  semanticSnapshotMetadataSignature
} from "./snapshot-metadata.js";
import {
  type CyclePlan,
  type ExecutionStep,
  type GuardFailure,
  type KeeperConfig,
  type PoolSnapshot
} from "./types.js";
import { BPS_DENOMINATOR } from "./units.js";

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

function findCandidate(snapshot: PoolSnapshot, candidateId: string) {
  return snapshot.candidates.find((candidate) => candidate.id === candidateId);
}

function normalizeStepForComparison(step: ExecutionStep): string {
  switch (step.type) {
    case "ADD_QUOTE":
      return `ADD_QUOTE:${step.amount.toString()}:${step.bucketIndex}:${step.expiry}`;
    case "REMOVE_QUOTE":
      return `REMOVE_QUOTE:${step.amount.toString()}:${step.bucketIndex}`;
    case "DRAW_DEBT":
      return `DRAW_DEBT:${step.amount.toString()}:${step.limitIndex}:${(step.collateralAmount ?? 0n).toString()}`;
    case "REPAY_DEBT":
      return `REPAY_DEBT:${step.amount.toString()}:${(step.collateralAmountToPull ?? 0n).toString()}:${step.limitIndex ?? "-"}:${step.recipient ?? "-"}`;
    case "ADD_COLLATERAL":
      return `ADD_COLLATERAL:${step.amount.toString()}:${step.bucketIndex}:${step.expiry ?? "-"}`;
    case "REMOVE_COLLATERAL":
      return `REMOVE_COLLATERAL:${step.amount.toString()}:${step.bucketIndex ?? "-"}`;
    case "UPDATE_INTEREST":
      return `UPDATE_INTEREST`;
  }
}

function planStepsMatchCandidate(
  plan: CyclePlan,
  freshCandidate: { minimumExecutionSteps: readonly ExecutionStep[] },
  config: KeeperConfig
): boolean {
  const planMutating = plan.requiredSteps.filter(
    (step) => step.type !== "UPDATE_INTEREST"
  );
  const candidateMutating = freshCandidate.minimumExecutionSteps
    .filter((step) => step.type !== "UPDATE_INTEREST")
    .map((step) => withExecutionBuffer(step, config));

  if (planMutating.length !== candidateMutating.length) {
    return false;
  }

  for (let index = 0; index < planMutating.length; index += 1) {
    const planStep = planMutating[index];
    const candidateStep = candidateMutating[index];
    if (planStep === undefined || candidateStep === undefined) {
      return false;
    }
    if (planStep.type !== candidateStep.type) {
      return false;
    }
    if (
      normalizeStepForComparison(planStep) !==
      normalizeStepForComparison(candidateStep)
    ) {
      return false;
    }
  }

  return true;
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

function managedPlanImprovementBps(plan: CyclePlan, snapshot: PoolSnapshot): number {
  return managedDistanceImprovementBps(
    {
      snapshotPlanningRateBps: snapshot.planningRateBps,
      snapshotPredictedNextRateBps: snapshot.predictedNextRateBps,
      afterPlanningRateBps: plan.planningRateBps,
      afterPredictedRateBpsAfterNextUpdate: plan.predictedRateBpsAfterNextUpdate
    },
    (rateBps) => distanceToTargetBand(rateBps, plan.targetBand)
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

function managedInventoryGuards(
  plan: CyclePlan,
  snapshot: PoolSnapshot,
  config: KeeperConfig
): GuardFailure | undefined {
  if (!stepsUseManagedRemoveQuote(plan.requiredSteps)) {
    return undefined;
  }

  const managedMetadata = readManagedControlSnapshotMetadata(snapshot);
  if (managedMetadata.managedInventoryUpwardEligible !== true) {
    const ineligibilityReason = managedMetadata.managedInventoryIneligibilityReason;
    return {
      code: "MANAGED_CONTROL_UNAVAILABLE",
      reason:
        ineligibilityReason === undefined
          ? "managed inventory upward control is no longer eligible in the fresh snapshot"
          : `managed inventory upward control is no longer eligible because ${ineligibilityReason}`
    };
  }

  if (
    stepsUseManagedDual(plan.requiredSteps) &&
    managedMetadata.managedDualUpwardEligible !== true
  ) {
    const ineligibilityReason = managedMetadata.managedDualIneligibilityReason;
    return {
      code: "MANAGED_CONTROL_UNAVAILABLE",
      reason:
        ineligibilityReason === undefined
          ? "managed dual upward control is no longer eligible in the fresh snapshot"
          : `managed dual upward control is no longer eligible because ${ineligibilityReason}`
    };
  }

  const maxManagedInventoryReleaseBps = config.maxManagedInventoryReleaseBps;
  const totalWithdrawableQuoteAmount = managedMetadata.managedTotalWithdrawableQuoteAmount;
  if (totalWithdrawableQuoteAmount === undefined || totalWithdrawableQuoteAmount <= 0n) {
    return {
      code: "MANAGED_CONTROL_UNAVAILABLE",
      reason:
        "managed upward control is configured, but the fresh snapshot no longer exposes withdrawable managed inventory totals"
    };
  }

  const released = releasedQuoteInventoryAmount(plan.requiredSteps);

  if (
    maxManagedInventoryReleaseBps !== undefined &&
    maxManagedInventoryReleaseBps < BPS_DENOMINATOR
  ) {
    const maximumReleased = maximumManagedReleasedQuoteAmount(
      totalWithdrawableQuoteAmount,
      maxManagedInventoryReleaseBps
    );
    if (released > maximumReleased) {
      return {
        code: "MANAGED_RELEASE_CAP_EXCEEDED",
        reason: `plan exceeds the configured managed inventory release cap of ${maxManagedInventoryReleaseBps} bps`
      };
    }
  }

  const minimumManagedSensitivityBpsPer10PctRelease =
    config.minimumManagedSensitivityBpsPer10PctRelease ?? 0;
  if (minimumManagedSensitivityBpsPer10PctRelease <= 0) {
    return undefined;
  }

  const improvementBps = managedPlanImprovementBps(plan, snapshot);
  if (improvementBps <= 0) {
    return {
      code: "MANAGED_CONTROLLABILITY_TOO_LOW",
      reason:
        "managed inventory plan no longer improves the passive path in the fresh snapshot"
    };
  }

  const normalizedSensitivityBpsPer10PctRelease =
    normalizedManagedSensitivityBpsPer10PctRelease(
      improvementBps,
      released,
      totalWithdrawableQuoteAmount
    );
  if (normalizedSensitivityBpsPer10PctRelease === undefined) {
    return {
      code: "MANAGED_CONTROLLABILITY_TOO_LOW",
      reason:
        "managed controllability gate is configured, but the fresh snapshot produced a zero effective release fraction"
    };
  }
  if (
    normalizedSensitivityBpsPer10PctRelease <
    BigInt(minimumManagedSensitivityBpsPer10PctRelease)
  ) {
    return {
      code: "MANAGED_CONTROLLABILITY_TOO_LOW",
      reason: `plan failed the configured controllability gate of ${minimumManagedSensitivityBpsPer10PctRelease} bps per 10% inventory release`
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

  const managedFailure = managedInventoryGuards(plan, snapshot, config);
  if (managedFailure) {
    return managedFailure;
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

  const managedFailure = managedInventoryGuards(plan, freshSnapshot, config);
  if (managedFailure) {
    return managedFailure;
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

    if (!planStepsMatchCandidate(plan, freshCandidate, config)) {
      return {
        code: "CANDIDATE_INVALIDATED",
        reason: "plan steps no longer match the fresh candidate's minimum execution steps"
      };
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

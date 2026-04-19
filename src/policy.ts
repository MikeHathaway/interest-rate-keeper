import {
  currentAndProjectedRatesAreInBand,
  withExecutionBuffer
} from "./planner.js";
import {
  releasedQuoteInventoryAmount
} from "./managed-controls.js";
import {
  evaluateManagedPlan,
  type ManagedCheckFailure,
  type ManagedCheckName,
  type ManagedPlanEvaluationInputs
} from "./managed-plan-evaluation.js";
import {
  semanticSnapshotMetadataSignature
} from "./snapshot-metadata.js";
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

function stepExpiry(step: ExecutionStep): number | undefined {
  switch (step.type) {
    case "ADD_QUOTE":
      return step.expiry;
    case "ADD_COLLATERAL":
      return step.expiry;
    default:
      return undefined;
  }
}

function expiredStepFailure(
  plan: CyclePlan,
  snapshot: PoolSnapshot
): GuardFailure | undefined {
  for (const step of plan.requiredSteps) {
    const expiry = stepExpiry(step);
    if (expiry !== undefined && expiry <= snapshot.blockTimestamp) {
      return {
        code: "EXPIRED_STEP",
        reason: `${step.type} step expiry ${expiry} is at or before the fresh block timestamp ${snapshot.blockTimestamp}`
      };
    }
  }

  return undefined;
}

// expiry fields are deliberately omitted: auto-synthesized candidates regenerate
// expiry from `now` at every read, so including it in the comparison would
// reject legitimate plans whenever recheck fires a few seconds after planning.
// Expiry is a freshness hint, not a semantic identifier; tampering it cannot
// change what tokens are moved or where.
export function normalizeStepForComparison(step: ExecutionStep): string {
  switch (step.type) {
    case "ADD_QUOTE":
      return `ADD_QUOTE:${step.amount.toString()}:${step.bucketIndex}`;
    case "REMOVE_QUOTE":
      return `REMOVE_QUOTE:${step.amount.toString()}:${step.bucketIndex}`;
    case "DRAW_DEBT":
      return `DRAW_DEBT:${step.amount.toString()}:${step.limitIndex}:${(step.collateralAmount ?? 0n).toString()}`;
    case "REPAY_DEBT":
      return `REPAY_DEBT:${step.amount.toString()}:${(step.collateralAmountToPull ?? 0n).toString()}:${step.limitIndex ?? "-"}:${step.recipient ?? "-"}`;
    case "ADD_COLLATERAL":
      return `ADD_COLLATERAL:${step.amount.toString()}:${step.bucketIndex}`;
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

function buildPlanEvaluationInputs(
  plan: CyclePlan,
  snapshot: PoolSnapshot,
  config: KeeperConfig
): ManagedPlanEvaluationInputs {
  return {
    steps: plan.requiredSteps,
    snapshotPlanningRateBps: snapshot.planningRateBps,
    snapshotPredictedNextRateBps: snapshot.predictedNextRateBps,
    afterPlanningRateBps: plan.planningRateBps,
    afterPredictedRateBpsAfterNextUpdate: plan.predictedRateBpsAfterNextUpdate,
    targetBand: plan.targetBand,
    snapshot,
    releasedQuoteAmount: releasedQuoteInventoryAmount(plan.requiredSteps),
    config
  };
}

// Maps the centralized ManagedCheckFailure shape into this module's GuardFailure
// codes and the exact reason strings asserted by policy.test.ts. Any new failure
// kind added to managed-plan-evaluation must be mapped here.
function toGuardFailure(failure: ManagedCheckFailure): GuardFailure {
  switch (failure.check) {
    case "eligibility": {
      const prefix =
        failure.kind === "dual_ineligible"
          ? "managed dual upward control is no longer eligible"
          : "managed inventory upward control is no longer eligible";
      return {
        code: "MANAGED_CONTROL_UNAVAILABLE",
        reason:
          failure.ineligibilityReason === undefined
            ? `${prefix} in the fresh snapshot`
            : `${prefix} because ${failure.ineligibilityReason}`
      };
    }
    case "availability":
      return {
        code: "MANAGED_CONTROL_UNAVAILABLE",
        reason:
          "managed upward control is configured, but the fresh snapshot no longer exposes withdrawable managed inventory totals"
      };
    case "release_cap":
      // missing_withdrawable_totals is caught by the "availability" check that
      // policy always runs first, so in practice only exceeds_release_cap
      // reaches here in the policy flow.
      if (failure.kind === "missing_withdrawable_totals") {
        return {
          code: "MANAGED_CONTROL_UNAVAILABLE",
          reason:
            "managed upward control is configured, but the fresh snapshot no longer exposes withdrawable managed inventory totals"
        };
      }
      return {
        code: "MANAGED_RELEASE_CAP_EXCEEDED",
        reason: `plan exceeds the configured managed inventory release cap of ${failure.maxManagedInventoryReleaseBps} bps`
      };
    case "improvement_floor":
      if (failure.kind === "no_improvement") {
        return {
          code: "MANAGED_CONTROLLABILITY_TOO_LOW",
          reason:
            "managed inventory plan no longer improves the passive path in the fresh snapshot"
        };
      }
      return {
        code: "MANAGED_CONTROLLABILITY_TOO_LOW",
        reason: `managed inventory plan improvement of ${failure.improvementBps} bps is below the configured floor of ${failure.minimumImprovementBps} bps`
      };
    case "sensitivity_threshold":
      if (failure.kind === "missing_withdrawable_totals") {
        return {
          code: "MANAGED_CONTROL_UNAVAILABLE",
          reason:
            "managed upward control is configured, but the fresh snapshot no longer exposes withdrawable managed inventory totals"
        };
      }
      if (failure.kind === "zero_release_fraction") {
        return {
          code: "MANAGED_CONTROLLABILITY_TOO_LOW",
          reason:
            "managed controllability gate is configured, but the fresh snapshot produced a zero effective release fraction"
        };
      }
      return {
        code: "MANAGED_CONTROLLABILITY_TOO_LOW",
        reason: `plan failed the configured controllability gate of ${failure.minimumManagedSensitivityBpsPer10PctRelease} bps per 10% inventory release`
      };
  }
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

// Eligibility + availability + release-cap subset of managedInventoryGuards.
// Safe to apply to a partial prefix of a dual plan (e.g. just the REMOVE_QUOTE
// half) because these are standalone safety invariants: the managed mode must
// be eligible, the snapshot must expose withdrawable totals, and the released
// amount must fit the configured cap regardless of what DRAW_DEBT contributes
// afterward. Deliberately omits the improvement and sensitivity gates because
// those thresholds are calibrated for the full dual plan; applying them to the
// prefix would reject legitimate dual plans where DRAW_DEBT provides most of
// the improvement.
const PREFIX_SAFETY_CHECKS: readonly ManagedCheckName[] = [
  "eligibility",
  "availability",
  "release_cap"
];

// Full set of managed checks: the prefix-safety subset plus the improvement
// floor and the per-10%-release sensitivity gate. H1 / review 3: the
// improvement floor must revalidate regardless of whether the sensitivity gate
// is configured, because pool state can shift between planning and submission
// and degrade a plan below config.minimumManagedImprovementBps.
const FULL_MANAGED_CHECKS: readonly ManagedCheckName[] = [
  ...PREFIX_SAFETY_CHECKS,
  "improvement_floor",
  "sensitivity_threshold"
];

export function managedPrefixSafetyGuards(
  plan: CyclePlan,
  snapshot: PoolSnapshot,
  config: KeeperConfig
): GuardFailure | undefined {
  const failure = evaluateManagedPlan(
    buildPlanEvaluationInputs(plan, snapshot, config),
    PREFIX_SAFETY_CHECKS
  );
  return failure ? toGuardFailure(failure) : undefined;
}

function managedInventoryGuards(
  plan: CyclePlan,
  snapshot: PoolSnapshot,
  config: KeeperConfig
): GuardFailure | undefined {
  const failure = evaluateManagedPlan(
    buildPlanEvaluationInputs(plan, snapshot, config),
    FULL_MANAGED_CHECKS
  );
  return failure ? toGuardFailure(failure) : undefined;
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

  const expiredFailure = expiredStepFailure(plan, snapshot);
  if (expiredFailure) {
    return expiredFailure;
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

  const expiredFailure = expiredStepFailure(plan, freshSnapshot);
  if (expiredFailure) {
    return expiredFailure;
  }

  if (
    plan.intent !== "NO_OP" &&
    currentAndProjectedRatesAreInBand(freshSnapshot, plan.targetBand)
  ) {
    return {
      code: "POOL_STATE_CHANGED",
      reason: "pool is already safely inside the target band before execution"
    };
  }

  return undefined;
}

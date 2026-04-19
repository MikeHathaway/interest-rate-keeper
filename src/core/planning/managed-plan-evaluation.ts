// Shared evaluator for managed-inventory upward-control plans.
//
// The planner filters candidates through successive managed checks
// (eligibility, release cap, improvement floor, sensitivity gate); the policy
// layer re-runs the same checks against the fresh snapshot at preSubmitRecheck.
// Before this module they were two parallel implementations that drifted apart
// (see review 3 findings C3 + H1). Centralizing the threshold logic here means
// every managed-control invariant has exactly one call site: each side just
// picks which subset to run and formats the failure in its own idiom (boolean
// for planner filters, GuardFailure code+reason for policy recheck).
//
// Check decomposition:
//  - eligibility: managedInventoryUpwardEligible + managedDualUpwardEligible
//  - availability: managedTotalWithdrawableQuoteAmount present + positive
//  - release_cap: configured cap satisfied (short-circuits when no cap set)
//  - improvement_floor: plan actually improves the passive path, and clears
//      config.minimumManagedImprovementBps if set
//  - sensitivity_threshold: plan clears the per-10%-release sensitivity gate
//      when configured (implicitly requires availability).

import {
  managedDistanceImprovementBps,
  maximumManagedReleasedQuoteAmount,
  normalizedManagedSensitivityBpsPer10PctRelease,
  stepsUseManagedDual,
  stepsUseManagedRemoveQuote
} from "./managed-controls.js";
import {
  type ManagedControlSnapshotMetadata,
  readManagedControlSnapshotMetadata
} from "../snapshot/metadata.js";
import type {
  ExecutionStep,
  KeeperConfig,
  PoolSnapshot,
  TargetBand
} from "../types.js";
import { BPS_DENOMINATOR } from "../support/units.js";

export type ManagedCheckName =
  | "eligibility"
  | "availability"
  | "release_cap"
  | "improvement_floor"
  | "sensitivity_threshold";

export interface ManagedPlanEvaluationInputs {
  steps: readonly ExecutionStep[];
  snapshotPlanningRateBps: number | undefined;
  snapshotPredictedNextRateBps: number;
  afterPlanningRateBps: number | undefined;
  afterPredictedRateBpsAfterNextUpdate: number;
  targetBand: TargetBand;
  snapshot: PoolSnapshot;
  releasedQuoteAmount: bigint;
  config: KeeperConfig;
}

export type ManagedCheckKind =
  | "inventory_ineligible"
  | "dual_ineligible"
  | "missing_withdrawable_totals"
  | "exceeds_release_cap"
  | "no_improvement"
  | "below_improvement_floor"
  | "zero_release_fraction"
  | "below_sensitivity_gate";

export interface ManagedCheckFailure {
  check: ManagedCheckName;
  kind: ManagedCheckKind;
  ineligibilityReason?: string | undefined;
  improvementBps?: number;
  minimumImprovementBps?: number;
  maxManagedInventoryReleaseBps?: number;
  minimumManagedSensitivityBpsPer10PctRelease?: number;
}

// Local copy of planner.distanceToTargetBand to avoid a planner ↔ evaluator
// import cycle. Kept tiny and pure so drift is trivial to audit.
function distanceToBand(rateBps: number, band: TargetBand): number {
  if (rateBps < band.minRateBps) {
    return band.minRateBps - rateBps;
  }
  if (rateBps > band.maxRateBps) {
    return rateBps - band.maxRateBps;
  }
  return 0;
}

function computeImprovementBps(inputs: ManagedPlanEvaluationInputs): number {
  return managedDistanceImprovementBps(
    {
      snapshotPlanningRateBps: inputs.snapshotPlanningRateBps,
      snapshotPredictedNextRateBps: inputs.snapshotPredictedNextRateBps,
      afterPlanningRateBps: inputs.afterPlanningRateBps,
      afterPredictedRateBpsAfterNextUpdate:
        inputs.afterPredictedRateBpsAfterNextUpdate
    },
    (rateBps) => distanceToBand(rateBps, inputs.targetBand)
  );
}

function readMetadata(
  inputs: ManagedPlanEvaluationInputs
): ManagedControlSnapshotMetadata {
  return readManagedControlSnapshotMetadata(inputs.snapshot);
}

export function checkManagedEligibility(
  inputs: ManagedPlanEvaluationInputs
): ManagedCheckFailure | undefined {
  if (!stepsUseManagedRemoveQuote(inputs.steps)) {
    return undefined;
  }

  const managedMetadata = readMetadata(inputs);
  if (managedMetadata.managedInventoryUpwardEligible !== true) {
    return {
      check: "eligibility",
      kind: "inventory_ineligible",
      ineligibilityReason: managedMetadata.managedInventoryIneligibilityReason
    };
  }

  if (
    stepsUseManagedDual(inputs.steps) &&
    managedMetadata.managedDualUpwardEligible !== true
  ) {
    return {
      check: "eligibility",
      kind: "dual_ineligible",
      ineligibilityReason: managedMetadata.managedDualIneligibilityReason
    };
  }

  return undefined;
}

export function checkManagedAvailability(
  inputs: ManagedPlanEvaluationInputs
): ManagedCheckFailure | undefined {
  if (!stepsUseManagedRemoveQuote(inputs.steps)) {
    return undefined;
  }

  const managedMetadata = readMetadata(inputs);
  const totalWithdrawableQuoteAmount =
    managedMetadata.managedTotalWithdrawableQuoteAmount;
  if (
    totalWithdrawableQuoteAmount === undefined ||
    totalWithdrawableQuoteAmount <= 0n
  ) {
    return { check: "availability", kind: "missing_withdrawable_totals" };
  }

  return undefined;
}

export function checkManagedReleaseCap(
  inputs: ManagedPlanEvaluationInputs
): ManagedCheckFailure | undefined {
  if (!stepsUseManagedRemoveQuote(inputs.steps)) {
    return undefined;
  }

  const maxManagedInventoryReleaseBps = inputs.config.maxManagedInventoryReleaseBps;
  if (
    maxManagedInventoryReleaseBps === undefined ||
    maxManagedInventoryReleaseBps >= BPS_DENOMINATOR
  ) {
    return undefined;
  }

  const managedMetadata = readMetadata(inputs);
  const totalWithdrawableQuoteAmount =
    managedMetadata.managedTotalWithdrawableQuoteAmount;
  if (
    totalWithdrawableQuoteAmount === undefined ||
    totalWithdrawableQuoteAmount <= 0n
  ) {
    return { check: "release_cap", kind: "missing_withdrawable_totals" };
  }

  const maximumReleased = maximumManagedReleasedQuoteAmount(
    totalWithdrawableQuoteAmount,
    maxManagedInventoryReleaseBps
  );
  if (inputs.releasedQuoteAmount > maximumReleased) {
    return {
      check: "release_cap",
      kind: "exceeds_release_cap",
      maxManagedInventoryReleaseBps
    };
  }

  return undefined;
}

export function checkManagedImprovementFloor(
  inputs: ManagedPlanEvaluationInputs
): ManagedCheckFailure | undefined {
  if (!stepsUseManagedRemoveQuote(inputs.steps)) {
    return undefined;
  }

  const improvementBps = computeImprovementBps(inputs);
  if (improvementBps <= 0) {
    return {
      check: "improvement_floor",
      kind: "no_improvement",
      improvementBps
    };
  }

  const minimumManagedImprovementBps = inputs.config.minimumManagedImprovementBps ?? 0;
  if (
    minimumManagedImprovementBps > 0 &&
    improvementBps < minimumManagedImprovementBps
  ) {
    return {
      check: "improvement_floor",
      kind: "below_improvement_floor",
      improvementBps,
      minimumImprovementBps: minimumManagedImprovementBps
    };
  }

  return undefined;
}

export function checkManagedSensitivity(
  inputs: ManagedPlanEvaluationInputs
): ManagedCheckFailure | undefined {
  if (!stepsUseManagedRemoveQuote(inputs.steps)) {
    return undefined;
  }

  const minimumManagedSensitivityBpsPer10PctRelease =
    inputs.config.minimumManagedSensitivityBpsPer10PctRelease ?? 0;
  if (minimumManagedSensitivityBpsPer10PctRelease <= 0) {
    return undefined;
  }

  const managedMetadata = readMetadata(inputs);
  const totalWithdrawableQuoteAmount =
    managedMetadata.managedTotalWithdrawableQuoteAmount;
  if (
    totalWithdrawableQuoteAmount === undefined ||
    totalWithdrawableQuoteAmount <= 0n
  ) {
    return {
      check: "sensitivity_threshold",
      kind: "missing_withdrawable_totals"
    };
  }

  const improvementBps = computeImprovementBps(inputs);
  const normalizedSensitivityBpsPer10PctRelease =
    normalizedManagedSensitivityBpsPer10PctRelease(
      improvementBps,
      inputs.releasedQuoteAmount,
      totalWithdrawableQuoteAmount
    );

  if (normalizedSensitivityBpsPer10PctRelease === undefined) {
    return {
      check: "sensitivity_threshold",
      kind: "zero_release_fraction",
      minimumManagedSensitivityBpsPer10PctRelease
    };
  }

  if (
    normalizedSensitivityBpsPer10PctRelease <
    BigInt(minimumManagedSensitivityBpsPer10PctRelease)
  ) {
    return {
      check: "sensitivity_threshold",
      kind: "below_sensitivity_gate",
      minimumManagedSensitivityBpsPer10PctRelease
    };
  }

  return undefined;
}

const CHECK_FUNCTIONS: Record<
  ManagedCheckName,
  (inputs: ManagedPlanEvaluationInputs) => ManagedCheckFailure | undefined
> = {
  eligibility: checkManagedEligibility,
  availability: checkManagedAvailability,
  release_cap: checkManagedReleaseCap,
  improvement_floor: checkManagedImprovementFloor,
  sensitivity_threshold: checkManagedSensitivity
};

export function evaluateManagedPlan(
  inputs: ManagedPlanEvaluationInputs,
  checks: readonly ManagedCheckName[]
): ManagedCheckFailure | undefined {
  if (!stepsUseManagedRemoveQuote(inputs.steps)) {
    return undefined;
  }

  for (const check of checks) {
    const failure = CHECK_FUNCTIONS[check](inputs);
    if (failure) {
      return failure;
    }
  }

  return undefined;
}

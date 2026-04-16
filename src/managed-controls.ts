import {
  type ExecutionStep,
  type PoolSnapshot
} from "./types.js";

export interface ManagedControlSnapshotMetadata {
  managedInventoryUpwardControlEnabled?: boolean;
  managedDualUpwardControlEnabled?: boolean;
  managedInventoryUpwardEligible?: boolean;
  managedInventoryIneligibilityReason?: string;
  managedDualUpwardEligible?: boolean;
  managedDualIneligibilityReason?: string;
  managedInventoryBucketCount?: number;
  managedConfiguredBucketCount?: number;
  managedMaxWithdrawableQuoteAmount?: bigint;
  managedTotalWithdrawableQuoteAmount?: bigint;
  managedRemoveQuoteCandidateCount?: number;
  managedDualCandidateCount?: number;
}

function snapshotMetadataBoolean(snapshot: PoolSnapshot, key: string): boolean | undefined {
  const value = snapshot.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function snapshotMetadataNumber(snapshot: PoolSnapshot, key: string): number | undefined {
  const value = snapshot.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function snapshotMetadataString(snapshot: PoolSnapshot, key: string): string | undefined {
  const value = snapshot.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function snapshotMetadataBigInt(snapshot: PoolSnapshot, key: string): bigint | undefined {
  const value = snapshotMetadataString(snapshot, key);
  if (value === undefined) {
    return undefined;
  }

  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

export function readManagedControlSnapshotMetadata(
  snapshot: PoolSnapshot
): ManagedControlSnapshotMetadata {
  const managedInventoryUpwardControlEnabled = snapshotMetadataBoolean(
    snapshot,
    "managedInventoryUpwardControlEnabled"
  );
  const managedDualUpwardControlEnabled = snapshotMetadataBoolean(
    snapshot,
    "managedDualUpwardControlEnabled"
  );
  const managedInventoryUpwardEligible = snapshotMetadataBoolean(
    snapshot,
    "managedInventoryUpwardEligible"
  );
  const managedInventoryIneligibilityReason = snapshotMetadataString(
    snapshot,
    "managedInventoryIneligibilityReason"
  );
  const managedDualUpwardEligible = snapshotMetadataBoolean(
    snapshot,
    "managedDualUpwardEligible"
  );
  const managedDualIneligibilityReason = snapshotMetadataString(
    snapshot,
    "managedDualIneligibilityReason"
  );
  const managedInventoryBucketCount = snapshotMetadataNumber(
    snapshot,
    "managedInventoryBucketCount"
  );
  const managedConfiguredBucketCount = snapshotMetadataNumber(
    snapshot,
    "managedConfiguredBucketCount"
  );
  const managedMaxWithdrawableQuoteAmount = snapshotMetadataBigInt(
    snapshot,
    "managedMaxWithdrawableQuoteAmount"
  );
  const managedTotalWithdrawableQuoteAmount = snapshotMetadataBigInt(
    snapshot,
    "managedTotalWithdrawableQuoteAmount"
  );
  const managedRemoveQuoteCandidateCount = snapshotMetadataNumber(
    snapshot,
    "managedRemoveQuoteCandidateCount"
  );
  const managedDualCandidateCount = snapshotMetadataNumber(
    snapshot,
    "managedDualCandidateCount"
  );

  return {
    ...(managedInventoryUpwardControlEnabled === undefined
      ? {}
      : { managedInventoryUpwardControlEnabled }),
    ...(managedDualUpwardControlEnabled === undefined
      ? {}
      : { managedDualUpwardControlEnabled }),
    ...(managedInventoryUpwardEligible === undefined
      ? {}
      : { managedInventoryUpwardEligible }),
    ...(managedInventoryIneligibilityReason === undefined
      ? {}
      : { managedInventoryIneligibilityReason }),
    ...(managedDualUpwardEligible === undefined ? {} : { managedDualUpwardEligible }),
    ...(managedDualIneligibilityReason === undefined
      ? {}
      : { managedDualIneligibilityReason }),
    ...(managedInventoryBucketCount === undefined ? {} : { managedInventoryBucketCount }),
    ...(managedConfiguredBucketCount === undefined ? {} : { managedConfiguredBucketCount }),
    ...(managedMaxWithdrawableQuoteAmount === undefined
      ? {}
      : { managedMaxWithdrawableQuoteAmount }),
    ...(managedTotalWithdrawableQuoteAmount === undefined
      ? {}
      : { managedTotalWithdrawableQuoteAmount }),
    ...(managedRemoveQuoteCandidateCount === undefined
      ? {}
      : { managedRemoveQuoteCandidateCount }),
    ...(managedDualCandidateCount === undefined ? {} : { managedDualCandidateCount })
  };
}

export function stepsUseManagedRemoveQuote(steps: readonly ExecutionStep[]): boolean {
  return steps.some((step) => step.type === "REMOVE_QUOTE");
}

export function stepsUseManagedDual(steps: readonly ExecutionStep[]): boolean {
  let hasRemoveQuote = false;
  let hasDrawDebt = false;

  for (const step of steps) {
    if (step.type === "REMOVE_QUOTE") {
      hasRemoveQuote = true;
    } else if (step.type === "DRAW_DEBT") {
      hasDrawDebt = true;
    }
  }

  return hasRemoveQuote && hasDrawDebt;
}

export function releasedQuoteInventoryAmount(steps: readonly ExecutionStep[]): bigint {
  let released = 0n;

  for (const step of steps) {
    if (step.type === "REMOVE_QUOTE") {
      released += step.amount;
    }
  }

  return released;
}

export function ceilDiv(left: bigint, right: bigint): bigint {
  return (left + right - 1n) / right;
}

export function managedImprovementBps(
  baselineDistanceToTargetBps: number,
  candidateDistanceToTargetBps: number
): number {
  return baselineDistanceToTargetBps - candidateDistanceToTargetBps;
}

export function maximumManagedReleasedQuoteAmount(
  totalWithdrawableQuoteAmount: bigint,
  maxManagedInventoryReleaseBps: number
): bigint {
  return (
    totalWithdrawableQuoteAmount * BigInt(maxManagedInventoryReleaseBps)
  ) / 10_000n;
}

export function normalizedManagedSensitivityBpsPer10PctRelease(
  improvementBps: number,
  releasedQuoteAmount: bigint,
  totalWithdrawableQuoteAmount: bigint
): bigint | undefined {
  if (
    improvementBps <= 0 ||
    releasedQuoteAmount <= 0n ||
    totalWithdrawableQuoteAmount <= 0n
  ) {
    return undefined;
  }

  const releaseFractionBps = ceilDiv(
    releasedQuoteAmount * 10_000n,
    totalWithdrawableQuoteAmount
  );
  if (releaseFractionBps <= 0n) {
    return undefined;
  }

  return (BigInt(improvementBps) * 1_000n) / releaseFractionBps;
}

export function buildManagedUnavailableReason(
  ineligibilityReason: string | undefined
): string {
  return ineligibilityReason === undefined
    ? "managed inventory upward control is enabled but unavailable in the current state"
    : `managed inventory upward control is enabled but unavailable because ${ineligibilityReason}`;
}

export function buildManagedReleaseCapReason(
  maxManagedInventoryReleaseBps: number
): string {
  return `managed inventory upward control was eligible, but the best exact managed candidates exceeded the configured ${maxManagedInventoryReleaseBps} bps inventory release cap`;
}

export function buildManagedSensitivityReason(
  minimumManagedSensitivityBpsPer10PctRelease: number
): string {
  return `managed inventory upward control was eligible, but the best exact managed candidates failed the configured controllability gate of ${minimumManagedSensitivityBpsPer10PctRelease} bps per 10% inventory release`;
}

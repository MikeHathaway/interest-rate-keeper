import { type ExecutionStep } from "./types.js";

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

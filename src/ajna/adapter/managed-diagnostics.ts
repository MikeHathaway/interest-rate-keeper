import { type AjnaPoolStateRead, type SimulationAccountState } from "../domain.js";
import { hasUninitializedAjnaEmaState } from "../math/rate-state.js";
import { resolveRemoveQuoteBucketIndexes } from "../search/index.js";
import { buildTargetBand } from "../../core/planning/planner.js";
import {
  type ManagedMetadataKey,
  serializeManagedPerBucketWithdrawable
} from "../../core/snapshot/metadata.js";
import { type KeeperConfig } from "../../core/types.js";

export type ManagedInventoryDiagnosticsWrite = Partial<
  Record<ManagedMetadataKey, unknown>
> & {
  managedInventoryUpwardControlEnabled?: boolean;
  managedDualUpwardControlEnabled?: boolean;
  managedUpwardControlNeeded?: boolean;
  managedInventoryUpwardEligible?: boolean;
  managedInventoryIneligibilityReason?: string;
  managedDualUpwardEligible?: boolean;
  managedDualIneligibilityReason?: string;
  managedInventoryBucketCount?: number;
  managedConfiguredBucketCount?: number;
  managedMaxWithdrawableQuoteAmount?: string;
  managedTotalWithdrawableQuoteAmount?: string;
  managedPerBucketWithdrawableQuoteAmount?: string;
};

/**
 * Derive the managed-inventory curator-mode diagnostics that get written into
 * the snapshot metadata. Returns an empty object when neither managed control
 * mode is enabled. When either is enabled, emits the full eligibility
 * breakdown plus withdrawable-inventory totals so downstream planner/policy
 * layers can apply the curator-mode guard rails.
 */
export function deriveManagedInventoryDiagnostics(
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  simulationPrerequisitesAvailable: boolean,
  accountState?: SimulationAccountState
): ManagedInventoryDiagnosticsWrite {
  const managedInventoryUpwardControlEnabled =
    config.enableManagedInventoryUpwardControl === true;
  const managedDualUpwardControlEnabled =
    config.enableManagedDualUpwardControl === true;
  if (!managedInventoryUpwardControlEnabled && !managedDualUpwardControlEnabled) {
    return {};
  }

  const targetBand = buildTargetBand(config);
  const managedUpwardControlNeeded =
    readState.prediction.predictedNextRateBps < targetBand.minRateBps;
  const configuredBucketCount = resolveRemoveQuoteBucketIndexes(config).length;
  const eligibleLenderBucketStates = (accountState?.lenderBucketStates ?? []).filter(
    (bucketState) => bucketState.maxWithdrawableQuoteAmount > 0n
  );
  const totalWithdrawableQuoteAmount = eligibleLenderBucketStates.reduce(
    (total, bucketState) => total + bucketState.maxWithdrawableQuoteAmount,
    0n
  );
  const maxWithdrawableQuoteAmount = eligibleLenderBucketStates.reduce(
    (largest, bucketState) =>
      bucketState.maxWithdrawableQuoteAmount > largest
        ? bucketState.maxWithdrawableQuoteAmount
        : largest,
    0n
  );
  const perBucketWithdrawableMap = new Map<number, bigint>();
  for (const bucketState of eligibleLenderBucketStates) {
    perBucketWithdrawableMap.set(
      bucketState.bucketIndex,
      bucketState.maxWithdrawableQuoteAmount
    );
  }
  const perBucketWithdrawableSerialized =
    perBucketWithdrawableMap.size === 0
      ? undefined
      : serializeManagedPerBucketWithdrawable(perBucketWithdrawableMap);
  const preWindowState = readState.immediatePrediction.secondsUntilNextRateUpdate > 0;
  // `noOfLoans >= 1n` (not the stricter `> 1n`) is intentional for managed
  // control. Concentrated-ownership managed positions on Ajna tend to be
  // solo-borrower: the operator is the only active loan on their own bucket.
  // The original `> 1n` check was a "real used pool vs fresh pool" heuristic
  // for the generic synthesis paths; for curator mode specifically, if the
  // operator IS the single active borrower, rate projections are more
  // reliable (not less) because the keeper controls both sides of the MAU
  // formation. Still requires EMA-initialized state so we don't try to steer
  // a pool that hasn't warmed up yet.
  const usedPoolLike =
    (readState.loansState?.noOfLoans ?? 0n) >= 1n &&
    !hasUninitializedAjnaEmaState(readState.rateState);
  const sameAccountManagedBorrower =
    accountState === undefined
      ? undefined
      : accountState.borrowerAddress.toLowerCase() ===
        accountState.simulationSenderAddress.toLowerCase();

  let managedInventoryUpwardEligible = managedInventoryUpwardControlEnabled;
  let managedInventoryIneligibilityReason: string | undefined;
  if (managedInventoryUpwardControlEnabled) {
    if (!simulationPrerequisitesAvailable) {
      managedInventoryUpwardEligible = false;
      managedInventoryIneligibilityReason =
        "exact managed inventory control requires a resolvable simulation sender/private key";
    } else if (!managedUpwardControlNeeded) {
      managedInventoryUpwardEligible = false;
      managedInventoryIneligibilityReason =
        "the current target does not require upward steering";
    } else if (!preWindowState) {
      managedInventoryUpwardEligible = false;
      managedInventoryIneligibilityReason =
        "managed inventory upward control currently only runs before the next eligible rate update";
    } else if (!usedPoolLike) {
      managedInventoryUpwardEligible = false;
      managedInventoryIneligibilityReason =
        "managed inventory upward control is only modeled on EMA-initialized used pools";
    } else if (totalWithdrawableQuoteAmount <= 0n) {
      managedInventoryUpwardEligible = false;
      managedInventoryIneligibilityReason =
        "no withdrawable quote inventory was found in the configured or derived managed buckets";
    }
  }

  let managedDualUpwardEligible = managedDualUpwardControlEnabled;
  let managedDualIneligibilityReason: string | undefined;
  if (managedDualUpwardControlEnabled) {
    if (!simulationPrerequisitesAvailable) {
      managedDualUpwardEligible = false;
      managedDualIneligibilityReason =
        "exact managed dual control requires a resolvable simulation sender/private key";
    } else if (!managedUpwardControlNeeded) {
      managedDualUpwardEligible = false;
      managedDualIneligibilityReason =
        "the current target does not require upward steering";
    } else if (!preWindowState) {
      managedDualUpwardEligible = false;
      managedDualIneligibilityReason =
        "managed dual upward control currently only runs before the next eligible rate update";
    } else if (!usedPoolLike) {
      managedDualUpwardEligible = false;
      managedDualIneligibilityReason =
        "managed dual upward control is only modeled on EMA-initialized used pools";
    } else if (totalWithdrawableQuoteAmount <= 0n) {
      managedDualUpwardEligible = false;
      managedDualIneligibilityReason =
        "no withdrawable quote inventory was found in the configured or derived managed buckets";
    } else if (sameAccountManagedBorrower === false) {
      managedDualUpwardEligible = false;
      managedDualIneligibilityReason =
        "managed remove-quote plus draw-debt currently requires the lender and borrower to be the same live account";
    }
  }

  return {
    managedInventoryUpwardControlEnabled,
    managedDualUpwardControlEnabled,
    managedUpwardControlNeeded,
    ...(managedInventoryUpwardControlEnabled
      ? { managedInventoryUpwardEligible }
      : {}),
    ...(managedInventoryIneligibilityReason === undefined
      ? {}
      : { managedInventoryIneligibilityReason }),
    ...(managedDualUpwardControlEnabled ? { managedDualUpwardEligible } : {}),
    ...(managedDualIneligibilityReason === undefined
      ? {}
      : { managedDualIneligibilityReason }),
    managedInventoryBucketCount: eligibleLenderBucketStates.length,
    managedConfiguredBucketCount: configuredBucketCount,
    managedMaxWithdrawableQuoteAmount: maxWithdrawableQuoteAmount.toString(),
    managedTotalWithdrawableQuoteAmount: totalWithdrawableQuoteAmount.toString(),
    ...(perBucketWithdrawableSerialized === undefined
      ? {}
      : { managedPerBucketWithdrawableQuoteAmount: perBucketWithdrawableSerialized })
  };
}

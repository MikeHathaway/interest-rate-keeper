import {
  parseBoolean,
  parseHexAddress,
  parseNumber,
  parseString
} from "./config-parse.js";
import {
  type CandidateSource,
  type PoolSnapshot,
  type PoolSnapshotMetadata,
  type RateMoveOutcome
} from "./types.js";

type KeysOfType<T, Value> = {
  [Key in keyof T]-?: NonNullable<T[Key]> extends Value ? Key : never;
}[keyof T];

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

export type SnapshotMetadataStringKey = KeysOfType<PoolSnapshotMetadata, string>;
export type SnapshotMetadataNumberKey = KeysOfType<PoolSnapshotMetadata, number>;
export type SnapshotMetadataBooleanKey = KeysOfType<PoolSnapshotMetadata, boolean>;
export type SnapshotMetadataScalarKey =
  | SnapshotMetadataStringKey
  | SnapshotMetadataNumberKey;
export type SnapshotMetadataBigIntKey =
  | "quoteTokenScale"
  | "maxT0DebtToCollateral"
  | "noOfLoans"
  | "borrowerT0Debt"
  | "borrowerCollateral"
  | "borrowerNpTpRatio"
  | "currentRateWad"
  | "predictedNextRateWad"
  | "immediatePredictedNextRateWad"
  | "currentDebtWad"
  | "debtEmaWad"
  | "depositEmaWad"
  | "debtColEmaWad"
  | "lupt0DebtEmaWad"
  | "managedMaxWithdrawableQuoteAmount"
  | "managedTotalWithdrawableQuoteAmount";

const EMPTY_POOL_SNAPSHOT_METADATA: PoolSnapshotMetadata = {};

function parseObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }

  return input as Record<string, unknown>;
}

function parseRateMoveOutcome(
  value: unknown,
  label: string
): RateMoveOutcome {
  const parsed = parseString(value, label);
  if (
    parsed !== "STEP_UP" &&
    parsed !== "STEP_DOWN" &&
    parsed !== "RESET_TO_TEN" &&
    parsed !== "NO_CHANGE"
  ) {
    throw new Error(
      `${label} must be 'STEP_UP', 'STEP_DOWN', 'RESET_TO_TEN', or 'NO_CHANGE'`
    );
  }

  return parsed;
}

function parseCandidateSource(
  value: unknown,
  label: string
): CandidateSource {
  const parsed = parseString(value, label);
  if (
    parsed !== "simulation" &&
    parsed !== "heuristic" &&
    parsed !== "manual"
  ) {
    throw new Error(
      `${label} must be 'simulation', 'heuristic', or 'manual'`
    );
  }

  return parsed;
}

function assignOptionalString(
  target: PoolSnapshotMetadata,
  record: Record<string, unknown>,
  key: SnapshotMetadataStringKey
): void {
  const value = record[key];
  if (value !== undefined) {
    (
      target as Partial<Record<SnapshotMetadataStringKey, string>>
    )[key] = parseString(value, `metadata.${String(key)}`);
  }
}

function assignOptionalHexAddress(
  target: PoolSnapshotMetadata,
  record: Record<string, unknown>,
  key:
    | "poolAddress"
    | "quoteTokenAddress"
    | "collateralAddress"
    | "maxBorrower"
    | "borrowerAddress"
    | "simulationSenderAddress"
    | "liveSignerAddress"
): void {
  const value = record[key];
  if (value !== undefined) {
    target[key] = parseHexAddress(value, `metadata.${String(key)}`);
  }
}

function assignOptionalCandidateSource(
  target: PoolSnapshotMetadata,
  record: Record<string, unknown>,
  key: "autoCandidateSource"
): void {
  const value = record[key];
  if (value !== undefined) {
    target[key] = parseCandidateSource(value, `metadata.${key}`);
  }
}

function assignOptionalNumber(
  target: PoolSnapshotMetadata,
  record: Record<string, unknown>,
  key: SnapshotMetadataNumberKey
): void {
  const value = record[key];
  if (value !== undefined) {
    target[key] = parseNumber(value, `metadata.${String(key)}`);
  }
}

function assignOptionalBoolean(
  target: PoolSnapshotMetadata,
  record: Record<string, unknown>,
  key: SnapshotMetadataBooleanKey
): void {
  const value = record[key];
  if (value !== undefined) {
    target[key] = parseBoolean(value, `metadata.${String(key)}`);
  }
}

function assignOptionalRateMoveOutcome(
  target: PoolSnapshotMetadata,
  record: Record<string, unknown>,
  key: "immediatePredictedNextOutcome"
): void {
  const value = record[key];
  if (value !== undefined) {
    target[key] = parseRateMoveOutcome(value, `metadata.${key}`);
  }
}

export function resolvePoolSnapshotMetadata(
  input: unknown,
  label = "metadata"
): PoolSnapshotMetadata {
  const record = parseObject(input, label);
  const metadata: PoolSnapshotMetadata = {};

  assignOptionalHexAddress(metadata, record, "poolAddress");
  assignOptionalHexAddress(metadata, record, "quoteTokenAddress");
  assignOptionalHexAddress(metadata, record, "collateralAddress");
  assignOptionalString(metadata, record, "quoteTokenScale");
  assignOptionalNumber(metadata, record, "poolType");
  assignOptionalHexAddress(metadata, record, "maxBorrower");
  assignOptionalString(metadata, record, "maxT0DebtToCollateral");
  assignOptionalString(metadata, record, "noOfLoans");
  assignOptionalHexAddress(metadata, record, "borrowerAddress");
  assignOptionalString(metadata, record, "borrowerT0Debt");
  assignOptionalString(metadata, record, "borrowerCollateral");
  assignOptionalString(metadata, record, "borrowerNpTpRatio");
  assignOptionalString(metadata, record, "currentRateWad");
  assignOptionalString(metadata, record, "predictedNextRateWad");
  assignOptionalString(metadata, record, "immediatePredictedNextRateWad");
  assignOptionalString(metadata, record, "currentDebtWad");
  assignOptionalString(metadata, record, "debtEmaWad");
  assignOptionalString(metadata, record, "depositEmaWad");
  assignOptionalString(metadata, record, "debtColEmaWad");
  assignOptionalString(metadata, record, "lupt0DebtEmaWad");
  assignOptionalCandidateSource(metadata, record, "autoCandidateSource");
  assignOptionalString(metadata, record, "simulationExecutionCompatibilityReason");
  assignOptionalHexAddress(metadata, record, "simulationSenderAddress");
  assignOptionalHexAddress(metadata, record, "liveSignerAddress");
  assignOptionalString(metadata, record, "managedInventoryIneligibilityReason");
  assignOptionalString(metadata, record, "managedDualIneligibilityReason");
  assignOptionalString(metadata, record, "managedMaxWithdrawableQuoteAmount");
  assignOptionalString(metadata, record, "managedTotalWithdrawableQuoteAmount");

  assignOptionalRateMoveOutcome(metadata, record, "immediatePredictedNextOutcome");

  assignOptionalNumber(metadata, record, "lastInterestRateUpdateTimestamp");
  assignOptionalNumber(metadata, record, "autoCandidateCount");
  assignOptionalNumber(metadata, record, "planningRateBps");
  assignOptionalNumber(metadata, record, "planningLookaheadUpdates");
  assignOptionalNumber(metadata, record, "managedInventoryBucketCount");
  assignOptionalNumber(metadata, record, "managedConfiguredBucketCount");
  assignOptionalNumber(metadata, record, "managedRemoveQuoteCandidateCount");
  assignOptionalNumber(metadata, record, "managedDualCandidateCount");

  assignOptionalBoolean(metadata, record, "simulationBackedSynthesisEnabled");
  assignOptionalBoolean(metadata, record, "simulationPrerequisitesAvailable");
  assignOptionalBoolean(metadata, record, "simulationExecutionCompatible");
  assignOptionalBoolean(metadata, record, "managedInventoryUpwardControlEnabled");
  assignOptionalBoolean(metadata, record, "managedDualUpwardControlEnabled");
  assignOptionalBoolean(metadata, record, "managedUpwardControlNeeded");
  assignOptionalBoolean(metadata, record, "managedInventoryUpwardEligible");
  assignOptionalBoolean(metadata, record, "managedDualUpwardEligible");

  return metadata;
}

export function readPoolSnapshotMetadata(
  snapshot: PoolSnapshot
): PoolSnapshotMetadata {
  return snapshot.metadata ?? EMPTY_POOL_SNAPSHOT_METADATA;
}

export function readSnapshotMetadataString(
  snapshot: PoolSnapshot,
  key: SnapshotMetadataStringKey
): string | undefined {
  const value = readPoolSnapshotMetadata(snapshot)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requireSnapshotMetadataString(
  snapshot: PoolSnapshot,
  key: SnapshotMetadataStringKey
): string {
  const value = readSnapshotMetadataString(snapshot, key);
  if (value !== undefined) {
    return value;
  }

  throw new Error(`snapshot metadata is missing ${String(key)}`);
}

export function readSnapshotMetadataNumber(
  snapshot: PoolSnapshot,
  key: SnapshotMetadataNumberKey
): number | undefined {
  const value = readPoolSnapshotMetadata(snapshot)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function requireSnapshotMetadataNumber(
  snapshot: PoolSnapshot,
  key: SnapshotMetadataNumberKey
): number {
  const value = readSnapshotMetadataNumber(snapshot, key);
  if (value !== undefined) {
    return value;
  }

  throw new Error(`snapshot metadata is missing ${String(key)}`);
}

export function readSnapshotMetadataBoolean(
  snapshot: PoolSnapshot,
  key: SnapshotMetadataBooleanKey
): boolean | undefined {
  const value = readPoolSnapshotMetadata(snapshot)[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readSnapshotMetadataBigInt(
  snapshot: PoolSnapshot,
  key: SnapshotMetadataBigIntKey
): bigint | undefined {
  const value = readSnapshotMetadataString(snapshot, key);
  if (value === undefined) {
    return undefined;
  }

  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

export function requireSnapshotMetadataBigInt(
  snapshot: PoolSnapshot,
  key: SnapshotMetadataBigIntKey
): bigint {
  const value = readSnapshotMetadataBigInt(snapshot, key);
  if (value !== undefined) {
    return value;
  }

  throw new Error(`snapshot metadata is missing ${String(key)}`);
}

export function requireSnapshotMetadataScalar(
  snapshot: PoolSnapshot,
  key: SnapshotMetadataScalarKey
): string | number {
  if (typeof readPoolSnapshotMetadata(snapshot)[key] === "string") {
    return requireSnapshotMetadataString(snapshot, key as SnapshotMetadataStringKey);
  }

  if (typeof readPoolSnapshotMetadata(snapshot)[key] === "number") {
    return requireSnapshotMetadataNumber(snapshot, key as SnapshotMetadataNumberKey);
  }

  throw new Error(`snapshot metadata is missing ${String(key)}`);
}

export function readManagedControlSnapshotMetadata(
  snapshot: PoolSnapshot
): ManagedControlSnapshotMetadata {
  const managedInventoryUpwardControlEnabled = readSnapshotMetadataBoolean(
    snapshot,
    "managedInventoryUpwardControlEnabled"
  );
  const managedDualUpwardControlEnabled = readSnapshotMetadataBoolean(
    snapshot,
    "managedDualUpwardControlEnabled"
  );
  const managedInventoryUpwardEligible = readSnapshotMetadataBoolean(
    snapshot,
    "managedInventoryUpwardEligible"
  );
  const managedInventoryIneligibilityReason = readSnapshotMetadataString(
    snapshot,
    "managedInventoryIneligibilityReason"
  );
  const managedDualUpwardEligible = readSnapshotMetadataBoolean(
    snapshot,
    "managedDualUpwardEligible"
  );
  const managedDualIneligibilityReason = readSnapshotMetadataString(
    snapshot,
    "managedDualIneligibilityReason"
  );
  const managedInventoryBucketCount = readSnapshotMetadataNumber(
    snapshot,
    "managedInventoryBucketCount"
  );
  const managedConfiguredBucketCount = readSnapshotMetadataNumber(
    snapshot,
    "managedConfiguredBucketCount"
  );
  const managedMaxWithdrawableQuoteAmount = readSnapshotMetadataBigInt(
    snapshot,
    "managedMaxWithdrawableQuoteAmount"
  );
  const managedTotalWithdrawableQuoteAmount = readSnapshotMetadataBigInt(
    snapshot,
    "managedTotalWithdrawableQuoteAmount"
  );
  const managedRemoveQuoteCandidateCount = readSnapshotMetadataNumber(
    snapshot,
    "managedRemoveQuoteCandidateCount"
  );
  const managedDualCandidateCount = readSnapshotMetadataNumber(
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

export function simulationExecutionCompatibilityReason(
  snapshot: PoolSnapshot
): string | undefined {
  return readSnapshotMetadataString(snapshot, "simulationExecutionCompatibilityReason");
}

export function semanticSnapshotMetadataSignature(
  snapshot: PoolSnapshot
): string | undefined {
  const poolAddress = readSnapshotMetadataString(snapshot, "poolAddress");
  const currentRateWad = readSnapshotMetadataString(snapshot, "currentRateWad");
  const currentDebtWad = readSnapshotMetadataString(snapshot, "currentDebtWad");
  const debtEmaWad = readSnapshotMetadataString(snapshot, "debtEmaWad");
  const depositEmaWad = readSnapshotMetadataString(snapshot, "depositEmaWad");
  const debtColEmaWad = readSnapshotMetadataString(snapshot, "debtColEmaWad");
  const lupt0DebtEmaWad = readSnapshotMetadataString(snapshot, "lupt0DebtEmaWad");
  const lastInterestRateUpdateTimestamp = readSnapshotMetadataNumber(
    snapshot,
    "lastInterestRateUpdateTimestamp"
  );

  if (
    poolAddress === undefined ||
    currentRateWad === undefined ||
    currentDebtWad === undefined ||
    debtEmaWad === undefined ||
    depositEmaWad === undefined ||
    debtColEmaWad === undefined ||
    lupt0DebtEmaWad === undefined ||
    lastInterestRateUpdateTimestamp === undefined
  ) {
    return undefined;
  }

  return [
    poolAddress,
    currentRateWad,
    currentDebtWad,
    debtEmaWad,
    depositEmaWad,
    debtColEmaWad,
    lupt0DebtEmaWad,
    String(lastInterestRateUpdateTimestamp)
  ].join(":");
}

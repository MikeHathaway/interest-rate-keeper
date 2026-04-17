import { type ConfigPrimitiveParsers } from "./config-parse.js";
import { type KeeperConfig } from "./types.js";

export const MANAGED_CONFIG_OPTIONS = [
  {
    key: "removeQuoteBucketIndex",
    type: "integer",
    docs: "optional single managed lender bucket seed for `REMOVE_QUOTE` search"
  },
  {
    key: "removeQuoteBucketIndexes",
    type: "integer[]",
    docs: "optional managed lender bucket seeds for `REMOVE_QUOTE` search"
  },
  {
    key: "enableManagedInventoryUpwardControl",
    type: "boolean",
    docs: "turns on exact managed `REMOVE_QUOTE` search for used-pool upward states"
  },
  {
    key: "enableManagedDualUpwardControl",
    type: "boolean",
    docs: "turns on exact managed dual search; still research-only in product terms"
  },
  {
    key: "minimumManagedImprovementBps",
    type: "integer",
    docs: "minimum predicted improvement margin required over the passive path"
  },
  {
    key: "maxManagedInventoryReleaseBps",
    type: "integer",
    docs: "caps one-cycle managed inventory release in basis points of total withdrawable inventory"
  },
  {
    key: "minimumManagedSensitivityBpsPer10PctRelease",
    type: "integer",
    docs: "controllability gate in bps of improvement per 10% inventory release"
  }
] as const;

export type ManagedConfigOptionKey = (typeof MANAGED_CONFIG_OPTIONS)[number]["key"];

export const MANAGED_CONFIG_OPTION_KEYS = MANAGED_CONFIG_OPTIONS.map(
  (option) => option.key
) as ManagedConfigOptionKey[];

type ManagedConfigRecord = Partial<
  Record<ManagedConfigOptionKey, unknown>
> &
  Record<string, unknown>;

type ManagedConfigParsers = Pick<
  ConfigPrimitiveParsers,
  "parseBoolean" | "parseIntegerArray" | "parseNonNegativeInteger"
>;

function parseSortedDistinctNonEmptyIntegerArray(
  value: unknown,
  label: string,
  parsers: ManagedConfigParsers
): number[] {
  const parsed = parsers.parseIntegerArray(value, label);
  if (parsed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }

  return Array.from(new Set(parsed)).sort((left, right) => left - right);
}

export function applyManagedConfigFields(
  record: ManagedConfigRecord,
  config: KeeperConfig,
  parsers: ManagedConfigParsers
): void {
  if (record.removeQuoteBucketIndex !== undefined) {
    config.removeQuoteBucketIndex = parsers.parseNonNegativeInteger(
      record.removeQuoteBucketIndex,
      "removeQuoteBucketIndex"
    );
  }

  if (record.removeQuoteBucketIndexes !== undefined) {
    config.removeQuoteBucketIndexes = parseSortedDistinctNonEmptyIntegerArray(
      record.removeQuoteBucketIndexes,
      "removeQuoteBucketIndexes",
      parsers
    );
  }

  if (record.enableManagedInventoryUpwardControl !== undefined) {
    config.enableManagedInventoryUpwardControl = parsers.parseBoolean(
      record.enableManagedInventoryUpwardControl,
      "enableManagedInventoryUpwardControl"
    );
  }

  if (record.enableManagedDualUpwardControl !== undefined) {
    config.enableManagedDualUpwardControl = parsers.parseBoolean(
      record.enableManagedDualUpwardControl,
      "enableManagedDualUpwardControl"
    );
  }

  if (record.minimumManagedImprovementBps !== undefined) {
    config.minimumManagedImprovementBps = parsers.parseNonNegativeInteger(
      record.minimumManagedImprovementBps,
      "minimumManagedImprovementBps"
    );
  }

  if (record.maxManagedInventoryReleaseBps !== undefined) {
    const parsedMaxManagedInventoryReleaseBps = parsers.parseNonNegativeInteger(
      record.maxManagedInventoryReleaseBps,
      "maxManagedInventoryReleaseBps"
    );
    if (parsedMaxManagedInventoryReleaseBps > 10_000) {
      throw new Error("maxManagedInventoryReleaseBps must not exceed 10000");
    }
    config.maxManagedInventoryReleaseBps = parsedMaxManagedInventoryReleaseBps;
  }

  if (record.minimumManagedSensitivityBpsPer10PctRelease !== undefined) {
    config.minimumManagedSensitivityBpsPer10PctRelease = parsers.parseNonNegativeInteger(
      record.minimumManagedSensitivityBpsPer10PctRelease,
      "minimumManagedSensitivityBpsPer10PctRelease"
    );
  }
}

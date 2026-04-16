import { type KeeperConfig } from "./types.js";

export const MANAGED_CONFIG_OPTION_KEYS = [
  "removeQuoteBucketIndex",
  "removeQuoteBucketIndexes",
  "enableManagedInventoryUpwardControl",
  "enableManagedDualUpwardControl",
  "minimumManagedImprovementBps",
  "maxManagedInventoryReleaseBps",
  "minimumManagedSensitivityBpsPer10PctRelease"
] as const;

type ManagedConfigRecord = Partial<
  Record<(typeof MANAGED_CONFIG_OPTION_KEYS)[number], unknown>
> &
  Record<string, unknown>;

type ManagedConfigParsers = {
  parseBoolean: (value: unknown, label: string) => boolean;
  parseIntegerArray: (value: unknown, label: string) => number[];
  parseNonNegativeInteger: (value: unknown, label: string) => number;
};

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

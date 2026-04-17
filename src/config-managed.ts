import {
  type ConfigPrimitiveParsers,
  parseSortedDistinctNonEmptyIntegerArray
} from "./config-parse.js";
import { type KeeperConfig } from "./types.js";
import { BPS_DENOMINATOR } from "./units.js";

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
  "parseBoolean" | "parseNonNegativeInteger"
>;

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
      "removeQuoteBucketIndexes"
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
    if (
      config.enableManagedDualUpwardControl === true &&
      config.enableManagedInventoryUpwardControl !== true
    ) {
      throw new Error(
        "enableManagedDualUpwardControl requires enableManagedInventoryUpwardControl to also be true"
      );
    }
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
    if (parsedMaxManagedInventoryReleaseBps === 0) {
      throw new Error(
        "maxManagedInventoryReleaseBps must be greater than zero (0 would deny every managed plan)"
      );
    }
    if (parsedMaxManagedInventoryReleaseBps > BPS_DENOMINATOR) {
      throw new Error(
        `maxManagedInventoryReleaseBps must not exceed ${BPS_DENOMINATOR}`
      );
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

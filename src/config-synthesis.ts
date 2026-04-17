import { type ConfigPrimitiveParsers } from "./config-parse.js";
import { type KeeperConfig } from "./types.js";

type SynthesisConfigRecord = Record<string, unknown>;

type SynthesisConfigParsers = Pick<
  ConfigPrimitiveParsers,
  | "parseBoolean"
  | "parseIntegerArray"
  | "parseNonNegativeInteger"
  | "parsePositiveInteger"
  | "parseOptionalBigInt"
  | "parseBigIntArray"
  | "parseHexAddress"
>;

function parseSortedDistinctNonEmptyIntegerArray(
  value: unknown,
  label: string,
  parsers: SynthesisConfigParsers
): number[] {
  const parsed = parsers.parseIntegerArray(value, label);
  if (parsed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }

  return Array.from(new Set(parsed)).sort((left, right) => left - right);
}

function parseDistinctNonEmptyIntegerArray(
  value: unknown,
  label: string,
  parsers: SynthesisConfigParsers
): number[] {
  const parsed = parsers.parseIntegerArray(value, label);
  if (parsed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }

  return Array.from(new Set(parsed));
}

function parseSortedDistinctNonEmptyBigIntArray(
  value: unknown,
  label: string,
  parsers: SynthesisConfigParsers
): bigint[] {
  const parsed = parsers.parseBigIntArray(value, label);
  if (parsed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (parsed.some((amount) => amount < 0n)) {
    throw new Error(`${label} must not contain negative values`);
  }

  return Array.from(new Set(parsed)).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function applySynthesisConfigFields(
  record: SynthesisConfigRecord,
  config: KeeperConfig,
  parsers: SynthesisConfigParsers
): void {
  if (record.addQuoteBucketIndex !== undefined) {
    config.addQuoteBucketIndex = parsers.parseNonNegativeInteger(
      record.addQuoteBucketIndex,
      "addQuoteBucketIndex"
    );
  }

  if (record.addQuoteBucketIndexes !== undefined) {
    config.addQuoteBucketIndexes = parseSortedDistinctNonEmptyIntegerArray(
      record.addQuoteBucketIndexes,
      "addQuoteBucketIndexes",
      parsers
    );
  }

  if (record.addQuoteExpirySeconds !== undefined) {
    config.addQuoteExpirySeconds = parsers.parsePositiveInteger(
      record.addQuoteExpirySeconds,
      "addQuoteExpirySeconds"
    );
  }

  if (record.enableSimulationBackedLendSynthesis !== undefined) {
    config.enableSimulationBackedLendSynthesis = parsers.parseBoolean(
      record.enableSimulationBackedLendSynthesis,
      "enableSimulationBackedLendSynthesis"
    );
  }

  if (record.enableSimulationBackedBorrowSynthesis !== undefined) {
    config.enableSimulationBackedBorrowSynthesis = parsers.parseBoolean(
      record.enableSimulationBackedBorrowSynthesis,
      "enableSimulationBackedBorrowSynthesis"
    );
  }

  if (record.simulationSenderAddress !== undefined) {
    config.simulationSenderAddress = parsers.parseHexAddress(
      record.simulationSenderAddress,
      "simulationSenderAddress"
    );
  }

  if (record.drawDebtLimitIndex !== undefined) {
    config.drawDebtLimitIndex = parsers.parseNonNegativeInteger(
      record.drawDebtLimitIndex,
      "drawDebtLimitIndex"
    );
  }

  if (record.drawDebtLimitIndexes !== undefined) {
    config.drawDebtLimitIndexes = parseDistinctNonEmptyIntegerArray(
      record.drawDebtLimitIndexes,
      "drawDebtLimitIndexes",
      parsers
    );
  }

  if (record.borrowSimulationLookaheadUpdates !== undefined) {
    config.borrowSimulationLookaheadUpdates = parsers.parsePositiveInteger(
      record.borrowSimulationLookaheadUpdates,
      "borrowSimulationLookaheadUpdates"
    );
  }

  const drawDebtCollateralAmount = parsers.parseOptionalBigInt(
    record.drawDebtCollateralAmount,
    "drawDebtCollateralAmount"
  );
  if (drawDebtCollateralAmount !== undefined) {
    if (drawDebtCollateralAmount < 0n) {
      throw new Error("drawDebtCollateralAmount must not be negative");
    }
    config.drawDebtCollateralAmount = drawDebtCollateralAmount;
  }

  if (record.drawDebtCollateralAmounts !== undefined) {
    config.drawDebtCollateralAmounts = parseSortedDistinctNonEmptyBigIntArray(
      record.drawDebtCollateralAmounts,
      "drawDebtCollateralAmounts",
      parsers
    );
  }

  if (record.enableHeuristicLendSynthesis !== undefined) {
    config.enableHeuristicLendSynthesis = parsers.parseBoolean(
      record.enableHeuristicLendSynthesis,
      "enableHeuristicLendSynthesis"
    );
  }

  if (record.enableHeuristicBorrowSynthesis !== undefined) {
    config.enableHeuristicBorrowSynthesis = parsers.parseBoolean(
      record.enableHeuristicBorrowSynthesis,
      "enableHeuristicBorrowSynthesis"
    );
  }
}

import {
  type CompletionPolicy,
  type HexAddress,
  type KeeperConfig,
  type ToleranceMode
} from "./types.js";
import { resolvePlanCandidate } from "./snapshot.js";

const DEFAULTS = {
  toleranceMode: "relative" as ToleranceMode,
  completionPolicy: "next_move_would_overshoot" as CompletionPolicy,
  executionBufferBps: 50,
  snapshotAgeMaxSeconds: 90,
  minTimeBeforeRateWindowSeconds: 120,
  minExecutableQuoteTokenAmount: 1n,
  minExecutableBorrowAmount: 1n,
  minExecutableCollateralAmount: 1n,
  recheckBeforeSubmit: true,
  allowHeuristicExecution: false
};

function parseObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }

  return input as Record<string, unknown>;
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function parseHexAddress(value: unknown, label: string): HexAddress {
  const parsed = parseString(value, label);
  if (!/^0x[a-fA-F0-9]{40}$/.test(parsed)) {
    throw new Error(`${label} must be a hex address`);
  }

  return parsed as HexAddress;
}

function parseNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return value;
}

function parsePositiveNumber(value: unknown, label: string): number {
  const parsed = parseNumber(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  const parsed = parseNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = parsePositiveNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function parseIntegerArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((item, index) =>
    parseNonNegativeInteger(item, `${label}[${index}]`)
  );
}

function parseBigIntArray(value: unknown, label: string): bigint[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((item, index) => parseBigIntValue(item, `${label}[${index}]`));
}

function parseOptionalBigInt(value: unknown, label: string): bigint | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return parseBigIntValue(value, label);
}

function parseBigIntValue(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return BigInt(value.trim());
  }

  throw new Error(`${label} must be an integer-like value`);
}

function parsePositiveBigInt(value: unknown, label: string): bigint {
  const parsed = parseBigIntValue(value, label);
  if (parsed <= 0n) {
    throw new Error(`${label} must be greater than zero`);
  }

  return parsed;
}

function parseToleranceMode(value: unknown): ToleranceMode {
  if (value === undefined) {
    return DEFAULTS.toleranceMode;
  }

  if (value === "absolute" || value === "relative") {
    return value;
  }

  throw new Error("toleranceMode must be 'absolute' or 'relative'");
}

function parseCompletionPolicy(value: unknown): CompletionPolicy {
  if (value === undefined) {
    return DEFAULTS.completionPolicy;
  }

  if (value === "in_band" || value === "next_move_would_overshoot") {
    return value;
  }

  throw new Error(
    "completionPolicy must be 'in_band' or 'next_move_would_overshoot'"
  );
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${label} must be a boolean`);
}

export function resolveKeeperConfig(input: unknown): KeeperConfig {
  const record = parseObject(input, "keeper config");

  const targetRateBps = parsePositiveNumber(record.targetRateBps, "targetRateBps");
  const toleranceBps = parsePositiveNumber(record.toleranceBps, "toleranceBps");
  const legacyMinExecutableActionAmount =
    record.minExecutableActionQuoteToken === undefined
      ? undefined
      : parsePositiveBigInt(
          record.minExecutableActionQuoteToken,
          "minExecutableActionQuoteToken"
        );
  const poolAddress =
    record.poolAddress === undefined
      ? undefined
      : parseHexAddress(record.poolAddress, "poolAddress");

  const config: KeeperConfig = {
    chainId: parsePositiveNumber(record.chainId, "chainId"),
    poolId:
      record.poolId === undefined
        ? poolAddress
          ? `${parsePositiveNumber(record.chainId, "chainId")}:${poolAddress.toLowerCase()}`
          : (() => {
              throw new Error("poolId is required when poolAddress is not provided");
            })()
        : parseString(record.poolId, "poolId"),
    targetRateBps,
    toleranceBps,
    toleranceMode: parseToleranceMode(record.toleranceMode),
    completionPolicy: parseCompletionPolicy(record.completionPolicy),
    executionBufferBps:
      record.executionBufferBps === undefined
        ? DEFAULTS.executionBufferBps
        : parseNumber(record.executionBufferBps, "executionBufferBps"),
    maxQuoteTokenExposure: parsePositiveBigInt(
      record.maxQuoteTokenExposure,
      "maxQuoteTokenExposure"
    ),
    maxBorrowExposure: parsePositiveBigInt(
      record.maxBorrowExposure,
      "maxBorrowExposure"
    ),
    snapshotAgeMaxSeconds:
      record.snapshotAgeMaxSeconds === undefined
        ? DEFAULTS.snapshotAgeMaxSeconds
        : parsePositiveNumber(record.snapshotAgeMaxSeconds, "snapshotAgeMaxSeconds"),
    minTimeBeforeRateWindowSeconds:
      record.minTimeBeforeRateWindowSeconds === undefined
        ? DEFAULTS.minTimeBeforeRateWindowSeconds
        : parsePositiveNumber(
            record.minTimeBeforeRateWindowSeconds,
            "minTimeBeforeRateWindowSeconds"
          ),
    minExecutableQuoteTokenAmount:
      record.minExecutableQuoteTokenAmount === undefined
        ? legacyMinExecutableActionAmount ?? DEFAULTS.minExecutableQuoteTokenAmount
        : parsePositiveBigInt(
            record.minExecutableQuoteTokenAmount,
            "minExecutableQuoteTokenAmount"
          ),
    minExecutableBorrowAmount:
      record.minExecutableBorrowAmount === undefined
        ? legacyMinExecutableActionAmount ?? DEFAULTS.minExecutableBorrowAmount
        : parsePositiveBigInt(
            record.minExecutableBorrowAmount,
            "minExecutableBorrowAmount"
          ),
    minExecutableCollateralAmount:
      record.minExecutableCollateralAmount === undefined
        ? legacyMinExecutableActionAmount ?? DEFAULTS.minExecutableCollateralAmount
        : parsePositiveBigInt(
            record.minExecutableCollateralAmount,
            "minExecutableCollateralAmount"
          ),
    recheckBeforeSubmit:
      record.recheckBeforeSubmit === undefined
        ? DEFAULTS.recheckBeforeSubmit
        : parseBoolean(record.recheckBeforeSubmit, "recheckBeforeSubmit"),
    allowHeuristicExecution:
      record.allowHeuristicExecution === undefined
        ? DEFAULTS.allowHeuristicExecution
        : parseBoolean(record.allowHeuristicExecution, "allowHeuristicExecution")
  };

  if (poolAddress !== undefined) {
    config.poolAddress = poolAddress;
  }

  const maxGasCostWei = parseOptionalBigInt(record.maxGasCostWei, "maxGasCostWei");
  if (maxGasCostWei !== undefined) {
    config.maxGasCostWei = maxGasCostWei;
  }

  if (record.rpcUrl !== undefined) {
    config.rpcUrl = parseString(record.rpcUrl, "rpcUrl");
  }

  if (record.borrowerAddress !== undefined) {
    config.borrowerAddress = parseHexAddress(record.borrowerAddress, "borrowerAddress");
  }

  if (record.recipientAddress !== undefined) {
    config.recipientAddress = parseHexAddress(record.recipientAddress, "recipientAddress");
  }

  if (record.logPath !== undefined) {
    config.logPath = parseString(record.logPath, "logPath");
  }

  if (record.addQuoteBucketIndex !== undefined) {
    config.addQuoteBucketIndex = parseNonNegativeInteger(
      record.addQuoteBucketIndex,
      "addQuoteBucketIndex"
    );
  }

  if (record.addQuoteBucketIndexes !== undefined) {
    const parsedBucketIndexes = parseIntegerArray(
      record.addQuoteBucketIndexes,
      "addQuoteBucketIndexes"
    );
    if (parsedBucketIndexes.length === 0) {
      throw new Error("addQuoteBucketIndexes must not be empty");
    }
    config.addQuoteBucketIndexes = Array.from(new Set(parsedBucketIndexes)).sort(
      (left, right) => left - right
    );
  }

  if (record.removeQuoteBucketIndex !== undefined) {
    config.removeQuoteBucketIndex = parseNonNegativeInteger(
      record.removeQuoteBucketIndex,
      "removeQuoteBucketIndex"
    );
  }

  if (record.removeQuoteBucketIndexes !== undefined) {
    const parsedBucketIndexes = parseIntegerArray(
      record.removeQuoteBucketIndexes,
      "removeQuoteBucketIndexes"
    );
    if (parsedBucketIndexes.length === 0) {
      throw new Error("removeQuoteBucketIndexes must not be empty");
    }
    config.removeQuoteBucketIndexes = Array.from(new Set(parsedBucketIndexes)).sort(
      (left, right) => left - right
    );
  }

  if (record.addQuoteExpirySeconds !== undefined) {
    config.addQuoteExpirySeconds = parsePositiveInteger(
      record.addQuoteExpirySeconds,
      "addQuoteExpirySeconds"
    );
  }

  if (record.enableSimulationBackedLendSynthesis !== undefined) {
    config.enableSimulationBackedLendSynthesis = parseBoolean(
      record.enableSimulationBackedLendSynthesis,
      "enableSimulationBackedLendSynthesis"
    );
  }

  if (record.enableSimulationBackedBorrowSynthesis !== undefined) {
    config.enableSimulationBackedBorrowSynthesis = parseBoolean(
      record.enableSimulationBackedBorrowSynthesis,
      "enableSimulationBackedBorrowSynthesis"
    );
  }

  if (record.enableManagedInventoryUpwardControl !== undefined) {
    config.enableManagedInventoryUpwardControl = parseBoolean(
      record.enableManagedInventoryUpwardControl,
      "enableManagedInventoryUpwardControl"
    );
  }

  if (record.enableManagedDualUpwardControl !== undefined) {
    config.enableManagedDualUpwardControl = parseBoolean(
      record.enableManagedDualUpwardControl,
      "enableManagedDualUpwardControl"
    );
  }

  if (record.minimumManagedImprovementBps !== undefined) {
    config.minimumManagedImprovementBps = parseNonNegativeInteger(
      record.minimumManagedImprovementBps,
      "minimumManagedImprovementBps"
    );
  }

  if (record.maxManagedInventoryReleaseBps !== undefined) {
    const parsedMaxManagedInventoryReleaseBps = parseNonNegativeInteger(
      record.maxManagedInventoryReleaseBps,
      "maxManagedInventoryReleaseBps"
    );
    if (parsedMaxManagedInventoryReleaseBps > 10_000) {
      throw new Error("maxManagedInventoryReleaseBps must not exceed 10000");
    }
    config.maxManagedInventoryReleaseBps = parsedMaxManagedInventoryReleaseBps;
  }

  if (record.minimumManagedSensitivityBpsPer10PctRelease !== undefined) {
    config.minimumManagedSensitivityBpsPer10PctRelease = parseNonNegativeInteger(
      record.minimumManagedSensitivityBpsPer10PctRelease,
      "minimumManagedSensitivityBpsPer10PctRelease"
    );
  }

  if (record.simulationSenderAddress !== undefined) {
    config.simulationSenderAddress = parseHexAddress(
      record.simulationSenderAddress,
      "simulationSenderAddress"
    );
  }

  if (record.drawDebtLimitIndex !== undefined) {
    config.drawDebtLimitIndex = parseNonNegativeInteger(
      record.drawDebtLimitIndex,
      "drawDebtLimitIndex"
    );
  }

  if (record.drawDebtLimitIndexes !== undefined) {
    const parsedLimitIndexes = parseIntegerArray(
      record.drawDebtLimitIndexes,
      "drawDebtLimitIndexes"
    );
    if (parsedLimitIndexes.length === 0) {
      throw new Error("drawDebtLimitIndexes must not be empty");
    }
    config.drawDebtLimitIndexes = Array.from(new Set(parsedLimitIndexes));
  }

  if (record.borrowSimulationLookaheadUpdates !== undefined) {
    config.borrowSimulationLookaheadUpdates = parsePositiveInteger(
      record.borrowSimulationLookaheadUpdates,
      "borrowSimulationLookaheadUpdates"
    );
  }

  const drawDebtCollateralAmount = parseOptionalBigInt(
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
    const parsedCollateralAmounts = parseBigIntArray(
      record.drawDebtCollateralAmounts,
      "drawDebtCollateralAmounts"
    );
    if (parsedCollateralAmounts.length === 0) {
      throw new Error("drawDebtCollateralAmounts must not be empty");
    }
    if (parsedCollateralAmounts.some((amount) => amount < 0n)) {
      throw new Error("drawDebtCollateralAmounts must not contain negative values");
    }
    config.drawDebtCollateralAmounts = Array.from(new Set(parsedCollateralAmounts)).sort(
      (left, right) => (left < right ? -1 : left > right ? 1 : 0)
    );
  }

  if (record.enableHeuristicLendSynthesis !== undefined) {
    config.enableHeuristicLendSynthesis = parseBoolean(
      record.enableHeuristicLendSynthesis,
      "enableHeuristicLendSynthesis"
    );
  }

  if (record.enableHeuristicBorrowSynthesis !== undefined) {
    config.enableHeuristicBorrowSynthesis = parseBoolean(
      record.enableHeuristicBorrowSynthesis,
      "enableHeuristicBorrowSynthesis"
    );
  }

  if (record.manualCandidates !== undefined) {
    if (!Array.isArray(record.manualCandidates)) {
      throw new Error("manualCandidates must be an array");
    }

    config.manualCandidates = record.manualCandidates.map((candidate, index) =>
      resolvePlanCandidate(candidate, `manualCandidates[${index}]`)
    );
  }

  return config;
}

export interface CliCommand {
  mode: "run" | "keeperhub";
  configPath?: string;
  snapshotPath?: string;
  payloadPath?: string;
  dryRun: boolean;
  summary: boolean;
}

export function parseCliArgs(argv: string[]): CliCommand {
  const [mode, ...rest] = argv;

  if (mode !== "run" && mode !== "keeperhub") {
    throw new Error("expected first argument to be 'run' or 'keeperhub'");
  }

  let configPath: string | undefined;
  let snapshotPath: string | undefined;
  let payloadPath: string | undefined;
  let dryRun = false;
  let summary = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token === "--summary") {
      summary = true;
      continue;
    }

    const next = rest[index + 1];
    if (!next) {
      throw new Error(`missing value after ${token}`);
    }

    if (token === "--config") {
      configPath = next;
      index += 1;
      continue;
    }

    if (token === "--snapshot") {
      snapshotPath = next;
      index += 1;
      continue;
    }

    if (token === "--payload") {
      payloadPath = next;
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${token}`);
  }

  if (mode === "run" && !configPath) {
    throw new Error("run mode requires --config");
  }

  if (mode === "keeperhub" && !payloadPath) {
    throw new Error("keeperhub mode requires --payload");
  }

  const command: CliCommand = {
    mode,
    dryRun,
    summary
  };

  if (configPath !== undefined) {
    command.configPath = configPath;
  }

  if (snapshotPath !== undefined) {
    command.snapshotPath = snapshotPath;
  }

  if (payloadPath !== undefined) {
    command.payloadPath = payloadPath;
  }

  return command;
}

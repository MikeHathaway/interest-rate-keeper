import {
  type KeeperConfig
} from "./types.js";
import {
  CONFIG_DEFAULTS,
  parseBoolean,
  parseCompletionPolicy,
  parseHexAddress,
  parseIntegerArray,
  parseNonNegativeInteger,
  parseNumber,
  parseObject,
  parseOptionalBigInt,
  parsePositiveBigInt,
  parsePositiveInteger,
  parsePositiveNumber,
  parseString,
  parseToleranceMode,
  parseBigIntArray
} from "./config-parse.js";
import { applyManagedConfigFields } from "./config-managed.js";
import { applySynthesisConfigFields } from "./config-synthesis.js";
import { resolvePlanCandidate } from "./snapshot.js";

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
        ? CONFIG_DEFAULTS.executionBufferBps
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
        ? CONFIG_DEFAULTS.snapshotAgeMaxSeconds
        : parsePositiveNumber(record.snapshotAgeMaxSeconds, "snapshotAgeMaxSeconds"),
    minTimeBeforeRateWindowSeconds:
      record.minTimeBeforeRateWindowSeconds === undefined
        ? CONFIG_DEFAULTS.minTimeBeforeRateWindowSeconds
        : parsePositiveNumber(
            record.minTimeBeforeRateWindowSeconds,
            "minTimeBeforeRateWindowSeconds"
          ),
    minExecutableQuoteTokenAmount:
      record.minExecutableQuoteTokenAmount === undefined
        ? legacyMinExecutableActionAmount ?? CONFIG_DEFAULTS.minExecutableQuoteTokenAmount
        : parsePositiveBigInt(
            record.minExecutableQuoteTokenAmount,
            "minExecutableQuoteTokenAmount"
          ),
    minExecutableBorrowAmount:
      record.minExecutableBorrowAmount === undefined
        ? legacyMinExecutableActionAmount ?? CONFIG_DEFAULTS.minExecutableBorrowAmount
        : parsePositiveBigInt(
            record.minExecutableBorrowAmount,
            "minExecutableBorrowAmount"
          ),
    minExecutableCollateralAmount:
      record.minExecutableCollateralAmount === undefined
        ? legacyMinExecutableActionAmount ?? CONFIG_DEFAULTS.minExecutableCollateralAmount
        : parsePositiveBigInt(
            record.minExecutableCollateralAmount,
            "minExecutableCollateralAmount"
          ),
    recheckBeforeSubmit:
      record.recheckBeforeSubmit === undefined
        ? CONFIG_DEFAULTS.recheckBeforeSubmit
        : parseBoolean(record.recheckBeforeSubmit, "recheckBeforeSubmit"),
    allowHeuristicExecution:
      record.allowHeuristicExecution === undefined
        ? CONFIG_DEFAULTS.allowHeuristicExecution
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

  applySynthesisConfigFields(record, config, {
    parseBoolean,
    parseIntegerArray,
    parseNonNegativeInteger,
    parsePositiveInteger,
    parseOptionalBigInt,
    parseBigIntArray,
    parseHexAddress
  });

  applyManagedConfigFields(record, config, {
    parseBoolean,
    parseIntegerArray,
    parseNonNegativeInteger
  });

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

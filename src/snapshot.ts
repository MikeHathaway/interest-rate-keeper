import { readFile } from "node:fs/promises";

import { withPlanCandidateCapitalMetrics } from "./candidate-metrics.js";
import {
  type AddCollateralStep,
  type AddQuoteStep,
  type DrawDebtStep,
  type ExecutionBufferPolicy,
  type ExecutionStep,
  type HexAddress,
  type PlanCandidate,
  type PoolSnapshot,
  type RemoveCollateralStep,
  type RemoveQuoteStep,
  type RepayDebtStep,
  type UpdateInterestStep
} from "./types.js";

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

  return value;
}

function parseNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return value;
}

function parseInteger(value: unknown, label: string): number {
  const parsed = parseNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  const parsed = parseInteger(value, label);
  if (parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = parseInteger(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function parseBigIntValue(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return BigInt(value.trim());
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }

  throw new Error(`${label} must be integer-like`);
}

function parseNonNegativeBigIntValue(value: unknown, label: string): bigint {
  const parsed = parseBigIntValue(value, label);
  if (parsed < 0n) {
    throw new Error(`${label} must be non-negative`);
  }

  return parsed;
}

function parseAddress(value: unknown, label: string): HexAddress {
  const parsed = parseString(value, label);
  if (!/^0x[a-fA-F0-9]{40}$/.test(parsed)) {
    throw new Error(`${label} must be a hex address`);
  }

  return parsed as HexAddress;
}

function buildBaseStepOptions(
  note: string | undefined,
  bufferPolicy: ExecutionBufferPolicy | undefined
): {
  note?: string;
  bufferPolicy?: ExecutionBufferPolicy;
} {
  const options: {
    note?: string;
    bufferPolicy?: ExecutionBufferPolicy;
  } = {};

  if (note !== undefined) {
    options.note = note;
  }

  if (bufferPolicy !== undefined) {
    options.bufferPolicy = bufferPolicy;
  }

  return options;
}

export function resolveExecutionStep(input: unknown, label = "execution step"): ExecutionStep {
  const record = parseObject(input, label);
  const type = parseString(record.type, `${label}.type`);
  const note =
    record.note === undefined ? undefined : parseString(record.note, `${label}.note`);
  const bufferPolicy =
    record.bufferPolicy === "apply" || record.bufferPolicy === "none"
      ? record.bufferPolicy
      : undefined;

  const shared = buildBaseStepOptions(note, bufferPolicy);

  switch (type) {
    case "ADD_QUOTE":
      return {
        type,
        amount: parseNonNegativeBigIntValue(record.amount, `${label}.amount`),
        bucketIndex: parseNonNegativeInteger(record.bucketIndex, `${label}.bucketIndex`),
        expiry: parsePositiveInteger(record.expiry, `${label}.expiry`),
        ...shared
      } satisfies AddQuoteStep;
    case "REMOVE_QUOTE":
      return {
        type,
        amount: parseNonNegativeBigIntValue(record.amount, `${label}.amount`),
        bucketIndex: parseNonNegativeInteger(record.bucketIndex, `${label}.bucketIndex`),
        ...shared
      } satisfies RemoveQuoteStep;
    case "DRAW_DEBT": {
      const step: DrawDebtStep = {
        type,
        amount: parseNonNegativeBigIntValue(record.amount, `${label}.amount`),
        limitIndex: parseNonNegativeInteger(record.limitIndex, `${label}.limitIndex`),
        ...shared
      };

      if (record.collateralAmount !== undefined) {
        step.collateralAmount = parseNonNegativeBigIntValue(
          record.collateralAmount,
          `${label}.collateralAmount`
        );
      }

      return step;
    }
    case "REPAY_DEBT": {
      const step: RepayDebtStep = {
        type,
        amount: parseNonNegativeBigIntValue(record.amount, `${label}.amount`),
        ...shared
      };

      if (record.collateralAmountToPull !== undefined) {
        step.collateralAmountToPull = parseNonNegativeBigIntValue(
          record.collateralAmountToPull,
          `${label}.collateralAmountToPull`
        );
      }

      if (record.limitIndex !== undefined) {
        step.limitIndex = parseNonNegativeInteger(record.limitIndex, `${label}.limitIndex`);
      }

      if (record.recipient !== undefined) {
        step.recipient = parseAddress(record.recipient, `${label}.recipient`);
      }

      return step;
    }
    case "ADD_COLLATERAL": {
      const step: AddCollateralStep = {
        type,
        amount: parseNonNegativeBigIntValue(record.amount, `${label}.amount`),
        bucketIndex: parseNonNegativeInteger(record.bucketIndex, `${label}.bucketIndex`),
        ...shared
      };

      if (record.expiry !== undefined) {
        step.expiry = parsePositiveInteger(record.expiry, `${label}.expiry`);
      }

      return step;
    }
    case "REMOVE_COLLATERAL": {
      const step: RemoveCollateralStep = {
        type,
        amount: parseNonNegativeBigIntValue(record.amount, `${label}.amount`),
        ...shared
      };

      if (record.bucketIndex !== undefined) {
        step.bucketIndex = parseNonNegativeInteger(record.bucketIndex, `${label}.bucketIndex`);
      }

      return step;
    }
    case "UPDATE_INTEREST":
      return {
        type,
        ...shared
      } satisfies UpdateInterestStep;
    default:
      throw new Error(`${label}.type has unsupported value '${type}'`);
  }
}

export function resolvePlanCandidate(input: unknown, label = "plan candidate"): PlanCandidate {
  const record = parseObject(input, label);
  const rawSteps = record.minimumExecutionSteps;
  if (!Array.isArray(rawSteps)) {
    throw new Error(`${label}.minimumExecutionSteps must be an array`);
  }

  const predictedOutcome = parseString(record.predictedOutcome, `${label}.predictedOutcome`);
  if (
    predictedOutcome !== "STEP_UP" &&
    predictedOutcome !== "STEP_DOWN" &&
    predictedOutcome !== "RESET_TO_TEN" &&
    predictedOutcome !== "NO_CHANGE"
  ) {
    throw new Error(`${label}.predictedOutcome is invalid`);
  }

  const intent = parseString(record.intent, `${label}.intent`);
  if (intent !== "LEND" && intent !== "BORROW" && intent !== "LEND_AND_BORROW") {
    throw new Error(`${label}.intent is invalid`);
  }

  const candidate: PlanCandidate = {
    id: parseString(record.id, `${label}.id`),
    intent,
    minimumExecutionSteps: rawSteps.map((step, index) =>
      resolveExecutionStep(step, `${label}.minimumExecutionSteps[${index}]`)
    ),
    predictedOutcome,
    predictedRateBpsAfterNextUpdate: parseNumber(
      record.predictedRateBpsAfterNextUpdate,
      `${label}.predictedRateBpsAfterNextUpdate`
    ),
    resultingDistanceToTargetBps: parseNumber(
      record.resultingDistanceToTargetBps,
      `${label}.resultingDistanceToTargetBps`
    ),
    quoteTokenDelta: parseBigIntValue(record.quoteTokenDelta, `${label}.quoteTokenDelta`),
    explanation: parseString(record.explanation, `${label}.explanation`)
  };

  if (record.candidateSource !== undefined) {
    const candidateSource = parseString(record.candidateSource, `${label}.candidateSource`);
    if (
      candidateSource !== "simulation" &&
      candidateSource !== "heuristic" &&
      candidateSource !== "manual"
    ) {
      throw new Error(`${label}.candidateSource is invalid`);
    }
    candidate.candidateSource = candidateSource;
  }

  if (record.executionMode !== undefined) {
    const executionMode = parseString(record.executionMode, `${label}.executionMode`);
    if (executionMode !== "supported" && executionMode !== "advisory") {
      throw new Error(`${label}.executionMode is invalid`);
    }
    candidate.executionMode = executionMode;
  }

  if (record.planningRateBps !== undefined) {
    candidate.planningRateBps = parseNumber(record.planningRateBps, `${label}.planningRateBps`);
  }

  if (record.planningLookaheadUpdates !== undefined) {
    candidate.planningLookaheadUpdates = parsePositiveInteger(
      record.planningLookaheadUpdates,
      `${label}.planningLookaheadUpdates`
    );
  }

  if (record.validationSignature !== undefined) {
    candidate.validationSignature = parseString(
      record.validationSignature,
      `${label}.validationSignature`
    );
  }

  return withPlanCandidateCapitalMetrics(candidate);
}

export function resolvePoolSnapshot(input: unknown): PoolSnapshot {
  const record = parseObject(input, "pool snapshot");
  const rawCandidates = record.candidates;
  if (!Array.isArray(rawCandidates)) {
    throw new Error("pool snapshot candidates must be an array");
  }

  const predictedNextOutcome = parseString(
    record.predictedNextOutcome,
    "pool snapshot predictedNextOutcome"
  );
  if (
    predictedNextOutcome !== "STEP_UP" &&
    predictedNextOutcome !== "STEP_DOWN" &&
    predictedNextOutcome !== "RESET_TO_TEN" &&
    predictedNextOutcome !== "NO_CHANGE"
  ) {
    throw new Error("pool snapshot predictedNextOutcome is invalid");
  }

  const snapshot: PoolSnapshot = {
    snapshotFingerprint: parseString(record.snapshotFingerprint, "snapshotFingerprint"),
    poolId: parseString(record.poolId, "poolId"),
    chainId: parseNumber(record.chainId, "chainId"),
    blockNumber: parseBigIntValue(record.blockNumber, "blockNumber"),
    blockTimestamp: parseNumber(record.blockTimestamp, "blockTimestamp"),
    snapshotAgeSeconds: parseNumber(record.snapshotAgeSeconds, "snapshotAgeSeconds"),
    secondsUntilNextRateUpdate: parseNumber(
      record.secondsUntilNextRateUpdate,
      "secondsUntilNextRateUpdate"
    ),
    currentRateBps: parseNumber(record.currentRateBps, "currentRateBps"),
    predictedNextOutcome,
    predictedNextRateBps: parseNumber(
      record.predictedNextRateBps,
      "predictedNextRateBps"
    ),
    candidates: rawCandidates.map((candidate, index) =>
      resolvePlanCandidate(candidate, `candidates[${index}]`)
    )
  };

  if (record.planningRateBps !== undefined) {
    snapshot.planningRateBps = parseNumber(record.planningRateBps, "planningRateBps");
  }

  if (record.planningLookaheadUpdates !== undefined) {
    snapshot.planningLookaheadUpdates = parsePositiveInteger(
      record.planningLookaheadUpdates,
      "planningLookaheadUpdates"
    );
  }

  if (
    record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
  ) {
    snapshot.metadata = record.metadata as Record<string, unknown>;
  }

  return snapshot;
}

export interface SnapshotSource {
  getSnapshot(): Promise<PoolSnapshot>;
}

export class StaticSnapshotSource implements SnapshotSource {
  constructor(private snapshots: PoolSnapshot[]) {}

  async getSnapshot(): Promise<PoolSnapshot> {
    const [next, ...rest] = this.snapshots;
    if (!next) {
      throw new Error("no snapshots available");
    }

    if (rest.length > 0) {
      this.snapshots = rest;
    }

    return structuredClone(next);
  }
}

export class FileSnapshotSource implements SnapshotSource {
  constructor(private readonly path: string) {}

  async getSnapshot(): Promise<PoolSnapshot> {
    const content = await readFile(this.path, "utf8");
    return resolvePoolSnapshot(JSON.parse(content));
  }
}

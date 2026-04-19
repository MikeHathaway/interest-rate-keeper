import {
  type CompletionPolicy,
  type HexAddress,
  type ToleranceMode
} from "../types.js";

export const CONFIG_DEFAULTS = {
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

export type ConfigPrimitiveParsers = {
  parseBoolean: (value: unknown, label: string) => boolean;
  parseIntegerArray: (value: unknown, label: string) => number[];
  parseNonNegativeInteger: (value: unknown, label: string) => number;
  parsePositiveInteger: (value: unknown, label: string) => number;
  parseOptionalBigInt: (value: unknown, label: string) => bigint | undefined;
  parseBigIntArray: (value: unknown, label: string) => bigint[];
  parseHexAddress: (value: unknown, label: string) => HexAddress;
};

export function parseObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }

  return input as Record<string, unknown>;
}

export function parseString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value.trim();
}

export function parseHexAddress(value: unknown, label: string): HexAddress {
  const parsed = parseString(value, label);
  if (!/^0x[a-fA-F0-9]{40}$/.test(parsed)) {
    throw new Error(`${label} must be a hex address`);
  }

  return parsed as HexAddress;
}

export function parseNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return value;
}

export function parsePositiveNumber(value: unknown, label: string): number {
  const parsed = parseNumber(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }

  return parsed;
}

export function parseNonNegativeInteger(value: unknown, label: string): number {
  const parsed = parseNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

export function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = parsePositiveNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

export function parseIntegerArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((item, index) =>
    parseNonNegativeInteger(item, `${label}[${index}]`)
  );
}

export function parseBigIntArray(value: unknown, label: string): bigint[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value.map((item, index) => parseBigIntValue(item, `${label}[${index}]`));
}

export function parseSortedDistinctNonEmptyIntegerArray(
  value: unknown,
  label: string
): number[] {
  const parsed = parseIntegerArray(value, label);
  if (parsed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }

  return Array.from(new Set(parsed)).sort((left, right) => left - right);
}

export function parseDistinctNonEmptyIntegerArray(
  value: unknown,
  label: string
): number[] {
  const parsed = parseIntegerArray(value, label);
  if (parsed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }

  return Array.from(new Set(parsed));
}

export function parseSortedDistinctNonEmptyBigIntArray(
  value: unknown,
  label: string
): bigint[] {
  const parsed = parseBigIntArray(value, label);
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

export function parseOptionalBigInt(
  value: unknown,
  label: string
): bigint | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return parseBigIntValue(value, label);
}

export function parseBigIntValue(value: unknown, label: string): bigint {
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

export function parsePositiveBigInt(value: unknown, label: string): bigint {
  const parsed = parseBigIntValue(value, label);
  if (parsed <= 0n) {
    throw new Error(`${label} must be greater than zero`);
  }

  return parsed;
}

export function parseToleranceMode(value: unknown): ToleranceMode {
  if (value === undefined) {
    return CONFIG_DEFAULTS.toleranceMode;
  }

  if (value === "absolute" || value === "relative") {
    return value;
  }

  throw new Error("toleranceMode must be 'absolute' or 'relative'");
}

export function parseCompletionPolicy(value: unknown): CompletionPolicy {
  if (value === undefined) {
    return CONFIG_DEFAULTS.completionPolicy;
  }

  if (value === "in_band" || value === "next_move_would_overshoot") {
    return value;
  }

  throw new Error(
    "completionPolicy must be 'in_band' or 'next_move_would_overshoot'"
  );
}

export function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${label} must be a boolean`);
}

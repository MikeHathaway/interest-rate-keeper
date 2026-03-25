export function safeJsonStringify(value: unknown, pretty = false): string {
  return JSON.stringify(
    value,
    (_key, candidate) =>
      typeof candidate === "bigint" ? candidate.toString() : candidate,
    pretty ? 2 : undefined
  );
}

import { resolveKeeperConfig } from "./config.js";
import { runCycle, type RunCycleDependencies } from "./run-cycle.js";
import { resolvePoolSnapshot, StaticSnapshotSource } from "./snapshot.js";
import { safeJsonStringify } from "./json.js";

function parseObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }

  return input as Record<string, unknown>;
}

export function resolveKeeperHubPayload(input: unknown): {
  config: ReturnType<typeof resolveKeeperConfig>;
  snapshot: ReturnType<typeof resolvePoolSnapshot>;
} {
  const record = parseObject(input, "keeperhub payload");

  return {
    config: resolveKeeperConfig(record.config),
    snapshot: resolvePoolSnapshot(record.snapshot)
  };
}

export async function runKeeperHubPayload(
  input: unknown,
  dependencies: Omit<RunCycleDependencies, "snapshotSource">
) {
  const payload = resolveKeeperHubPayload(input);
  return runCycle(payload.config, {
    ...dependencies,
    snapshotSource: new StaticSnapshotSource([payload.snapshot, payload.snapshot])
  });
}

export function formatKeeperHubResponse(result: Awaited<ReturnType<typeof runKeeperHubPayload>>): string {
  return safeJsonStringify({
    status: result.status,
    reason: result.reason,
    poolId: result.poolId,
    chainId: result.chainId,
    intent: result.plan.intent,
    transactionHashes: result.transactionHashes,
    failedStepIndex: result.failedStepIndex,
    error: result.error
  });
}

import { resolveKeeperConfig } from "./config.js";
import { runCycle, type RunCycleDependencies } from "./run-cycle.js";
import {
  resolvePoolSnapshot,
  StaticSnapshotSource,
  type SnapshotSource
} from "./snapshot.js";
import { AjnaRpcSnapshotSource } from "./ajna/snapshot.js";
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

class PayloadThenLiveSnapshotSource implements SnapshotSource {
  private firstRead = true;

  constructor(
    private readonly initialSnapshot: ReturnType<typeof resolvePoolSnapshot>,
    private readonly liveSnapshotSource: SnapshotSource
  ) {}

  async getSnapshot() {
    if (this.firstRead) {
      this.firstRead = false;
      return structuredClone(this.initialSnapshot);
    }

    return this.liveSnapshotSource.getSnapshot();
  }
}

export async function runKeeperHubPayload(
  input: unknown,
  dependencies: Omit<RunCycleDependencies, "snapshotSource">,
  options: {
    config?: ReturnType<typeof resolveKeeperConfig>;
  } = {}
) {
  const payload = resolveKeeperHubPayload(input);
  const config = options.config ?? payload.config;
  const canLiveRecheck =
    config.recheckBeforeSubmit &&
    config.poolAddress !== undefined &&
    config.rpcUrl !== undefined;

  const effectiveConfig = canLiveRecheck
    ? config
    : {
        ...config,
        recheckBeforeSubmit: false
      };

  const snapshotSource = canLiveRecheck
    ? new PayloadThenLiveSnapshotSource(
        payload.snapshot,
        new AjnaRpcSnapshotSource(config)
      )
    : new StaticSnapshotSource([payload.snapshot]);

  return runCycle(effectiveConfig, {
    ...dependencies,
    snapshotSource
  });
}

export function formatKeeperHubResponse(result: Awaited<ReturnType<typeof runKeeperHubPayload>>): string {
  return safeJsonStringify({
    status: result.status,
    reason: result.reason,
    poolId: result.poolId,
    chainId: result.chainId,
    intent: result.plan.intent,
    candidateSource: result.plan.selectedCandidateSource,
    candidateExecutionMode: result.plan.selectedCandidateExecutionMode,
    capital: {
      quoteTokenDelta: result.plan.quoteTokenDelta,
      additionalCollateralRequired: result.plan.additionalCollateralRequired,
      netQuoteBorrowed: result.plan.netQuoteBorrowed,
      operatorCapitalRequired: result.plan.operatorCapitalRequired,
      operatorCapitalAtRisk: result.plan.operatorCapitalAtRisk
    },
    transactionHashes: result.transactionHashes,
    failedStepIndex: result.failedStepIndex,
    error: result.error
  });
}

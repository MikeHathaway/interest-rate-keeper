import { appendJsonlLog } from "./log.js";
import { planCycle } from "./planner.js";
import { preSubmitRecheck, validatePlan } from "./policy.js";
import { type ExecutionBackend } from "./execute.js";
import { type KeeperConfig, type CycleResult } from "./types.js";
import { type SnapshotSource } from "./snapshot.js";

export interface RunCycleDependencies {
  snapshotSource: SnapshotSource;
  executor: ExecutionBackend;
}

function buildResultBase(
  status: CycleResult["status"],
  reason: string,
  plan: CycleResult["plan"],
  poolId: string,
  chainId: number,
  snapshotFingerprint: string
): CycleResult {
  return {
    status,
    reason,
    poolId,
    chainId,
    snapshotFingerprint,
    plan,
    transactionHashes: [],
    executedSteps: []
  };
}

async function writeLogIfNeeded(
  config: KeeperConfig,
  result: CycleResult
): Promise<CycleResult> {
  if (!config.logPath) {
    return result;
  }

  try {
    await appendJsonlLog(config.logPath, {
      ts: new Date().toISOString(),
      result
    });
    return result;
  } catch (error) {
    return {
      ...result,
      logWriteError: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runCycle(
  config: KeeperConfig,
  dependencies: RunCycleDependencies
): Promise<CycleResult> {
  const planningSnapshot = await dependencies.snapshotSource.getSnapshot();
  const plan = planCycle(planningSnapshot, config);

  if (plan.intent === "NO_OP" && plan.requiredSteps.length === 0) {
    return writeLogIfNeeded(
      config,
      buildResultBase(
        "NO_OP",
        plan.reason,
        plan,
        planningSnapshot.poolId,
        planningSnapshot.chainId,
        planningSnapshot.snapshotFingerprint
      )
    );
  }

  const validationFailure = validatePlan(plan, planningSnapshot, config);
  if (validationFailure) {
    return writeLogIfNeeded(
      config,
      buildResultBase(
        "ABORTED",
        validationFailure.reason,
        plan,
        planningSnapshot.poolId,
        planningSnapshot.chainId,
        planningSnapshot.snapshotFingerprint
      )
    );
  }

  const executionSnapshot = config.recheckBeforeSubmit
    ? await dependencies.snapshotSource.getSnapshot()
    : planningSnapshot;

  if (config.recheckBeforeSubmit) {
    const recheckFailure = preSubmitRecheck(
      plan,
      planningSnapshot,
      executionSnapshot,
      config
    );
    if (recheckFailure) {
      return writeLogIfNeeded(
        config,
        buildResultBase(
          "ABORTED",
          recheckFailure.reason,
          plan,
          executionSnapshot.poolId,
          executionSnapshot.chainId,
          executionSnapshot.snapshotFingerprint
        )
      );
    }
  }

  const execution = await dependencies.executor.execute(plan, {
    config,
    snapshot: executionSnapshot,
    plan
  });

  const base = buildResultBase(
    execution.status,
    execution.status === "EXECUTED"
      ? "cycle executed successfully"
      : execution.status === "PARTIAL_FAILURE"
        ? "cycle partially executed before a step failed"
        : execution.error,
    plan,
    executionSnapshot.poolId,
    executionSnapshot.chainId,
    executionSnapshot.snapshotFingerprint
  );

  const result: CycleResult = {
    ...base,
    transactionHashes: execution.transactionHashes,
    executedSteps: execution.executedSteps
  };

  if (execution.status === "FAILED" || execution.status === "PARTIAL_FAILURE") {
    result.error = execution.error;
    if (execution.failedStepIndex !== undefined) {
      result.failedStepIndex = execution.failedStepIndex;
    }
  }

  return writeLogIfNeeded(config, result);
}

import { appendJsonlLog } from "./log.js";
import { stepsUseManagedDual } from "./managed-controls.js";
import { derivePlanCandidateCapitalMetrics } from "./candidate-metrics.js";
import { planCycle } from "./planner.js";
import {
  normalizeStepForComparison,
  preSubmitRecheck,
  validatePlan
} from "./policy.js";
import { type ExecutionBackend } from "./execute.js";
import {
  type CyclePlan,
  type CycleResult,
  type ExecutionOutcome,
  type ExecutionStep,
  type KeeperConfig,
  type PoolSnapshot
} from "./types.js";
import { type SnapshotSource } from "./snapshot.js";

export interface RunCycleDependencies {
  snapshotSource: SnapshotSource;
  executor: ExecutionBackend;
}

function stepsEquivalent(left: ExecutionStep, right: ExecutionStep): boolean {
  return normalizeStepForComparison(left) === normalizeStepForComparison(right);
}

function buildSingleStepPlan(plan: CyclePlan, step: ExecutionStep): CyclePlan {
  return {
    ...plan,
    requiredSteps: [step]
  };
}

function buildPrefixPlan(
  plan: CyclePlan,
  executedSteps: ExecutionStep[],
  freshSnapshot: PoolSnapshot
): CyclePlan {
  const capital = derivePlanCandidateCapitalMetrics(executedSteps);
  return {
    ...plan,
    requiredSteps: executedSteps.slice(),
    predictedRateBpsAfterNextUpdate: freshSnapshot.predictedNextRateBps,
    ...(freshSnapshot.planningRateBps === undefined
      ? {}
      : { planningRateBps: freshSnapshot.planningRateBps }),
    quoteTokenDelta: capital.quoteTokenDelta,
    quoteInventoryDeployed: capital.quoteInventoryDeployed,
    quoteInventoryReleased: capital.quoteInventoryReleased,
    additionalCollateralRequired: capital.additionalCollateralRequired,
    netQuoteBorrowed: capital.netQuoteBorrowed,
    operatorCapitalRequired: capital.operatorCapitalRequired,
    operatorCapitalAtRisk: capital.operatorCapitalAtRisk
  };
}

function buildExecutionFailure(
  failedStep: ExecutionStep,
  failedStepIndex: number,
  transactionHashes: string[],
  executedSteps: ExecutionStep[],
  error: string
): ExecutionOutcome {
  if (executedSteps.length === 0) {
    return {
      status: "FAILED",
      transactionHashes,
      executedSteps,
      failedStep,
      failedStepIndex,
      error
    };
  }

  return {
    status: "PARTIAL_FAILURE",
    transactionHashes,
    executedSteps,
    failedStep,
    failedStepIndex,
    error
  };
}

async function executePlan(
  config: KeeperConfig,
  plan: CyclePlan,
  executionSnapshot: PoolSnapshot,
  dependencies: RunCycleDependencies
): Promise<{
  execution: ExecutionOutcome;
  finalSnapshot: PoolSnapshot;
}> {
  if (
    dependencies.executor.dryRun === true ||
    !config.recheckBeforeSubmit ||
    plan.requiredSteps.length <= 1
  ) {
    return {
      execution: await dependencies.executor.execute(plan, {
        config,
        snapshot: executionSnapshot,
        plan
      }),
      finalSnapshot: executionSnapshot
    };
  }

  let latestSnapshot = executionSnapshot;
  const executedSteps: ExecutionStep[] = [];
  const transactionHashes: string[] = [];

  for (const [stepIndex, step] of plan.requiredSteps.entries()) {
    const singleStepPlan = buildSingleStepPlan(plan, step);
    const stepExecution = await dependencies.executor.execute(singleStepPlan, {
      config,
      snapshot: latestSnapshot,
      plan: singleStepPlan
    });

    transactionHashes.push(...stepExecution.transactionHashes);
    executedSteps.push(...stepExecution.executedSteps);

    if (stepExecution.status !== "EXECUTED") {
      return {
        execution: buildExecutionFailure(
          step,
          stepIndex,
          transactionHashes,
          executedSteps,
          stepExecution.status === "FAILED" || stepExecution.status === "PARTIAL_FAILURE"
            ? stepExecution.error
            : `step ${step.type} failed`
        ),
        finalSnapshot: latestSnapshot
      };
    }

    if (stepIndex === plan.requiredSteps.length - 1) {
      continue;
    }

    const nextExpectedStep = plan.requiredSteps[stepIndex + 1];
    if (!nextExpectedStep) {
      break;
    }

    const freshSnapshot = await dependencies.snapshotSource.getSnapshot();

    if (stepsUseManagedDual(plan.requiredSteps)) {
      const prefixPlan = buildPrefixPlan(plan, executedSteps, freshSnapshot);
      const prefixFailure = validatePlan(prefixPlan, freshSnapshot, config);
      if (prefixFailure) {
        return {
          execution: buildExecutionFailure(
            nextExpectedStep,
            stepIndex + 1,
            transactionHashes,
            executedSteps,
            `dual prefix would not satisfy managed guards on its own: ${prefixFailure.reason}`
          ),
          finalSnapshot: freshSnapshot
        };
      }
    }

    const replanned = planCycle(freshSnapshot, config);
    const revalidationFailure = validatePlan(replanned, freshSnapshot, config);
    if (revalidationFailure) {
      return {
        execution: buildExecutionFailure(
          nextExpectedStep,
          stepIndex + 1,
          transactionHashes,
          executedSteps,
          revalidationFailure.reason
        ),
        finalSnapshot: freshSnapshot
      };
    }

    const nextReplannedStep = replanned.requiredSteps[0];
    if (!nextReplannedStep) {
      return {
        execution: {
          status: "EXECUTED",
          transactionHashes,
          executedSteps
        },
        finalSnapshot: freshSnapshot
      };
    }

    if (!stepsEquivalent(nextReplannedStep, nextExpectedStep)) {
      return {
        execution: buildExecutionFailure(
          nextExpectedStep,
          stepIndex + 1,
          transactionHashes,
          executedSteps,
          "remaining step is no longer valid after recheck"
        ),
        finalSnapshot: freshSnapshot
      };
    }

    latestSnapshot = freshSnapshot;
  }

  return {
    execution: {
      status: "EXECUTED",
      transactionHashes,
      executedSteps
    },
    finalSnapshot: latestSnapshot
  };
}

function buildResultBase(
  dryRun: boolean,
  status: CycleResult["status"],
  reason: string,
  plan: CycleResult["plan"],
  poolId: string,
  chainId: number,
  snapshotFingerprint: string
): CycleResult {
  return {
    dryRun,
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
  const dryRun = dependencies.executor.dryRun === true;
  const planningSnapshot = await dependencies.snapshotSource.getSnapshot();
  const plan = planCycle(planningSnapshot, config);

  if (plan.intent === "NO_OP" && plan.requiredSteps.length === 0) {
    return writeLogIfNeeded(
      config,
      buildResultBase(
        dryRun,
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
        dryRun,
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
          dryRun,
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

  const { execution, finalSnapshot } = await executePlan(
    config,
    plan,
    executionSnapshot,
    dependencies
  );

  const base = buildResultBase(
    dryRun,
    execution.status,
    execution.status === "EXECUTED"
      ? dryRun
        ? "cycle dry-run completed successfully"
        : "cycle executed successfully"
      : execution.status === "PARTIAL_FAILURE"
        ? "cycle partially executed before a step failed"
        : execution.error,
    plan,
    finalSnapshot.poolId,
    finalSnapshot.chainId,
    finalSnapshot.snapshotFingerprint
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

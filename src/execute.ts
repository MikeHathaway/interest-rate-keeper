import {
  type CyclePlan,
  type ExecutionFailure,
  type ExecutionOutcome,
  type ExecutionPartialFailure,
  type ExecutionStep,
  type KeeperConfig,
  type PoolSnapshot
} from "./types.js";

export interface ExecutionContext {
  config: KeeperConfig;
  snapshot: PoolSnapshot;
  plan: CyclePlan;
}

export interface ExecutionBackend {
  readonly dryRun?: boolean;
  execute(plan: CyclePlan, context: ExecutionContext): Promise<ExecutionOutcome>;
}

export class DryRunExecutionBackend implements ExecutionBackend {
  readonly dryRun = true;

  async execute(plan: CyclePlan): Promise<ExecutionOutcome> {
    return {
      status: "EXECUTED",
      transactionHashes: [],
      executedSteps: plan.requiredSteps,
      metadata: {
        dryRun: true
      }
    };
  }
}

export interface StepHandlerResult {
  transactionHash?: string;
  metadata?: Record<string, unknown>;
}

export type StepHandler = (
  step: ExecutionStep,
  context: ExecutionContext & { stepIndex: number }
) => Promise<StepHandlerResult>;

function buildFailureOutcome(
  index: number,
  step: ExecutionStep,
  transactionHashes: string[],
  executedSteps: ExecutionStep[],
  error: string
): ExecutionFailure | ExecutionPartialFailure {
  if (index === 0) {
    return {
      status: "FAILED",
      transactionHashes,
      executedSteps,
      failedStep: step,
      failedStepIndex: index,
      error
    };
  }

  return {
    status: "PARTIAL_FAILURE",
    transactionHashes,
    executedSteps,
    failedStep: step,
    failedStepIndex: index,
    error
  };
}

export class StepwiseExecutionBackend implements ExecutionBackend {
  constructor(
    private readonly handlers: Partial<Record<ExecutionStep["type"], StepHandler>>
  ) {}

  async execute(plan: CyclePlan, context: ExecutionContext): Promise<ExecutionOutcome> {
    const executedSteps: ExecutionStep[] = [];
    const transactionHashes: string[] = [];

    for (const [index, step] of plan.requiredSteps.entries()) {
      const handler = this.handlers[step.type];
      if (!handler) {
        const error = `no handler registered for step type ${step.type}`;
        return buildFailureOutcome(index, step, transactionHashes, executedSteps, error);
      }

      try {
        const result = await handler(step, { ...context, stepIndex: index });
        executedSteps.push(step);
        if (result.transactionHash) {
          transactionHashes.push(result.transactionHash);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildFailureOutcome(index, step, transactionHashes, executedSteps, message);
      }
    }

    return {
      status: "EXECUTED",
      transactionHashes,
      executedSteps
    };
  }
}

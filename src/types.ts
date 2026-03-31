export type HexAddress = `0x${string}`;

export type KeeperIntent =
  | "NO_OP"
  | "LEND"
  | "BORROW"
  | "LEND_AND_BORROW";

export type RateMoveOutcome =
  | "STEP_UP"
  | "STEP_DOWN"
  | "RESET_TO_TEN"
  | "NO_CHANGE";

export type CompletionPolicy = "in_band" | "next_move_would_overshoot";
export type ToleranceMode = "absolute" | "relative";
export type ExecutionBufferPolicy = "apply" | "none";

export interface TargetBand {
  minRateBps: number;
  maxRateBps: number;
}

interface BaseExecutionStep {
  bufferPolicy?: ExecutionBufferPolicy;
  note?: string;
}

export interface AddQuoteStep extends BaseExecutionStep {
  type: "ADD_QUOTE";
  amount: bigint;
  bucketIndex: number;
  expiry: number;
}

export interface RemoveQuoteStep extends BaseExecutionStep {
  type: "REMOVE_QUOTE";
  amount: bigint;
  bucketIndex: number;
}

export interface DrawDebtStep extends BaseExecutionStep {
  type: "DRAW_DEBT";
  amount: bigint;
  limitIndex: number;
  collateralAmount?: bigint;
}

export interface RepayDebtStep extends BaseExecutionStep {
  type: "REPAY_DEBT";
  amount: bigint;
  collateralAmountToPull?: bigint;
  limitIndex?: number;
  recipient?: HexAddress;
}

export interface AddCollateralStep extends BaseExecutionStep {
  type: "ADD_COLLATERAL";
  amount: bigint;
  bucketIndex: number;
  expiry?: number;
}

export interface RemoveCollateralStep extends BaseExecutionStep {
  type: "REMOVE_COLLATERAL";
  amount: bigint;
  bucketIndex?: number;
}

export interface UpdateInterestStep extends BaseExecutionStep {
  type: "UPDATE_INTEREST";
}

export type ExecutionStep =
  | AddQuoteStep
  | RemoveQuoteStep
  | DrawDebtStep
  | RepayDebtStep
  | AddCollateralStep
  | RemoveCollateralStep
  | UpdateInterestStep;

export interface PlanCandidate {
  id: string;
  intent: Exclude<KeeperIntent, "NO_OP">;
  minimumExecutionSteps: ExecutionStep[];
  predictedOutcome: RateMoveOutcome;
  predictedRateBpsAfterNextUpdate: number;
  resultingDistanceToTargetBps: number;
  quoteTokenDelta: bigint;
  additionalCollateralRequired?: bigint;
  netQuoteBorrowed?: bigint;
  operatorCapitalRequired?: bigint;
  operatorCapitalAtRisk?: bigint;
  explanation: string;
  planningRateBps?: number;
  planningLookaheadUpdates?: number;
  validationSignature?: string;
}

export interface PoolSnapshot {
  snapshotFingerprint: string;
  poolId: string;
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: number;
  snapshotAgeSeconds: number;
  secondsUntilNextRateUpdate: number;
  currentRateBps: number;
  predictedNextOutcome: RateMoveOutcome;
  predictedNextRateBps: number;
  planningRateBps?: number;
  planningLookaheadUpdates?: number;
  candidates: PlanCandidate[];
  metadata?: Record<string, unknown>;
}

export interface KeeperConfig {
  chainId: number;
  poolId: string;
  poolAddress?: HexAddress;
  rpcUrl?: string;
  borrowerAddress?: HexAddress;
  recipientAddress?: HexAddress;
  targetRateBps: number;
  toleranceBps: number;
  toleranceMode: ToleranceMode;
  completionPolicy: CompletionPolicy;
  executionBufferBps: number;
  maxQuoteTokenExposure: bigint;
  maxBorrowExposure: bigint;
  snapshotAgeMaxSeconds: number;
  minTimeBeforeRateWindowSeconds: number;
  minExecutableActionQuoteToken: bigint;
  maxGasCostWei?: bigint;
  recheckBeforeSubmit: boolean;
  addQuoteBucketIndex?: number;
  addQuoteBucketIndexes?: number[];
  addQuoteExpirySeconds?: number;
  enableSimulationBackedLendSynthesis?: boolean;
  enableSimulationBackedBorrowSynthesis?: boolean;
  simulationSenderAddress?: HexAddress;
  drawDebtLimitIndex?: number;
  drawDebtLimitIndexes?: number[];
  drawDebtCollateralAmount?: bigint;
  drawDebtCollateralAmounts?: bigint[];
  borrowSimulationLookaheadUpdates?: number;
  enableHeuristicLendSynthesis?: boolean;
  enableHeuristicBorrowSynthesis?: boolean;
  logPath?: string;
  manualCandidates?: PlanCandidate[];
}

export interface CyclePlan {
  intent: KeeperIntent;
  reason: string;
  targetBand: TargetBand;
  selectedCandidateId?: string;
  requiredSteps: ExecutionStep[];
  predictedOutcomeAfterPlan: RateMoveOutcome;
  predictedRateBpsAfterNextUpdate: number;
  quoteTokenDelta: bigint;
  additionalCollateralRequired: bigint;
  netQuoteBorrowed: bigint;
  operatorCapitalRequired: bigint;
  operatorCapitalAtRisk: bigint;
}

export interface GuardFailure {
  code:
    | "STALE_SNAPSHOT"
    | "UNSAFE_TIME_WINDOW"
    | "QUOTE_CAP_EXCEEDED"
    | "BORROW_CAP_EXCEEDED"
    | "MIN_EXECUTION_AMOUNT"
    | "POOL_STATE_CHANGED"
    | "CANDIDATE_INVALIDATED";
  reason: string;
}

export interface ExecutionSuccess {
  status: "EXECUTED";
  transactionHashes: string[];
  executedSteps: ExecutionStep[];
  metadata?: Record<string, unknown>;
}

export interface ExecutionPartialFailure {
  status: "PARTIAL_FAILURE";
  transactionHashes: string[];
  executedSteps: ExecutionStep[];
  failedStep: ExecutionStep;
  failedStepIndex: number;
  error: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionFailure {
  status: "FAILED";
  transactionHashes: string[];
  executedSteps: ExecutionStep[];
  failedStep?: ExecutionStep;
  failedStepIndex?: number;
  error: string;
  metadata?: Record<string, unknown>;
}

export type ExecutionOutcome =
  | ExecutionSuccess
  | ExecutionPartialFailure
  | ExecutionFailure;

export type CycleStatus =
  | "NO_OP"
  | "ABORTED"
  | "EXECUTED"
  | "PARTIAL_FAILURE"
  | "FAILED";

export interface CycleResult {
  status: CycleStatus;
  reason: string;
  poolId: string;
  chainId: number;
  snapshotFingerprint: string;
  plan: CyclePlan;
  transactionHashes: string[];
  executedSteps: ExecutionStep[];
  failedStepIndex?: number;
  error?: string;
  logWriteError?: string;
}

import { keccak256, stringToHex, type Hex } from "viem";

import { withPlanCandidateCapitalMetrics } from "../candidate-metrics.js";
import {
  type AddQuoteStep,
  type DrawDebtStep,
  type ExecutionStep,
  type HexAddress,
  type KeeperConfig,
  type PlanCandidate,
  type RemoveQuoteStep,
  type RateMoveOutcome
} from "../types.js";
import { resolveAjnaSignerAddress } from "./runtime.js";
import {
  type AjnaRatePrediction,
  type AjnaRateState,
  RESET_RATE_WAD
} from "./rate-state.js";

export const DEFAULT_ADD_QUOTE_EXPIRY_SECONDS = 60 * 60;

export interface SimulationAccountState {
  simulationSenderAddress: HexAddress;
  borrowerAddress: HexAddress;
  quoteTokenBalance?: bigint;
  quoteTokenAllowance?: bigint;
  collateralBalance?: bigint;
  collateralAllowance?: bigint;
  lenderBucketStates?: SimulationLenderBucketState[];
  lenderBucketStateSignature?: string;
}

export interface SimulationLenderBucketState {
  bucketIndex: number;
  lpBalance: bigint;
  depositTime: bigint;
  lpAccumulator: bigint;
  availableCollateral: bigint;
  bankruptcyTime: bigint;
  bucketDeposit: bigint;
  bucketScale: bigint;
  maxWithdrawableQuoteAmount: bigint;
}

export interface AjnaPoolStateRead {
  blockNumber: bigint;
  blockTimestamp: number;
  rateState: AjnaRateState;
  prediction: AjnaRatePrediction;
  immediatePrediction: AjnaRatePrediction;
  inflatorWad: bigint;
  totalT0Debt: bigint;
  totalT0DebtInAuction: bigint;
  t0Debt2ToCollateralWad: bigint;
  meaningfulDepositThresholdFenwickIndex?: number;
  quoteTokenAddress: HexAddress;
  collateralAddress: HexAddress;
  quoteTokenScale: bigint;
  poolType: number;
  borrowerState?: {
    borrowerAddress: HexAddress;
    t0Debt: bigint;
    collateral: bigint;
    npTpRatio: bigint;
  };
  loansState?: {
    maxBorrower: HexAddress;
    maxT0DebtToCollateral: bigint;
    noOfLoans: bigint;
  };
}

export interface LendSimulationPathResult {
  firstRateWadAfterNextUpdate: bigint;
  firstRateBpsAfterNextUpdate: number;
  firstOutcome: RateMoveOutcome;
  terminalRateBps: number;
  terminalDistanceToTargetBps: number;
}

export type BorrowSimulationPathResult = LendSimulationPathResult;
export type DualSimulationPathResult = BorrowSimulationPathResult;

export interface BorrowSimulationSynthesisResult {
  candidate?: PlanCandidate;
  baselinePlanningRateBps?: number;
  planningLookaheadUpdates?: number;
}

export interface LendSimulationSynthesisResult {
  candidate?: PlanCandidate;
  baselinePlanningRateBps?: number;
  planningLookaheadUpdates?: number;
}

export function smallestBigInt(...values: bigint[]): bigint {
  if (values.length === 0) {
    throw new Error("smallestBigInt requires at least one value");
  }

  return values.reduce((smallest, value) => (value < smallest ? value : smallest));
}

export function predictionChanged(
  baseline: AjnaRatePrediction,
  candidate: AjnaRatePrediction
): boolean {
  return (
    baseline.predictedOutcome !== candidate.predictedOutcome ||
    baseline.predictedNextRateWad !== candidate.predictedNextRateWad
  );
}

export function addQuoteToRateState(
  state: AjnaRateState,
  quoteTokenAmount: bigint,
  quoteTokenScale: bigint
): AjnaRateState {
  return {
    ...state,
    depositEmaWad: state.depositEmaWad + quoteTokenAmount * quoteTokenScale
  };
}

export function drawDebtIntoRateState(
  state: AjnaRateState,
  debtAmountWad: bigint,
  collateralAmountWad: bigint
): AjnaRateState {
  return {
    ...state,
    currentDebtWad: state.currentDebtWad + debtAmountWad,
    debtEmaWad: state.debtEmaWad + debtAmountWad,
    debtColEmaWad: state.debtColEmaWad + collateralAmountWad
  };
}

export function extractDrawDebtStep(
  candidate: PlanCandidate | undefined
): DrawDebtStep | undefined {
  const drawDebtStep = candidate?.minimumExecutionSteps.find(
    (step): step is DrawDebtStep => step.type === "DRAW_DEBT"
  );

  return drawDebtStep;
}

export function extractAddQuoteStep(
  candidate: PlanCandidate | undefined
): AddQuoteStep | undefined {
  const addQuoteStep = candidate?.minimumExecutionSteps.find(
    (step): step is AddQuoteStep => step.type === "ADD_QUOTE"
  );

  return addQuoteStep;
}

export function extractRemoveQuoteStep(
  candidate: PlanCandidate | undefined
): RemoveQuoteStep | undefined {
  const removeQuoteStep = candidate?.minimumExecutionSteps.find(
    (step): step is RemoveQuoteStep => step.type === "REMOVE_QUOTE"
  );

  return removeQuoteStep;
}

export function finalizeCandidate(candidate: PlanCandidate): PlanCandidate {
  return withPlanCandidateCapitalMetrics(candidate);
}

export function resolveMinimumQuoteActionAmount(config: KeeperConfig): bigint {
  return config.minExecutableQuoteTokenAmount > 0n ? config.minExecutableQuoteTokenAmount : 1n;
}

export function resolveMinimumBorrowActionAmount(config: KeeperConfig): bigint {
  return config.minExecutableBorrowAmount > 0n ? config.minExecutableBorrowAmount : 1n;
}

export function resolveSimulationSenderAddress(config: KeeperConfig): HexAddress {
  if (config.simulationSenderAddress) {
    return config.simulationSenderAddress;
  }

  const signerAddress = resolveAjnaSignerAddress();
  if (!signerAddress) {
    throw new Error(
      "simulation-backed synthesis requires simulationSenderAddress or AJNA_KEEPER_PRIVATE_KEY/PRIVATE_KEY"
    );
  }

  return signerAddress;
}

export function resolveSimulationBorrowerAddress(
  config: KeeperConfig,
  simulationSenderAddress: HexAddress
): HexAddress {
  return config.borrowerAddress ?? simulationSenderAddress;
}

export function deriveRateMoveOutcome(
  previousRateWad: bigint,
  updatedRateWad: bigint
): RateMoveOutcome {
  if (updatedRateWad === RESET_RATE_WAD && previousRateWad > RESET_RATE_WAD) {
    return "RESET_TO_TEN";
  }

  if (updatedRateWad > previousRateWad) {
    return "STEP_UP";
  }

  if (updatedRateWad < previousRateWad) {
    return "STEP_DOWN";
  }

  return "NO_CHANGE";
}

export function resolveBorrowSimulationLookaheadUpdates(config: KeeperConfig): number {
  return config.borrowSimulationLookaheadUpdates ?? 1;
}

export function serializeExecutionStepForValidation(step: ExecutionStep): string {
  switch (step.type) {
    case "ADD_QUOTE":
      return [
        step.type,
        step.amount.toString(),
        String(step.bucketIndex),
        String(step.expiry),
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "REMOVE_QUOTE":
      return [
        step.type,
        step.amount.toString(),
        String(step.bucketIndex),
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "DRAW_DEBT":
      return [
        step.type,
        step.amount.toString(),
        String(step.limitIndex),
        step.collateralAmount?.toString() ?? "-",
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "REPAY_DEBT":
      return [
        step.type,
        step.amount.toString(),
        step.collateralAmountToPull?.toString() ?? "-",
        step.limitIndex === undefined ? "-" : String(step.limitIndex),
        step.recipient ?? "-",
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "ADD_COLLATERAL":
      return [
        step.type,
        step.amount.toString(),
        String(step.bucketIndex),
        step.expiry === undefined ? "-" : String(step.expiry),
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "REMOVE_COLLATERAL":
      return [
        step.type,
        step.amount.toString(),
        step.bucketIndex === undefined ? "-" : String(step.bucketIndex),
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "UPDATE_INTEREST":
      return [step.type, step.bufferPolicy ?? "-", step.note ?? "-"].join(":");
  }
}

export function buildSnapshotFingerprint(
  poolAddress: HexAddress,
  blockNumber: bigint,
  state: AjnaRateState
): Hex {
  return keccak256(
    stringToHex(
      [
        poolAddress,
        blockNumber.toString(),
        state.currentRateWad.toString(),
        state.currentDebtWad.toString(),
        state.debtEmaWad.toString(),
        state.depositEmaWad.toString(),
        state.debtColEmaWad.toString(),
        state.lupt0DebtEmaWad.toString(),
        state.lastInterestRateUpdateTimestamp.toString(),
        state.nowTimestamp.toString()
      ].join(":")
    )
  );
}

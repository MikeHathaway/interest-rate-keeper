import { resolveCandidateCapitalMetrics } from "../candidate-metrics.js";
import { type KeeperConfig, type PlanCandidate } from "../types.js";
import { type AjnaRateState, hasUninitializedAjnaEmaState } from "./rate-state.js";

const DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES = 3;
const PREWINDOW_BORROW_INTERMEDIATE_LOOKAHEAD_UPDATES = 2;

function collateralAmountForCandidate(candidate: PlanCandidate): bigint {
  return candidate.minimumExecutionSteps.reduce((total, step) => {
    if (step.type === "DRAW_DEBT") {
      return total + (step.collateralAmount ?? 0n);
    }

    if (step.type === "ADD_COLLATERAL") {
      return total + step.amount;
    }

    return total;
  }, 0n);
}

export function compareCandidatePreference(left: PlanCandidate, right: PlanCandidate): number {
  const leftCapital = resolveCandidateCapitalMetrics(left);
  const rightCapital = resolveCandidateCapitalMetrics(right);
  const leftInBand = left.resultingDistanceToTargetBps === 0 ? 0 : 1;
  const rightInBand = right.resultingDistanceToTargetBps === 0 ? 0 : 1;
  if (leftInBand !== rightInBand) {
    return leftInBand - rightInBand;
  }

  if (left.resultingDistanceToTargetBps !== right.resultingDistanceToTargetBps) {
    return left.resultingDistanceToTargetBps - right.resultingDistanceToTargetBps;
  }

  if (leftCapital.operatorCapitalRequired !== rightCapital.operatorCapitalRequired) {
    return leftCapital.operatorCapitalRequired < rightCapital.operatorCapitalRequired ? -1 : 1;
  }

  if (leftCapital.operatorCapitalAtRisk !== rightCapital.operatorCapitalAtRisk) {
    return leftCapital.operatorCapitalAtRisk < rightCapital.operatorCapitalAtRisk ? -1 : 1;
  }

  if (leftCapital.additionalCollateralRequired !== rightCapital.additionalCollateralRequired) {
    return leftCapital.additionalCollateralRequired <
      rightCapital.additionalCollateralRequired
      ? -1
      : 1;
  }

  if (leftCapital.quoteTokenDelta !== rightCapital.quoteTokenDelta) {
    return leftCapital.quoteTokenDelta < rightCapital.quoteTokenDelta ? -1 : 1;
  }

  const leftCollateral = collateralAmountForCandidate(left);
  const rightCollateral = collateralAmountForCandidate(right);
  if (leftCollateral !== rightCollateral) {
    return leftCollateral < rightCollateral ? -1 : 1;
  }

  return left.id.localeCompare(right.id);
}

export function resolveBorrowSimulationLookaheadAttempts(config: KeeperConfig): number[] {
  if (config.borrowSimulationLookaheadUpdates !== undefined) {
    return [config.borrowSimulationLookaheadUpdates];
  }

  return [1, DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES];
}

export function resolveTimedBorrowSimulationLookaheadAttempts(
  config: KeeperConfig,
  secondsUntilNextRateUpdate?: number,
  rateState?: AjnaRateState
): number[] {
  if (config.borrowSimulationLookaheadUpdates !== undefined) {
    return [config.borrowSimulationLookaheadUpdates];
  }

  if (secondsUntilNextRateUpdate !== undefined && secondsUntilNextRateUpdate > 0) {
    return [
      1,
      PREWINDOW_BORROW_INTERMEDIATE_LOOKAHEAD_UPDATES,
      DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES
    ];
  }

  if (rateState && !hasUninitializedAjnaEmaState(rateState)) {
    return [DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES];
  }

  return [1, DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES];
}

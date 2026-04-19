import {
  type ExecutionStep,
  type PlanCandidate
} from "../types.js";

export interface PlanCandidateCapitalMetrics {
  quoteTokenDelta: bigint;
  quoteInventoryDeployed: bigint;
  quoteInventoryReleased: bigint;
  additionalCollateralRequired: bigint;
  netQuoteBorrowed: bigint;
  operatorCapitalRequired: bigint;
  operatorCapitalAtRisk: bigint;
}

export function derivePlanCandidateCapitalMetrics(
  steps: readonly ExecutionStep[]
): PlanCandidateCapitalMetrics {
  let quoteTokenDelta = 0n;
  let quoteInventoryDeployed = 0n;
  let quoteInventoryReleased = 0n;
  let additionalCollateralRequired = 0n;
  let netQuoteBorrowed = 0n;
  let operatorCapitalRequired = 0n;
  let operatorCapitalAtRisk = 0n;

  for (const step of steps) {
    switch (step.type) {
      case "ADD_QUOTE":
        quoteTokenDelta += step.amount;
        quoteInventoryDeployed += step.amount;
        netQuoteBorrowed -= step.amount;
        operatorCapitalRequired += step.amount;
        operatorCapitalAtRisk += step.amount;
        break;
      case "REMOVE_QUOTE":
        quoteTokenDelta += step.amount;
        quoteInventoryReleased += step.amount;
        netQuoteBorrowed += step.amount;
        operatorCapitalAtRisk -= step.amount;
        break;
      case "DRAW_DEBT": {
        const collateralAmount = step.collateralAmount ?? 0n;
        quoteTokenDelta += step.amount;
        additionalCollateralRequired += collateralAmount;
        netQuoteBorrowed += step.amount;
        operatorCapitalRequired += collateralAmount;
        operatorCapitalAtRisk += collateralAmount;
        break;
      }
      case "REPAY_DEBT":
        quoteTokenDelta += step.amount;
        netQuoteBorrowed -= step.amount;
        operatorCapitalRequired += step.amount;
        operatorCapitalAtRisk -= step.collateralAmountToPull ?? 0n;
        break;
      case "ADD_COLLATERAL":
        additionalCollateralRequired += step.amount;
        operatorCapitalRequired += step.amount;
        operatorCapitalAtRisk += step.amount;
        break;
      case "REMOVE_COLLATERAL":
        operatorCapitalAtRisk -= step.amount;
        break;
      case "UPDATE_INTEREST":
        break;
    }
  }

  return {
    quoteTokenDelta,
    quoteInventoryDeployed,
    quoteInventoryReleased,
    additionalCollateralRequired,
    netQuoteBorrowed,
    operatorCapitalRequired,
    operatorCapitalAtRisk: operatorCapitalAtRisk < 0n ? 0n : operatorCapitalAtRisk
  };
}

export function resolveCandidateCapitalMetrics(
  candidate: PlanCandidate
): PlanCandidateCapitalMetrics {
  const derived = derivePlanCandidateCapitalMetrics(candidate.minimumExecutionSteps);

  return {
    quoteTokenDelta: candidate.quoteTokenDelta,
    quoteInventoryDeployed:
      candidate.quoteInventoryDeployed ?? derived.quoteInventoryDeployed,
    quoteInventoryReleased:
      candidate.quoteInventoryReleased ?? derived.quoteInventoryReleased,
    additionalCollateralRequired:
      candidate.additionalCollateralRequired ?? derived.additionalCollateralRequired,
    netQuoteBorrowed: candidate.netQuoteBorrowed ?? derived.netQuoteBorrowed,
    operatorCapitalRequired:
      candidate.operatorCapitalRequired ?? derived.operatorCapitalRequired,
    operatorCapitalAtRisk:
      candidate.operatorCapitalAtRisk ?? derived.operatorCapitalAtRisk
  };
}

export function withPlanCandidateCapitalMetrics(candidate: PlanCandidate): PlanCandidate {
  return {
    ...candidate,
    ...resolveCandidateCapitalMetrics(candidate)
  };
}

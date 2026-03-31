import {
  type ExecutionStep,
  type PlanCandidate
} from "./types.js";

export interface PlanCandidateCapitalMetrics {
  additionalCollateralRequired: bigint;
  netQuoteBorrowed: bigint;
  operatorCapitalRequired: bigint;
  operatorCapitalAtRisk: bigint;
}

export function derivePlanCandidateCapitalMetrics(
  steps: readonly ExecutionStep[]
): PlanCandidateCapitalMetrics {
  let additionalCollateralRequired = 0n;
  let netQuoteBorrowed = 0n;
  let operatorCapitalRequired = 0n;
  let operatorCapitalAtRisk = 0n;

  for (const step of steps) {
    switch (step.type) {
      case "ADD_QUOTE":
        netQuoteBorrowed -= step.amount;
        operatorCapitalRequired += step.amount;
        operatorCapitalAtRisk += step.amount;
        break;
      case "REMOVE_QUOTE":
        netQuoteBorrowed += step.amount;
        operatorCapitalAtRisk -= step.amount;
        break;
      case "DRAW_DEBT": {
        const collateralAmount = step.collateralAmount ?? 0n;
        additionalCollateralRequired += collateralAmount;
        netQuoteBorrowed += step.amount;
        operatorCapitalRequired += collateralAmount;
        operatorCapitalAtRisk += collateralAmount;
        break;
      }
      case "REPAY_DEBT":
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
    additionalCollateralRequired,
    netQuoteBorrowed,
    operatorCapitalRequired,
    operatorCapitalAtRisk: operatorCapitalAtRisk < 0n ? 0n : operatorCapitalAtRisk
  };
}

export function withPlanCandidateCapitalMetrics(candidate: PlanCandidate): PlanCandidate {
  return {
    ...candidate,
    ...derivePlanCandidateCapitalMetrics(candidate.minimumExecutionSteps)
  };
}

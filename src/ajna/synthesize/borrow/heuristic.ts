import { buildTargetBand, distanceToTargetBand } from "../../../core/planning/planner.js";
import { type KeeperConfig, type PlanCandidate } from "../../../core/types.js";
import {
  type AjnaRatePrediction,
  type AjnaRateState,
  forecastAjnaNextEligibleRate
} from "../../math/rate-state.js";
import {
  compareCandidatePreference,
  resolveDrawDebtCollateralAmounts,
  resolveDrawDebtLimitIndexes
} from "../../search/index.js";
import {
  drawDebtIntoRateState,
  finalizeCandidate,
  predictionChanged,
  resolveMinimumBorrowActionAmount
} from "../../domain.js";

export function synthesizeAjnaBorrowCandidate(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    baselinePrediction?: AjnaRatePrediction;
  }
): PlanCandidate | undefined {
  const limitIndexes = resolveDrawDebtLimitIndexes(config);
  if (limitIndexes.length === 0) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? forecastAjnaNextEligibleRate(state);
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
  if (baselineDistance === 0) {
    return undefined;
  }
  const minimumAmount = resolveMinimumBorrowActionAmount(config);
  const maxAmount = config.maxBorrowExposure;
  const collateralAmounts = resolveDrawDebtCollateralAmounts(config);

  if (minimumAmount > maxAmount) {
    return undefined;
  }
  let bestCandidate: PlanCandidate | undefined;

  for (const limitIndex of limitIndexes) {
    for (const collateralAmount of collateralAmounts) {
      function evaluate(drawDebtAmount: bigint): {
        prediction: AjnaRatePrediction;
        improvesConvergence: boolean;
      } {
        const prediction = forecastAjnaNextEligibleRate(
          drawDebtIntoRateState(state, drawDebtAmount, collateralAmount)
        );
        const predictedDistance = distanceToTargetBand(
          prediction.predictedNextRateBps,
          targetBand
        );

        return {
          prediction,
          improvesConvergence:
            predictionChanged(baselinePrediction, prediction) &&
            predictedDistance < baselineDistance
        };
      }

      let lowerBound = minimumAmount - 1n;
      let upperBound = minimumAmount;
      let upperEvaluation = evaluate(upperBound);

      while (!upperEvaluation.improvesConvergence) {
        lowerBound = upperBound;
        if (upperBound === maxAmount) {
          upperEvaluation = undefined as never;
          break;
        }

        upperBound = upperBound * 2n;
        if (upperBound > maxAmount) {
          upperBound = maxAmount;
        }
        upperEvaluation = evaluate(upperBound);
      }

      if (!upperEvaluation?.improvesConvergence) {
        continue;
      }

      while (upperBound - lowerBound > 1n) {
        const middle = lowerBound + (upperBound - lowerBound) / 2n;
        const middleEvaluation = evaluate(middle);
        if (middleEvaluation.improvesConvergence) {
          upperBound = middle;
          upperEvaluation = middleEvaluation;
        } else {
          lowerBound = middle;
        }
      }

      const candidate: PlanCandidate = {
        id: `auto-borrow:${limitIndex}:${collateralAmount.toString()}:draw-debt:${upperBound.toString()}`,
        intent: "BORROW",
        minimumExecutionSteps: [
          {
            type: "DRAW_DEBT",
            amount: upperBound,
            limitIndex,
            collateralAmount,
            note: "auto-synthesized draw-debt threshold"
          }
        ],
        predictedOutcome: upperEvaluation.prediction.predictedOutcome,
        predictedRateBpsAfterNextUpdate: upperEvaluation.prediction.predictedNextRateBps,
        resultingDistanceToTargetBps: distanceToTargetBand(
          upperEvaluation.prediction.predictedNextRateBps,
          targetBand
        ),
        quoteTokenDelta: upperBound,
        explanation: `auto draw-debt threshold changes the next eligible Ajna move from ${baselinePrediction.predictedOutcome} to ${upperEvaluation.prediction.predictedOutcome}`
      };
      const finalizedCandidate = finalizeCandidate(candidate);

      if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
        bestCandidate = finalizedCandidate;
      }
    }
  }

  return bestCandidate;
}

export function findPureBorrowImprovementThresholdForCollateral(
  state: AjnaRateState,
  targetBand: ReturnType<typeof buildTargetBand>,
  baselinePrediction: AjnaRatePrediction,
  minimumAmount: bigint,
  maximumAmount: bigint,
  collateralAmount: bigint
): bigint | undefined {
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );

  function evaluate(drawDebtAmount: bigint): {
    prediction: AjnaRatePrediction;
    improvesConvergence: boolean;
  } {
    const prediction = forecastAjnaNextEligibleRate(
      drawDebtIntoRateState(state, drawDebtAmount, collateralAmount)
    );
    const predictedDistance = distanceToTargetBand(
      prediction.predictedNextRateBps,
      targetBand
    );

    return {
      prediction,
      improvesConvergence:
        predictionChanged(baselinePrediction, prediction) &&
        predictedDistance < baselineDistance
    };
  }

  let lowerBound = minimumAmount - 1n;
  let upperBound = minimumAmount;
  let upperEvaluation = evaluate(upperBound);

  while (!upperEvaluation.improvesConvergence) {
    lowerBound = upperBound;
    if (upperBound === maximumAmount) {
      return undefined;
    }

    upperBound = upperBound * 2n;
    if (upperBound > maximumAmount) {
      upperBound = maximumAmount;
    }
    upperEvaluation = evaluate(upperBound);
  }

  while (upperBound - lowerBound > 1n) {
    const middle = lowerBound + (upperBound - lowerBound) / 2n;
    const middleEvaluation = evaluate(middle);
    if (middleEvaluation.improvesConvergence) {
      upperBound = middle;
      upperEvaluation = middleEvaluation;
    } else {
      lowerBound = middle;
    }
  }

  return upperBound;
}

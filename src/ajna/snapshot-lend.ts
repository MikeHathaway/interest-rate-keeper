import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import { type KeeperConfig, type PlanCandidate } from "../types.js";
import {
  type AjnaRatePrediction,
  type AjnaRateState,
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate
} from "./rate-state.js";
import { compareCandidatePreference, resolveAddQuoteBucketIndexes } from "./search-space.js";
import {
  DEFAULT_ADD_QUOTE_EXPIRY_SECONDS,
  addQuoteToRateState,
  finalizeCandidate,
  predictionChanged,
  resolveMinimumQuoteActionAmount
} from "./snapshot-internal.js";

export function synthesizeAjnaLendCandidate(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    quoteTokenScale: bigint;
    nowTimestamp: number;
    baselinePrediction?: AjnaRatePrediction;
  }
): PlanCandidate | undefined {
  const addQuoteBucketIndexes = resolveAddQuoteBucketIndexes(config);
  if (addQuoteBucketIndexes.length === 0 || options.quoteTokenScale <= 0n) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? classifyAjnaNextRate(state);
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
  if (baselineDistance === 0) {
    return undefined;
  }
  const minimumAmount = resolveMinimumQuoteActionAmount(config);
  const maxAmount = config.maxQuoteTokenExposure;

  if (minimumAmount > maxAmount) {
    return undefined;
  }

  let bestCandidate: PlanCandidate | undefined;

  function evaluate(quoteTokenAmount: bigint): {
    prediction: AjnaRatePrediction;
    improvesConvergence: boolean;
  } {
    const prediction = forecastAjnaNextEligibleRate(
      addQuoteToRateState(state, quoteTokenAmount, options.quoteTokenScale)
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

  for (const addQuoteBucketIndex of addQuoteBucketIndexes) {
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

    const expiry =
      options.nowTimestamp + (config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS);

    const candidate: PlanCandidate = {
      id: `auto-lend:${addQuoteBucketIndex}:add-quote:${upperBound.toString()}`,
      intent: "LEND",
      minimumExecutionSteps: [
        {
          type: "ADD_QUOTE",
          amount: upperBound,
          bucketIndex: addQuoteBucketIndex,
          expiry,
          note: "auto-synthesized add-quote threshold"
        }
      ],
      predictedOutcome: upperEvaluation.prediction.predictedOutcome,
      predictedRateBpsAfterNextUpdate: upperEvaluation.prediction.predictedNextRateBps,
      resultingDistanceToTargetBps: distanceToTargetBand(
        upperEvaluation.prediction.predictedNextRateBps,
        targetBand
      ),
      quoteTokenDelta: upperBound,
      explanation: `auto add-quote threshold changes the next Ajna move from ${baselinePrediction.predictedOutcome} to ${upperEvaluation.prediction.predictedOutcome}`
    };
    const finalizedCandidate = finalizeCandidate(candidate);

    if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
      bestCandidate = finalizedCandidate;
    }
  }

  return bestCandidate;
}

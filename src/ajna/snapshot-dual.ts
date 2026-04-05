import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import { type KeeperConfig, type PlanCandidate } from "../types.js";
import {
  type AjnaRatePrediction,
  type AjnaRateState,
  forecastAjnaNextEligibleRate
} from "./rate-state.js";
import { compareCandidatePreference, resolveAddQuoteBucketIndexes } from "./search-space.js";
import { synthesizeAjnaBorrowCandidate } from "./snapshot-borrow.js";
import { synthesizeAjnaLendCandidate } from "./snapshot-lend.js";
import {
  DEFAULT_ADD_QUOTE_EXPIRY_SECONDS,
  addQuoteToRateState,
  drawDebtIntoRateState,
  extractDrawDebtStep,
  finalizeCandidate,
  predictionChanged,
  resolveMinimumBorrowActionAmount,
  resolveMinimumQuoteActionAmount
} from "./snapshot-internal.js";

export function synthesizeAjnaLendAndBorrowCandidate(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    quoteTokenScale: bigint;
    nowTimestamp: number;
    baselinePrediction?: AjnaRatePrediction;
    anchorBorrowCandidate?: PlanCandidate;
  }
): PlanCandidate | undefined {
  const addQuoteBucketIndexes = resolveAddQuoteBucketIndexes(config);
  if (addQuoteBucketIndexes.length === 0 || options.quoteTokenScale <= 0n) {
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
  const minimumQuoteAmount = resolveMinimumQuoteActionAmount(config);
  const minimumBorrowAmount = resolveMinimumBorrowActionAmount(config);
  const maxQuoteAmount = config.maxQuoteTokenExposure;
  const maxBorrowAmount = config.maxBorrowExposure;

  if (minimumQuoteAmount > maxQuoteAmount || minimumBorrowAmount > maxBorrowAmount) {
    return undefined;
  }

  const anchorBorrowCandidate =
    options.anchorBorrowCandidate ??
    synthesizeAjnaBorrowCandidate(state, config, { baselinePrediction });
  const anchorDrawDebtStep = extractDrawDebtStep(anchorBorrowCandidate);
  if (!anchorDrawDebtStep) {
    return undefined;
  }

  const collateralAmount = anchorDrawDebtStep.collateralAmount ?? 0n;

  function evaluateBorrowOnly(drawDebtAmount: bigint): {
    prediction: AjnaRatePrediction;
    distance: number;
  } {
    const prediction = forecastAjnaNextEligibleRate(
      drawDebtIntoRateState(state, drawDebtAmount, collateralAmount)
    );
    return {
      prediction,
      distance: distanceToTargetBand(prediction.predictedNextRateBps, targetBand)
    };
  }

  function evaluateCombined(
    drawDebtAmount: bigint,
    quoteTokenAmount: bigint
  ): {
    prediction: AjnaRatePrediction;
    distance: number;
    improvesConvergence: boolean;
  } {
    const prediction = forecastAjnaNextEligibleRate(
      addQuoteToRateState(
        drawDebtIntoRateState(state, drawDebtAmount, collateralAmount),
        quoteTokenAmount,
        options.quoteTokenScale
      )
    );
    const distance = distanceToTargetBand(prediction.predictedNextRateBps, targetBand);

    return {
      prediction,
      distance,
      improvesConvergence:
        predictionChanged(baselinePrediction, prediction) && distance < baselineDistance
    };
  }

  let overshootBorrowAmount =
    anchorDrawDebtStep.amount >= minimumBorrowAmount
      ? anchorDrawDebtStep.amount
      : minimumBorrowAmount;
  let overshootBorrowEvaluation = evaluateBorrowOnly(overshootBorrowAmount);

  if (overshootBorrowEvaluation.prediction.predictedNextRateBps <= targetBand.maxRateBps) {
    let lowerBorrowAmount = overshootBorrowAmount;
    let upperBorrowAmount = overshootBorrowAmount;
    let upperBorrowEvaluation = overshootBorrowEvaluation;

    while (upperBorrowEvaluation.prediction.predictedNextRateBps <= targetBand.maxRateBps) {
      lowerBorrowAmount = upperBorrowAmount;
      if (upperBorrowAmount === maxBorrowAmount) {
        return undefined;
      }

      upperBorrowAmount = upperBorrowAmount * 2n;
      if (upperBorrowAmount > maxBorrowAmount) {
        upperBorrowAmount = maxBorrowAmount;
      }
      upperBorrowEvaluation = evaluateBorrowOnly(upperBorrowAmount);
    }

    while (upperBorrowAmount - lowerBorrowAmount > 1n) {
      const middleBorrowAmount =
        lowerBorrowAmount + (upperBorrowAmount - lowerBorrowAmount) / 2n;
      const middleBorrowEvaluation = evaluateBorrowOnly(middleBorrowAmount);
      if (middleBorrowEvaluation.prediction.predictedNextRateBps > targetBand.maxRateBps) {
        upperBorrowAmount = middleBorrowAmount;
        upperBorrowEvaluation = middleBorrowEvaluation;
      } else {
        lowerBorrowAmount = middleBorrowAmount;
      }
    }

    overshootBorrowAmount = upperBorrowAmount;
    overshootBorrowEvaluation = upperBorrowEvaluation;
  }

  if (overshootBorrowEvaluation.distance === 0) {
    return undefined;
  }

  function dualCandidateCondition(evaluation: {
    prediction: AjnaRatePrediction;
    distance: number;
    improvesConvergence: boolean;
  }): boolean {
    return (
      evaluation.improvesConvergence &&
      evaluation.distance < overshootBorrowEvaluation.distance &&
      evaluation.prediction.predictedNextRateBps <= targetBand.maxRateBps
    );
  }

  let lowerQuoteAmount = minimumQuoteAmount - 1n;
  let upperQuoteAmount = minimumQuoteAmount;
  let upperQuoteEvaluation = evaluateCombined(overshootBorrowAmount, upperQuoteAmount);

  while (!dualCandidateCondition(upperQuoteEvaluation)) {
    lowerQuoteAmount = upperQuoteAmount;
    if (upperQuoteAmount === maxQuoteAmount) {
      return undefined;
    }

    upperQuoteAmount = upperQuoteAmount * 2n;
    if (upperQuoteAmount > maxQuoteAmount) {
      upperQuoteAmount = maxQuoteAmount;
    }
    upperQuoteEvaluation = evaluateCombined(overshootBorrowAmount, upperQuoteAmount);
  }

  while (upperQuoteAmount - lowerQuoteAmount > 1n) {
    const middleQuoteAmount =
      lowerQuoteAmount + (upperQuoteAmount - lowerQuoteAmount) / 2n;
    const middleQuoteEvaluation = evaluateCombined(overshootBorrowAmount, middleQuoteAmount);
    if (dualCandidateCondition(middleQuoteEvaluation)) {
      upperQuoteAmount = middleQuoteAmount;
      upperQuoteEvaluation = middleQuoteEvaluation;
    } else {
      lowerQuoteAmount = middleQuoteAmount;
    }
  }

  const expiry =
    options.nowTimestamp + (config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS);
  let bestCandidate: PlanCandidate | undefined;

  for (const addQuoteBucketIndex of addQuoteBucketIndexes) {
    const candidate: PlanCandidate = {
      id: `auto-dual:${addQuoteBucketIndex}:${anchorDrawDebtStep.limitIndex}:${collateralAmount.toString()}:add-quote:${upperQuoteAmount.toString()}:draw-debt:${overshootBorrowAmount.toString()}`,
      intent: "LEND_AND_BORROW",
      minimumExecutionSteps: [
        {
          type: "ADD_QUOTE",
          amount: upperQuoteAmount,
          bucketIndex: addQuoteBucketIndex,
          expiry,
          note: "auto-synthesized add-quote threshold for dual-side steering"
        },
        {
          type: "DRAW_DEBT",
          amount: overshootBorrowAmount,
          limitIndex: anchorDrawDebtStep.limitIndex,
          collateralAmount,
          note: "auto-synthesized draw-debt threshold for dual-side steering"
        }
      ],
      predictedOutcome: upperQuoteEvaluation.prediction.predictedOutcome,
      predictedRateBpsAfterNextUpdate: upperQuoteEvaluation.prediction.predictedNextRateBps,
      resultingDistanceToTargetBps: upperQuoteEvaluation.distance,
      quoteTokenDelta: upperQuoteAmount + overshootBorrowAmount,
      explanation: `auto add-quote + draw-debt path tempers a borrow overshoot from ${overshootBorrowEvaluation.prediction.predictedOutcome} to ${upperQuoteEvaluation.prediction.predictedOutcome}`
    };
    const finalizedCandidate = finalizeCandidate(candidate);

    if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
      bestCandidate = finalizedCandidate;
    }
  }

  return bestCandidate;
}

export function synthesizeAjnaHeuristicCandidates(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    quoteTokenScale: bigint;
    nowTimestamp: number;
    baselinePrediction?: AjnaRatePrediction;
    allowPreWindowLend?: boolean;
  }
): PlanCandidate[] {
  const candidates: PlanCandidate[] = [];
  const allowPreWindowLend = options.allowPreWindowLend ?? true;
  const heuristicBorrowCandidate = config.enableHeuristicBorrowSynthesis
    ? synthesizeAjnaBorrowCandidate(state, config, {
        ...(options.baselinePrediction === undefined
          ? {}
          : { baselinePrediction: options.baselinePrediction })
      })
    : undefined;

  if (heuristicBorrowCandidate) {
    candidates.push(heuristicBorrowCandidate);
  }

  if (config.enableHeuristicLendSynthesis && allowPreWindowLend) {
    const lendCandidate = synthesizeAjnaLendCandidate(state, config, {
      quoteTokenScale: options.quoteTokenScale,
      nowTimestamp: options.nowTimestamp,
      ...(options.baselinePrediction === undefined
        ? {}
        : { baselinePrediction: options.baselinePrediction })
    });
    if (lendCandidate) {
      candidates.push(lendCandidate);
    }

    const dualCandidate = synthesizeAjnaLendAndBorrowCandidate(state, config, {
      quoteTokenScale: options.quoteTokenScale,
      nowTimestamp: options.nowTimestamp,
      ...(options.baselinePrediction === undefined
        ? {}
        : { baselinePrediction: options.baselinePrediction }),
      ...(heuristicBorrowCandidate === undefined
        ? {}
        : { anchorBorrowCandidate: heuristicBorrowCandidate })
    });
    if (dualCandidate) {
      candidates.push(dualCandidate);
    }
  }

  return candidates;
}

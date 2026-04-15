import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import { type KeeperConfig, type RateMoveOutcome } from "../types.js";
import {
  approximatePreWindowDualForecast,
  type ApproximateDepositWadEntry,
  type ApproximatePreWindowDualState
} from "./protocol-approx.js";
import {
  buildMultiCycleBorrowSearchAmounts,
  buildMultiCycleLendSearchAmounts,
  compressCapitalAwareSearchAmounts
} from "./search-space.js";
import { type AjnaPoolStateRead, addQuoteToRateState, drawDebtIntoRateState } from "./snapshot-internal.js";
import { forecastAjnaNextEligibleRate } from "./rate-state.js";

const DUAL_PREFILTER_MAX_QUOTE_SAMPLES = 5;
const DUAL_PREFILTER_MAX_BORROW_SAMPLES = 5;
const DUAL_PREFILTER_LOW_END_SAMPLES = 4;

export interface ProtocolShapedDualBranch {
  addQuoteBucketIndex: number;
  limitIndex: number;
  collateralAmount: bigint;
}

export interface ProtocolShapedDualQuoteAnchorStep {
  bucketIndex: number;
  amount: bigint;
}

export interface ProtocolShapedDualBorrowAnchorStep {
  limitIndex: number;
  collateralAmount: bigint;
  amount: bigint;
}

function outcomeRank(outcome: RateMoveOutcome): number {
  switch (outcome) {
    case "STEP_UP":
      return 0;
    case "NO_CHANGE":
      return 1;
    case "STEP_DOWN":
      return 2;
    case "RESET_TO_TEN":
      return 3;
  }
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left - right;
}

export function rankProtocolShapedDualBranches(
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    branches: ProtocolShapedDualBranch[];
    minimumQuoteAmount: bigint;
    maximumQuoteAmount: bigint;
    minimumBorrowAmount: bigint;
    maximumBorrowAmount: bigint;
    quoteAnchorSteps: ProtocolShapedDualQuoteAnchorStep[];
    borrowAnchorSteps: ProtocolShapedDualBorrowAnchorStep[];
    anchorBorrowLimitIndex?: number;
    anchorCollateralAmount?: bigint;
    approximation?: {
      state: ApproximatePreWindowDualState;
      deposits: ApproximateDepositWadEntry[];
    };
  }
): ProtocolShapedDualBranch[] {
  if (options.branches.length <= 1) {
    return options.branches;
  }

  const targetBand = buildTargetBand(config);
  const baselineDistance = distanceToTargetBand(
    readState.prediction.predictedNextRateBps,
    targetBand
  );
  const thresholdBucketIndex = readState.meaningfulDepositThresholdFenwickIndex;

  type RankedBranch = {
    branch: ProtocolShapedDualBranch;
    improvesApproximation: boolean;
    approximateDistance: number;
    approximateOutcomeRank: number;
    totalAmount: bigint;
    thresholdDistance?: number;
    limitAnchorDistance?: number;
    collateralAnchorPenalty: number;
    countedQuotePenalty: number;
  };

  const rankedBranches = options.branches.map<RankedBranch>((branch) => {
    const quoteAnchorAmounts = options.quoteAnchorSteps
      .filter((step) => step.bucketIndex === branch.addQuoteBucketIndex)
      .map((step) => step.amount);
    const borrowAnchorAmounts = options.borrowAnchorSteps
      .filter(
        (step) =>
          step.limitIndex === branch.limitIndex && step.collateralAmount === branch.collateralAmount
      )
      .map((step) => step.amount);

    const quoteAmounts = compressCapitalAwareSearchAmounts(
      buildMultiCycleLendSearchAmounts(
        options.minimumQuoteAmount,
        options.maximumQuoteAmount,
        quoteAnchorAmounts
      ),
      quoteAnchorAmounts,
      DUAL_PREFILTER_MAX_QUOTE_SAMPLES,
      DUAL_PREFILTER_LOW_END_SAMPLES
    );
    const borrowAmounts = compressCapitalAwareSearchAmounts(
      buildMultiCycleBorrowSearchAmounts(
        options.minimumBorrowAmount,
        options.maximumBorrowAmount,
        readState.quoteTokenScale,
        borrowAnchorAmounts
      ),
      borrowAnchorAmounts,
      DUAL_PREFILTER_MAX_BORROW_SAMPLES,
      DUAL_PREFILTER_LOW_END_SAMPLES
    );

    const quoteCountsTowardMeaningfulDeposit =
      thresholdBucketIndex === undefined || branch.addQuoteBucketIndex <= thresholdBucketIndex;

    let bestApproximateDistance = Number.POSITIVE_INFINITY;
    let bestApproximateOutcomeRank = Number.POSITIVE_INFINITY;
    let bestApproximateTotalAmount = options.maximumQuoteAmount + options.maximumBorrowAmount;
    let bestApproximateTerminalDistance = Number.POSITIVE_INFINITY;

    for (const quoteAmount of quoteAmounts) {
      for (const drawDebtAmount of borrowAmounts) {
        const prediction = options.approximation
          ? approximatePreWindowDualForecast(options.approximation.state, options.approximation.deposits, {
              addQuoteBucketIndex: branch.addQuoteBucketIndex,
              addQuoteAmountWad: quoteAmount * readState.quoteTokenScale,
              drawDebtAmountWad: drawDebtAmount,
              collateralAmountWad: branch.collateralAmount,
              targetRateBps: config.targetRateBps
            })
          : (() => {
              const updatedState = (() => {
                const debtShiftedState = drawDebtIntoRateState(
                  readState.rateState,
                  drawDebtAmount,
                  branch.collateralAmount
                );

                return quoteCountsTowardMeaningfulDeposit
                  ? addQuoteToRateState(debtShiftedState, quoteAmount, readState.quoteTokenScale)
                  : debtShiftedState;
              })();
              const nextPrediction = forecastAjnaNextEligibleRate(updatedState);

              return {
                nextRateBps: nextPrediction.predictedNextRateBps,
                nextOutcome: nextPrediction.predictedOutcome,
                terminalRateBps: nextPrediction.predictedNextRateBps,
                nextDistanceToTargetBps: distanceToTargetBand(
                  nextPrediction.predictedNextRateBps,
                  targetBand
                ),
                terminalDistanceToTargetBps: distanceToTargetBand(
                  nextPrediction.predictedNextRateBps,
                  targetBand
                )
              };
            })();
        const approximateDistance = prediction.nextDistanceToTargetBps;
        const approximateOutcome = outcomeRank(prediction.nextOutcome);
        const totalAmount = quoteAmount + drawDebtAmount;

        if (
          prediction.terminalDistanceToTargetBps < bestApproximateTerminalDistance ||
          (prediction.terminalDistanceToTargetBps === bestApproximateTerminalDistance &&
            (approximateDistance < bestApproximateDistance ||
              (approximateDistance === bestApproximateDistance &&
                (approximateOutcome < bestApproximateOutcomeRank ||
                  (approximateOutcome === bestApproximateOutcomeRank &&
                    totalAmount < bestApproximateTotalAmount)))))
        ) {
          bestApproximateTerminalDistance = prediction.terminalDistanceToTargetBps;
          bestApproximateDistance = approximateDistance;
          bestApproximateOutcomeRank = approximateOutcome;
          bestApproximateTotalAmount = totalAmount;
        }
      }
    }

    return {
      branch,
      improvesApproximation:
        bestApproximateTerminalDistance < baselineDistance ||
        bestApproximateDistance < baselineDistance,
      approximateDistance: bestApproximateDistance,
      approximateOutcomeRank: bestApproximateOutcomeRank,
      totalAmount: bestApproximateTotalAmount,
      ...(thresholdBucketIndex === undefined
        ? {}
        : { thresholdDistance: Math.abs(branch.addQuoteBucketIndex - thresholdBucketIndex) }),
      ...(options.anchorBorrowLimitIndex === undefined
        ? {}
        : { limitAnchorDistance: Math.abs(branch.limitIndex - options.anchorBorrowLimitIndex) }),
      collateralAnchorPenalty:
        options.anchorCollateralAmount === undefined ||
        branch.collateralAmount === options.anchorCollateralAmount
          ? 0
          : 1,
      countedQuotePenalty: quoteCountsTowardMeaningfulDeposit ? 0 : 1
    };
  });

  rankedBranches.sort((left, right) => {
    if (left.improvesApproximation !== right.improvesApproximation) {
      return left.improvesApproximation ? -1 : 1;
    }
    if (left.approximateDistance !== right.approximateDistance) {
      return left.approximateDistance - right.approximateDistance;
    }
    if (left.approximateOutcomeRank !== right.approximateOutcomeRank) {
      return left.approximateOutcomeRank - right.approximateOutcomeRank;
    }
    const thresholdDistanceComparison = compareOptionalNumber(
      left.thresholdDistance,
      right.thresholdDistance
    );
    if (thresholdDistanceComparison !== 0) {
      return thresholdDistanceComparison;
    }
    const limitDistanceComparison = compareOptionalNumber(
      left.limitAnchorDistance,
      right.limitAnchorDistance
    );
    if (limitDistanceComparison !== 0) {
      return limitDistanceComparison;
    }
    if (left.collateralAnchorPenalty !== right.collateralAnchorPenalty) {
      return left.collateralAnchorPenalty - right.collateralAnchorPenalty;
    }
    if (left.countedQuotePenalty !== right.countedQuotePenalty) {
      return left.countedQuotePenalty - right.countedQuotePenalty;
    }
    if (left.totalAmount !== right.totalAmount) {
      return left.totalAmount < right.totalAmount ? -1 : 1;
    }
    if (left.branch.addQuoteBucketIndex !== right.branch.addQuoteBucketIndex) {
      return left.branch.addQuoteBucketIndex - right.branch.addQuoteBucketIndex;
    }
    if (left.branch.limitIndex !== right.branch.limitIndex) {
      return left.branch.limitIndex - right.branch.limitIndex;
    }
    if (left.branch.collateralAmount !== right.branch.collateralAmount) {
      return left.branch.collateralAmount < right.branch.collateralAmount ? -1 : 1;
    }
    return 0;
  });

  return rankedBranches.map(({ branch }) => branch);
}

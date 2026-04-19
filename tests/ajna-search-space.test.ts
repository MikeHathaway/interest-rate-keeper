import { describe, expect, it } from "vitest";

import {
  resolveBorrowSimulationLookaheadAttempts,
  resolveManagedInventoryBucketIndexes,
  resolveProtocolApproximationBucketIndexes,
  resolveProtocolShapedPreWindowDualBucketIndexes,
  resolveRemoveQuoteBucketIndexes,
  resolveSimulationBorrowCollateralAmounts,
  resolveSimulationBorrowLimitIndexes,
  resolveTimedBorrowSimulationLookaheadAttempts,
  searchCoarseToFineDualSpace
} from "../src/ajna/search/index.js";
import { rankProtocolShapedDualBranches } from "../src/ajna/search/dual-prefilter.js";
import { baseConfig, WAD } from "./ajna-test-fixtures.js";

describe("searchCoarseToFineDualSpace", () => {
  it("matches an exhaustive oracle in a bounded 2D search space even when anchors miss the optimum", async () => {
    type SyntheticEvaluation = {
      terminalDistance: number;
      nextDistance: number;
      capital: bigint;
    };

    const minimumQuoteAmount = 1n;
    const maximumQuoteAmount = 20n;
    const minimumBorrowAmount = 1n;
    const maximumBorrowAmount = 20n;
    const optimalBorrowAmount = 13n;

    function evaluateSyntheticPoint(
      quoteAmount: bigint,
      drawDebtAmount: bigint
    ): SyntheticEvaluation | undefined {
      const minimumHelpfulQuote =
        drawDebtAmount <= 4n
          ? 9n
          : drawDebtAmount <= 8n
            ? 6n
            : drawDebtAmount <= 12n
              ? 4n
              : drawDebtAmount <= 16n
                ? 3n
                : 7n;
      if (quoteAmount < minimumHelpfulQuote) {
        return undefined;
      }

      return {
        terminalDistance:
          Number(drawDebtAmount > optimalBorrowAmount
            ? drawDebtAmount - optimalBorrowAmount
            : optimalBorrowAmount - drawDebtAmount) +
          Number(quoteAmount - minimumHelpfulQuote),
        nextDistance:
          Number(
            drawDebtAmount > optimalBorrowAmount - 1n
              ? drawDebtAmount - (optimalBorrowAmount - 1n)
              : (optimalBorrowAmount - 1n) - drawDebtAmount
          ) + Number(quoteAmount - minimumHelpfulQuote),
        capital: quoteAmount + drawDebtAmount
      };
    }

    const exhaustiveMatches: Array<{
      quoteAmount: bigint;
      drawDebtAmount: bigint;
      evaluation: SyntheticEvaluation;
    }> = [];
    for (let drawDebtAmount = minimumBorrowAmount; drawDebtAmount <= maximumBorrowAmount; drawDebtAmount += 1n) {
      for (let quoteAmount = minimumQuoteAmount; quoteAmount <= maximumQuoteAmount; quoteAmount += 1n) {
        const evaluation = evaluateSyntheticPoint(quoteAmount, drawDebtAmount);
        if (!evaluation) {
          continue;
        }
        exhaustiveMatches.push({
          quoteAmount,
          drawDebtAmount,
          evaluation
        });
      }
    }

    exhaustiveMatches.sort((left, right) => {
      if (left.evaluation.terminalDistance !== right.evaluation.terminalDistance) {
        return left.evaluation.terminalDistance - right.evaluation.terminalDistance;
      }
      if (left.evaluation.nextDistance !== right.evaluation.nextDistance) {
        return left.evaluation.nextDistance - right.evaluation.nextDistance;
      }
      if (left.evaluation.capital !== right.evaluation.capital) {
        return left.evaluation.capital < right.evaluation.capital ? -1 : 1;
      }
      if (left.drawDebtAmount !== right.drawDebtAmount) {
        return left.drawDebtAmount < right.drawDebtAmount ? -1 : 1;
      }
      return left.quoteAmount < right.quoteAmount ? -1 : 1;
    });

    const searchedMatch = await searchCoarseToFineDualSpace({
      minimumQuoteAmount,
      maximumQuoteAmount,
      minimumBorrowAmount,
      maximumBorrowAmount,
      quoteAnchorAmounts: [19n],
      borrowAnchorAmounts: [2n],
      evaluate: async ({ quoteAmount, drawDebtAmount }) =>
        evaluateSyntheticPoint(quoteAmount, drawDebtAmount),
      isImprovement: () => true,
      compareMatches: (left, right) => {
        if (left.evaluation.terminalDistance !== right.evaluation.terminalDistance) {
          return left.evaluation.terminalDistance - right.evaluation.terminalDistance;
        }
        if (left.evaluation.nextDistance !== right.evaluation.nextDistance) {
          return left.evaluation.nextDistance - right.evaluation.nextDistance;
        }
        if (left.evaluation.capital !== right.evaluation.capital) {
          return left.evaluation.capital < right.evaluation.capital ? -1 : 1;
        }
        if (left.drawDebtAmount !== right.drawDebtAmount) {
          return left.drawDebtAmount < right.drawDebtAmount ? -1 : 1;
        }
        return left.quoteAmount < right.quoteAmount ? -1 : 1;
      }
    });

    expect(searchedMatch).toBeDefined();
    expect(searchedMatch?.quoteAmount).toBe(exhaustiveMatches[0]?.quoteAmount);
    expect(searchedMatch?.drawDebtAmount).toBe(exhaustiveMatches[0]?.drawDebtAmount);
    expect(searchedMatch?.evaluation).toEqual(exhaustiveMatches[0]?.evaluation);
  });

  it("returns undefined when no improving dual point exists in the bounded fixture", async () => {
    const searchedMatch = await searchCoarseToFineDualSpace({
      minimumQuoteAmount: 1n,
      maximumQuoteAmount: 8n,
      minimumBorrowAmount: 1n,
      maximumBorrowAmount: 8n,
      quoteAnchorAmounts: [8n],
      borrowAnchorAmounts: [8n],
      evaluate: async () => undefined,
      isImprovement: () => true,
      compareMatches: () => 0
    });

    expect(searchedMatch).toBeUndefined();
  });
});

describe("resolveSimulationBorrowLimitIndexes", () => {
  it("expands a single configured limit index into a bounded local neighborhood", () => {
    expect(
      resolveSimulationBorrowLimitIndexes({
        ...baseConfig,
        drawDebtLimitIndex: 3000
      })
    ).toEqual([500, 1000, 1500, 2000, 2500, 2750, 3000, 3250, 3500, 4000, 5000, 6000, 7000, 7388]);
  });

  it("preserves explicitly configured multiple limit indexes without adding neighbors", () => {
    expect(
      resolveSimulationBorrowLimitIndexes({
        ...baseConfig,
        drawDebtLimitIndexes: [2800, 3000, 3200]
      })
    ).toEqual([2800, 3000, 3200]);
  });
});

describe("resolveSimulationBorrowCollateralAmounts", () => {
  it("expands a single configured collateral amount into a bounded scaled search set", () => {
    expect(
      resolveSimulationBorrowCollateralAmounts(
        {
          ...baseConfig,
          drawDebtCollateralAmount: 10n * WAD
        },
        1_000_000n * WAD
      )
    ).toEqual(
      [1n, 2n, 5n, 10n, 20n, 50n, 100n, 1_000n, 10_000n, 100_000n, 1_000_000n].map(
        (amount) => amount * WAD
      )
    );
  });

  it("preserves multiple explicit collateral candidates without adding derived values", () => {
    expect(
      resolveSimulationBorrowCollateralAmounts(
        {
          ...baseConfig,
          drawDebtCollateralAmounts: [1n * WAD, 5n * WAD, 10n * WAD]
        },
        100n * WAD
      )
    ).toEqual([1n * WAD, 5n * WAD, 10n * WAD]);
  });

  it("includes zero additional collateral when the borrower already has an open position", () => {
    expect(
      resolveSimulationBorrowCollateralAmounts(
        {
          ...baseConfig,
          drawDebtCollateralAmount: 10n * WAD
        },
        100n * WAD,
        {
          borrowerHasExistingPosition: true
        }
      )
    ).toEqual([0n, 1n, 2n, 5n, 10n, 20n, 50n, 100n].map((amount) => amount * WAD));
  });
});

describe("resolveProtocolShapedPreWindowDualBucketIndexes", () => {
  it("unions configured buckets with threshold-derived buckets for not-due dual-side search", () => {
    expect(
      resolveProtocolShapedPreWindowDualBucketIndexes(
        {
          immediatePrediction: {
            secondsUntilNextRateUpdate: 3600
          },
          meaningfulDepositThresholdFenwickIndex: 3000
        },
        {
          ...baseConfig,
          addQuoteBucketIndexes: [3500]
        }
      )
    ).toEqual([2000, 2500, 2750, 2900, 2950, 2980, 2990, 2995, 3000, 3500]);
  });

  it("preserves configured buckets once the due window is open", () => {
    expect(
      resolveProtocolShapedPreWindowDualBucketIndexes(
        {
          immediatePrediction: {
            secondsUntilNextRateUpdate: 0
          },
          meaningfulDepositThresholdFenwickIndex: 3000
        },
        {
          ...baseConfig,
          addQuoteBucketIndexes: [3250, 3500]
        }
      )
    ).toEqual([3000, 3250, 3500]);
  });
});

describe("resolveManagedInventoryBucketIndexes", () => {
  it("preserves explicitly configured remove-quote buckets", () => {
    expect(
      resolveRemoveQuoteBucketIndexes({
        ...baseConfig,
        removeQuoteBucketIndexes: [3100, 2900]
      })
    ).toEqual([2900, 3100]);
  });

  it("unions configured remove-quote buckets with threshold-derived buckets when managed control is enabled pre-window", () => {
    expect(
      resolveManagedInventoryBucketIndexes(
        {
          immediatePrediction: {
            secondsUntilNextRateUpdate: 3600
          },
          meaningfulDepositThresholdFenwickIndex: 3000
        },
        {
          ...baseConfig,
          enableManagedInventoryUpwardControl: true,
          removeQuoteBucketIndexes: [3500]
        }
      )
    ).toEqual([2000, 2500, 2750, 2900, 2950, 2980, 2990, 2995, 3000, 3500]);
  });
});

describe("resolveProtocolApproximationBucketIndexes", () => {
  it("includes threshold-derived and borrow-adjacent buckets for richer used-pool dual ranking", () => {
    expect(
      resolveProtocolApproximationBucketIndexes(
        {
          immediatePrediction: {
            secondsUntilNextRateUpdate: 3600
          },
          meaningfulDepositThresholdFenwickIndex: 3000
        },
        {
          ...baseConfig,
          addQuoteBucketIndexes: [3500],
          drawDebtLimitIndexes: [3000]
        }
      )
    ).toEqual([
      2000, 2500, 2750, 2900, 2950, 2980, 2990, 2995, 3000, 3050, 3100, 3250, 3500
    ]);
  });
});

describe("rankProtocolShapedDualBranches", () => {
  it("prioritizes threshold-adjacent, counted-quote branches in initialized used-pool states", () => {
    const orderedBranches = rankProtocolShapedDualBranches(
      {
        blockNumber: 1n,
        blockTimestamp: 50_000,
        rateState: {
          currentRateWad: 110_000_000_000_000_000n,
          currentDebtWad: 1_000n,
          debtEmaWad: 900_000_000_000_000_000n,
          depositEmaWad: 1_000_000_000_000_000_000n,
          debtColEmaWad: 150_000_000_000_000_000n,
          lupt0DebtEmaWad: WAD,
          lastInterestRateUpdateTimestamp: 10_000,
          nowTimestamp: 20_000
        },
        prediction: {
          predictedOutcome: "STEP_DOWN",
          predictedNextRateWad: 99_000_000_000_000_000n,
          predictedNextRateBps: 990,
          secondsUntilNextRateUpdate: 3600
        },
        immediatePrediction: {
          predictedOutcome: "NO_CHANGE",
          predictedNextRateWad: 110_000_000_000_000_000n,
          predictedNextRateBps: 1100,
          secondsUntilNextRateUpdate: 3600
        },
        inflatorWad: WAD,
        totalT0Debt: 1_000n,
        totalT0DebtInAuction: 0n,
        t0Debt2ToCollateralWad: 100n,
        meaningfulDepositThresholdFenwickIndex: 3000,
        quoteTokenAddress: "0x0000000000000000000000000000000000000001",
        collateralAddress: "0x0000000000000000000000000000000000000002",
        quoteTokenScale: 1n,
        poolType: 1,
        borrowerState: {
          borrowerAddress: "0x0000000000000000000000000000000000000003",
          t0Debt: 100n,
          collateral: 100n,
          npTpRatio: 0n
        },
        loansState: {
          maxBorrower: "0x0000000000000000000000000000000000000003",
          maxT0DebtToCollateral: 100n,
          noOfLoans: 3n
        }
      },
      {
        ...baseConfig,
        targetRateBps: 1300
      },
      {
        branches: [
          {
            addQuoteBucketIndex: 3500,
            limitIndex: 3250,
            collateralAmount: 0n
          },
          {
            addQuoteBucketIndex: 3000,
            limitIndex: 3000,
            collateralAmount: 0n
          },
          {
            addQuoteBucketIndex: 2995,
            limitIndex: 3000,
            collateralAmount: 0n
          }
        ],
        minimumQuoteAmount: 1n,
        maximumQuoteAmount: 1_000n,
        minimumBorrowAmount: 1n,
        maximumBorrowAmount: 1_000n,
        quoteAnchorSteps: [
          {
            bucketIndex: 2995,
            amount: 10n
          }
        ],
        borrowAnchorSteps: [
          {
            limitIndex: 3000,
            collateralAmount: 0n,
            amount: 10n
          }
        ],
        anchorBorrowLimitIndex: 3000,
        anchorCollateralAmount: 0n
      }
    );

    expect(orderedBranches.slice(0, 2)).toEqual([
      {
        addQuoteBucketIndex: 3000,
        limitIndex: 3000,
        collateralAmount: 0n
      },
      {
        addQuoteBucketIndex: 2995,
        limitIndex: 3000,
        collateralAmount: 0n
      }
    ]);
  });
});

describe("resolveBorrowSimulationLookaheadAttempts", () => {
  it("tries same-cycle first, then falls back to the default multi-cycle window when no explicit lookahead is configured", () => {
    expect(resolveBorrowSimulationLookaheadAttempts(baseConfig)).toEqual([1, 3]);
  });

  it("preserves an explicit lookahead override without adding a fallback attempt", () => {
    expect(
      resolveBorrowSimulationLookaheadAttempts({
        ...baseConfig,
        borrowSimulationLookaheadUpdates: 4
      })
    ).toEqual([4]);
  });

  it("tries 1, 2, then 3 updates for not-due borrower states when no explicit lookahead is configured", () => {
    expect(resolveTimedBorrowSimulationLookaheadAttempts(baseConfig, 3600)).toEqual([1, 2, 3]);
  });

  it("skips the one-update path by default for due-window states after EMA initialization", () => {
    expect(
      resolveTimedBorrowSimulationLookaheadAttempts(
        baseConfig,
        0,
        {
          currentRateWad: 100_000_000_000_000_000n,
          currentDebtWad: 1_000n,
          debtEmaWad: 500n,
          depositEmaWad: 1_000n,
          debtColEmaWad: 100n,
          lupt0DebtEmaWad: 100n,
          lastInterestRateUpdateTimestamp: 10_000,
          nowTimestamp: 50_000
        }
      )
    ).toEqual([3]);
  });

  it("retains 1 then 3 updates for due-window states before the first EMA update", () => {
    expect(
      resolveTimedBorrowSimulationLookaheadAttempts(
        baseConfig,
        0,
        {
          currentRateWad: 100_000_000_000_000_000n,
          currentDebtWad: 1_000n,
          debtEmaWad: 0n,
          depositEmaWad: 0n,
          debtColEmaWad: 0n,
          lupt0DebtEmaWad: 0n,
          lastInterestRateUpdateTimestamp: 10_000,
          nowTimestamp: 50_000
        }
      )
    ).toEqual([1, 3]);
  });
});

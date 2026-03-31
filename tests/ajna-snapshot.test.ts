import { describe, expect, it } from "vitest";

import {
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate,
  resolveSimulationBorrowCollateralAmounts,
  resolveBorrowSimulationLookaheadAttempts,
  resolveSimulationBorrowLimitIndexes,
  searchCoarseToFineDualSpace,
  synthesizeAjnaBorrowCandidate,
  synthesizeAjnaHeuristicCandidates,
  synthesizeAjnaLendAndBorrowCandidate,
  synthesizeAjnaLendCandidate
} from "../src/ajna/snapshot.js";
import type { KeeperConfig } from "../src/types.js";

const WAD = 1_000_000_000_000_000_000n;

const baseConfig: KeeperConfig = {
  chainId: 8453,
  poolId: "8453:pool",
  targetRateBps: 900,
  toleranceBps: 50,
  toleranceMode: "relative",
  completionPolicy: "next_move_would_overshoot",
  executionBufferBps: 50,
  maxQuoteTokenExposure: 10n * WAD,
  maxBorrowExposure: 10n * WAD,
  snapshotAgeMaxSeconds: 90,
  minTimeBeforeRateWindowSeconds: 120,
  minExecutableActionQuoteToken: 1n,
  recheckBeforeSubmit: true,
  addQuoteBucketIndex: 3000,
  addQuoteExpirySeconds: 3600
};

describe("classifyAjnaNextRate", () => {
  it("returns NO_CHANGE before the 12-hour update window opens", () => {
    const state = {
      currentRateWad: 100_000_000_000_000_000n,
      currentDebtWad: 1_000n,
      debtEmaWad: 100_000_000_000_000_000n,
      depositEmaWad: 1_000_000_000_000_000_000n,
      debtColEmaWad: WAD,
      lupt0DebtEmaWad: WAD,
      lastInterestRateUpdateTimestamp: 10_000,
      nowTimestamp: 10_100
    } as const;
    const prediction = classifyAjnaNextRate(state);
    const eligiblePrediction = forecastAjnaNextEligibleRate(state);

    expect(prediction.predictedOutcome).toBe("NO_CHANGE");
    expect(prediction.secondsUntilNextRateUpdate).toBeGreaterThan(0);
    expect(eligiblePrediction.predictedOutcome).toBe("STEP_DOWN");
    expect(eligiblePrediction.predictedNextRateBps).toBe(900);
  });

  it("returns RESET_TO_TEN for abandoned high-rate pools", () => {
    const prediction = classifyAjnaNextRate({
      currentRateWad: 200_000_000_000_000_000n,
      currentDebtWad: 1_000n,
      debtEmaWad: 10_000_000_000_000_000n,
      depositEmaWad: 1_000_000_000_000_000_000n,
      debtColEmaWad: WAD,
      lupt0DebtEmaWad: WAD,
      lastInterestRateUpdateTimestamp: 0,
      nowTimestamp: 50_000
    });

    expect(prediction.predictedOutcome).toBe("RESET_TO_TEN");
    expect(prediction.predictedNextRateBps).toBe(1000);
  });

  it("steps down when actual utilization is well below target utilization", () => {
    const prediction = classifyAjnaNextRate({
      currentRateWad: 100_000_000_000_000_000n,
      currentDebtWad: 1_000n,
      debtEmaWad: 100_000_000_000_000_000n,
      depositEmaWad: 1_000_000_000_000_000_000n,
      debtColEmaWad: WAD,
      lupt0DebtEmaWad: WAD,
      lastInterestRateUpdateTimestamp: 0,
      nowTimestamp: 50_000
    });

    expect(prediction.predictedOutcome).toBe("STEP_DOWN");
    expect(prediction.predictedNextRateBps).toBe(900);
  });

  it("steps up when actual utilization materially exceeds target utilization", () => {
    const prediction = classifyAjnaNextRate({
      currentRateWad: 100_000_000_000_000_000n,
      currentDebtWad: 1_000n,
      debtEmaWad: 990_000_000_000_000_000n,
      depositEmaWad: 1_000_000_000_000_000_000n,
      debtColEmaWad: 200_000_000_000_000_000n,
      lupt0DebtEmaWad: WAD,
      lastInterestRateUpdateTimestamp: 0,
      nowTimestamp: 50_000
    });

    expect(prediction.predictedOutcome).toBe("STEP_UP");
    expect(prediction.predictedNextRateBps).toBe(1100);
  });
});

describe("synthesizeAjnaLendCandidate", () => {
  it("finds the minimum add-quote amount that changes the next move toward the target", () => {
    let matched:
      | {
          state: Parameters<typeof synthesizeAjnaLendCandidate>[0];
          candidate: NonNullable<ReturnType<typeof synthesizeAjnaLendCandidate>>;
        }
      | undefined;

    for (const debtEmaWad of [
      750_000_000_000_000_000n,
      900_000_000_000_000_000n,
      1_000_000_000_000_000_000n,
      1_100_000_000_000_000_000n,
      1_250_000_000_000_000_000n
    ]) {
      for (const debtColEmaWad of [
        50_000_000_000_000_000n,
        100_000_000_000_000_000n,
        150_000_000_000_000_000n,
        200_000_000_000_000_000n,
        250_000_000_000_000_000n
      ]) {
        const state = {
          currentRateWad: 100_000_000_000_000_000n,
          currentDebtWad: 1_000n,
          debtEmaWad,
          depositEmaWad: 1_000_000_000_000_000_000n,
          debtColEmaWad,
          lupt0DebtEmaWad: WAD,
          lastInterestRateUpdateTimestamp: 0,
          nowTimestamp: 50_000
        } as const;
        const candidate = synthesizeAjnaLendCandidate(state, baseConfig, {
          quoteTokenScale: 1n,
          nowTimestamp: state.nowTimestamp
        });

        if (candidate) {
          matched = { state, candidate };
          break;
        }
      }

      if (matched) {
        break;
      }
    }

    expect(matched).toBeDefined();
    expect(matched?.candidate.intent).toBe("LEND");
    expect(matched?.candidate.minimumExecutionSteps[0]).toMatchObject({
      type: "ADD_QUOTE",
      bucketIndex: 3000
    });
    expect(matched?.candidate.predictedRateBpsAfterNextUpdate).toBe(1000);

    const belowThreshold = synthesizeAjnaLendCandidate(
      matched!.state,
      {
        ...baseConfig,
        maxQuoteTokenExposure: matched!.candidate.quoteTokenDelta - 1n
      },
      {
        quoteTokenScale: 1n,
        nowTimestamp: matched!.state.nowTimestamp
      }
    );

    expect(belowThreshold).toBeUndefined();
  });

  it("does not synthesize a lend candidate when no bucket index is configured", () => {
    const { addQuoteBucketIndex: _ignored, ...configWithoutBucket } = baseConfig;
    const state = {
      currentRateWad: 100_000_000_000_000_000n,
      currentDebtWad: 1_000n,
      debtEmaWad: 1_250_000_000_000_000_000n,
      depositEmaWad: 1_000_000_000_000_000_000n,
      debtColEmaWad: 100_000_000_000_000_000n,
      lupt0DebtEmaWad: WAD,
      lastInterestRateUpdateTimestamp: 0,
      nowTimestamp: 50_000
    } as const;
    const candidate = synthesizeAjnaLendCandidate(
      state,
      configWithoutBucket,
      {
        quoteTokenScale: 1n,
        nowTimestamp: state.nowTimestamp
      }
    );

    expect(candidate).toBeUndefined();
  });

  it("still synthesizes a lend candidate when the current rate is in band but the next eligible move would step above it", () => {
    let matched:
      | {
          state: Parameters<typeof synthesizeAjnaLendCandidate>[0];
          candidate: NonNullable<ReturnType<typeof synthesizeAjnaLendCandidate>>;
        }
      | undefined;

    const holdInBandConfig: KeeperConfig = {
      ...baseConfig,
      targetRateBps: 1_000,
      toleranceBps: 50
    };
    const baselinePrediction = {
      predictedOutcome: "STEP_UP" as const,
      predictedNextRateWad: 110_000_000_000_000_000n,
      predictedNextRateBps: 1_100,
      secondsUntilNextRateUpdate: 0
    };

    for (const debtEmaWad of [
      750_000_000_000_000_000n,
      900_000_000_000_000_000n,
      1_000_000_000_000_000_000n,
      1_100_000_000_000_000_000n,
      1_250_000_000_000_000_000n
    ]) {
      for (const debtColEmaWad of [
        50_000_000_000_000_000n,
        100_000_000_000_000_000n,
        150_000_000_000_000_000n,
        200_000_000_000_000_000n,
        250_000_000_000_000_000n
      ]) {
        const state = {
          currentRateWad: 100_000_000_000_000_000n,
          currentDebtWad: 1_000n,
          debtEmaWad,
          depositEmaWad: 1_000_000_000_000_000_000n,
          debtColEmaWad,
          lupt0DebtEmaWad: WAD,
          lastInterestRateUpdateTimestamp: 0,
          nowTimestamp: 50_000
        } as const;
        const candidate = synthesizeAjnaLendCandidate(state, holdInBandConfig, {
          quoteTokenScale: 1n,
          nowTimestamp: state.nowTimestamp,
          baselinePrediction
        });

        if (candidate) {
          matched = { state, candidate };
          break;
        }
      }

      if (matched) {
        break;
      }
    }

    expect(matched).toBeDefined();
    expect(matched?.candidate.predictedRateBpsAfterNextUpdate).toBeLessThanOrEqual(1_050);
  });
});

describe("synthesizeAjnaBorrowCandidate", () => {
  it("finds the minimum draw-debt amount that changes the next move toward the target", () => {
    let matched:
      | {
          state: Parameters<typeof synthesizeAjnaBorrowCandidate>[0];
          candidate: NonNullable<ReturnType<typeof synthesizeAjnaBorrowCandidate>>;
        }
      | undefined;

    const borrowConfig: KeeperConfig = {
      ...baseConfig,
      targetRateBps: 1_300,
      drawDebtLimitIndex: 3000,
      drawDebtCollateralAmounts: [0n, 5n]
    };

    for (const debtEmaWad of [
      50_000_000_000_000_000n,
      100_000_000_000_000_000n,
      150_000_000_000_000_000n,
      200_000_000_000_000_000n,
      250_000_000_000_000_000n
    ]) {
      for (const debtColEmaWad of [
        10_000_000_000_000_000n,
        25_000_000_000_000_000n,
        50_000_000_000_000_000n,
        75_000_000_000_000_000n,
        100_000_000_000_000_000n,
        150_000_000_000_000_000n,
        200_000_000_000_000_000n,
        250_000_000_000_000_000n,
        300_000_000_000_000_000n
      ]) {
        const state = {
          currentRateWad: 100_000_000_000_000_000n,
          currentDebtWad: 1_000n,
          debtEmaWad,
          depositEmaWad: 1_000_000_000_000_000_000n,
          debtColEmaWad,
          lupt0DebtEmaWad: WAD,
          lastInterestRateUpdateTimestamp: 0,
          nowTimestamp: 50_000
        } as const;
        const candidate = synthesizeAjnaBorrowCandidate(state, borrowConfig, {});

        if (candidate) {
          matched = { state, candidate };
          break;
        }
      }

      if (matched) {
        break;
      }
    }

    expect(matched).toBeDefined();
    expect(matched?.candidate.intent).toBe("BORROW");
    expect(matched?.candidate.minimumExecutionSteps[0]).toMatchObject({
      type: "DRAW_DEBT",
      limitIndex: 3000
    });
    expect(
      (matched?.candidate.minimumExecutionSteps[0] as { collateralAmount?: bigint }).collateralAmount
    ).toBe(0n);
    expect(matched?.candidate.predictedRateBpsAfterNextUpdate).toBe(1100);

    const belowThreshold = synthesizeAjnaBorrowCandidate(
      matched!.state,
      {
        ...borrowConfig,
        maxBorrowExposure: matched!.candidate.quoteTokenDelta - 1n
      },
      {}
    );

    expect(belowThreshold).toBeUndefined();
  });

  it("still synthesizes a borrow candidate when the current rate is in band but the next eligible move would step below it", () => {
    let matched:
      | {
          state: Parameters<typeof synthesizeAjnaBorrowCandidate>[0];
          candidate: NonNullable<ReturnType<typeof synthesizeAjnaBorrowCandidate>>;
        }
      | undefined;

    const borrowConfig: KeeperConfig = {
      ...baseConfig,
      targetRateBps: 1_000,
      toleranceBps: 50,
      drawDebtLimitIndex: 3000,
      drawDebtCollateralAmounts: [0n, 5n]
    };
    const baselinePrediction = {
      predictedOutcome: "STEP_DOWN" as const,
      predictedNextRateWad: 90_000_000_000_000_000n,
      predictedNextRateBps: 900,
      secondsUntilNextRateUpdate: 0
    };

    for (const debtEmaWad of [
      50_000_000_000_000_000n,
      100_000_000_000_000_000n,
      150_000_000_000_000_000n,
      200_000_000_000_000_000n,
      250_000_000_000_000_000n
    ]) {
      for (const debtColEmaWad of [
        10_000_000_000_000_000n,
        25_000_000_000_000_000n,
        50_000_000_000_000_000n,
        75_000_000_000_000_000n,
        100_000_000_000_000_000n,
        150_000_000_000_000_000n,
        200_000_000_000_000_000n,
        250_000_000_000_000_000n,
        300_000_000_000_000_000n
      ]) {
        const state = {
          currentRateWad: 100_000_000_000_000_000n,
          currentDebtWad: 1_000n,
          debtEmaWad,
          depositEmaWad: 1_000_000_000_000_000_000n,
          debtColEmaWad,
          lupt0DebtEmaWad: WAD,
          lastInterestRateUpdateTimestamp: 0,
          nowTimestamp: 50_000
        } as const;
        const candidate = synthesizeAjnaBorrowCandidate(state, borrowConfig, {
          baselinePrediction
        });

        if (candidate) {
          matched = { state, candidate };
          break;
        }
      }

      if (matched) {
        break;
      }
    }

    expect(matched).toBeDefined();
    expect(matched?.candidate.predictedRateBpsAfterNextUpdate).toBeGreaterThanOrEqual(950);
  });
});

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
});

describe("synthesizeAjnaHeuristicCandidates", () => {
  it("surfaces a heuristic borrow candidate when borrow heuristics are enabled without lend heuristics", () => {
    const config: KeeperConfig = {
      ...baseConfig,
      targetRateBps: 1_300,
      drawDebtLimitIndex: 3000,
      drawDebtCollateralAmounts: [0n, 5n],
      enableHeuristicBorrowSynthesis: true
    };
    let matchedCandidates:
      | ReturnType<typeof synthesizeAjnaHeuristicCandidates>
      | undefined;

    for (const debtEmaWad of [
      50_000_000_000_000_000n,
      100_000_000_000_000_000n,
      150_000_000_000_000_000n,
      200_000_000_000_000_000n,
      250_000_000_000_000_000n
    ]) {
      for (const debtColEmaWad of [
        10_000_000_000_000_000n,
        25_000_000_000_000_000n,
        50_000_000_000_000_000n,
        75_000_000_000_000_000n,
        100_000_000_000_000_000n,
        150_000_000_000_000_000n,
        200_000_000_000_000_000n,
        250_000_000_000_000_000n,
        300_000_000_000_000_000n
      ]) {
        const state = {
          currentRateWad: 100_000_000_000_000_000n,
          currentDebtWad: 1_000n,
          debtEmaWad,
          depositEmaWad: 1_000_000_000_000_000_000n,
          debtColEmaWad,
          lupt0DebtEmaWad: WAD,
          lastInterestRateUpdateTimestamp: 0,
          nowTimestamp: 50_000
        } as const;

        const candidates = synthesizeAjnaHeuristicCandidates(state, config, {
          quoteTokenScale: 1n,
          nowTimestamp: state.nowTimestamp
        });
        if (candidates.some((candidate) => candidate.intent === "BORROW")) {
          matchedCandidates = candidates;
          break;
        }
      }

      if (matchedCandidates) {
        break;
      }
    }

    expect(matchedCandidates).toBeDefined();
    expect(matchedCandidates?.some((candidate) => candidate.intent === "BORROW")).toBe(true);
    expect(matchedCandidates?.some((candidate) => candidate.intent === "LEND")).toBe(false);
    expect(matchedCandidates?.some((candidate) => candidate.intent === "LEND_AND_BORROW")).toBe(
      false
    );
  });
});

describe("synthesizeAjnaLendAndBorrowCandidate", () => {
  it("finds a dual-side candidate that tempers a borrow overshoot toward the target band", () => {
    const dualConfig: KeeperConfig = {
      ...baseConfig,
      targetRateBps: 1_030,
      toleranceBps: 10,
      toleranceMode: "absolute",
      drawDebtLimitIndex: 3_000,
      drawDebtCollateralAmounts: [0n, 5n]
    };

    const state = {
      currentRateWad: 100_000_000_000_000_000n,
      currentDebtWad: 1_000n,
      debtEmaWad: 50_000_000_000_000_000n,
      depositEmaWad: 1_000_000_000_000_000_000n,
      debtColEmaWad: 150_000_000_000_000_000n,
      lupt0DebtEmaWad: WAD,
      lastInterestRateUpdateTimestamp: 0,
      nowTimestamp: 50_000
    } as const;

    const borrowCandidate = synthesizeAjnaBorrowCandidate(state, dualConfig, {});
    const candidate = synthesizeAjnaLendAndBorrowCandidate(state, dualConfig, {
      quoteTokenScale: 1n,
      nowTimestamp: state.nowTimestamp,
      ...(borrowCandidate === undefined ? {} : { anchorBorrowCandidate: borrowCandidate })
    });

    expect(borrowCandidate).toBeDefined();
    expect(candidate).toBeDefined();
    expect(candidate?.intent).toBe("LEND_AND_BORROW");
    expect(candidate?.minimumExecutionSteps[0]).toMatchObject({
      type: "ADD_QUOTE",
      bucketIndex: 3000
    });
    expect(candidate?.minimumExecutionSteps[1]).toMatchObject({
      type: "DRAW_DEBT",
      limitIndex: 3000
    });

    const addQuoteStep = candidate?.minimumExecutionSteps[0];
    const drawDebtStep = candidate?.minimumExecutionSteps[1];
    expect(addQuoteStep?.type).toBe("ADD_QUOTE");
    expect(drawDebtStep?.type).toBe("DRAW_DEBT");

    const borrowOnlyPrediction = forecastAjnaNextEligibleRate({
      ...state,
      currentDebtWad:
        state.currentDebtWad +
        (drawDebtStep?.type === "DRAW_DEBT" ? drawDebtStep.amount : 0n),
      debtEmaWad:
        state.debtEmaWad +
        (drawDebtStep?.type === "DRAW_DEBT" ? drawDebtStep.amount : 0n),
      debtColEmaWad:
        state.debtColEmaWad +
        (drawDebtStep?.type === "DRAW_DEBT" ? (drawDebtStep.collateralAmount ?? 0n) : 0n)
    });

    expect(borrowOnlyPrediction.predictedOutcome).toBe("STEP_UP");
    expect(candidate?.predictedOutcome).toBe("NO_CHANGE");
    expect(candidate?.resultingDistanceToTargetBps).toBeLessThan(
      Math.abs(dualConfig.targetRateBps - borrowOnlyPrediction.predictedNextRateBps)
    );

    const belowThreshold = synthesizeAjnaLendAndBorrowCandidate(
      state,
      {
        ...dualConfig,
        maxQuoteTokenExposure:
          addQuoteStep?.type === "ADD_QUOTE" ? addQuoteStep.amount - 1n : 0n
      },
      {
        quoteTokenScale: 1n,
        nowTimestamp: state.nowTimestamp,
        ...(borrowCandidate === undefined ? {} : { anchorBorrowCandidate: borrowCandidate })
      }
    );

    expect(belowThreshold).toBeUndefined();
  });
});

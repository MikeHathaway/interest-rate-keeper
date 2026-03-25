import { describe, expect, it } from "vitest";

import {
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate,
  synthesizeAjnaBorrowCandidate,
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
      drawDebtCollateralAmount: 0n
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
        100_000_000_000_000_000n
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
});

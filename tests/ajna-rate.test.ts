import { describe, expect, it } from "vitest";

import {
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate,
  hasUninitializedAjnaEmaState
} from "../src/ajna/math/rate-state.js";
import { WAD } from "./ajna-test-fixtures.js";

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

describe("hasUninitializedAjnaEmaState", () => {
  it("detects pools before their first EMA update", () => {
    expect(
      hasUninitializedAjnaEmaState({
        currentRateWad: 100_000_000_000_000_000n,
        currentDebtWad: 1_000n,
        debtEmaWad: 0n,
        depositEmaWad: 0n,
        debtColEmaWad: 0n,
        lupt0DebtEmaWad: 0n,
        lastInterestRateUpdateTimestamp: 10_000,
        nowTimestamp: 10_100
      })
    ).toBe(true);
  });

  it("treats nonzero EMA values as an initialized ongoing state", () => {
    expect(
      hasUninitializedAjnaEmaState({
        currentRateWad: 100_000_000_000_000_000n,
        currentDebtWad: 1_000n,
        debtEmaWad: 500n,
        depositEmaWad: 1_000n,
        debtColEmaWad: 100n,
        lupt0DebtEmaWad: 100n,
        lastInterestRateUpdateTimestamp: 10_000,
        nowTimestamp: 10_100
      })
    ).toBe(false);
  });
});

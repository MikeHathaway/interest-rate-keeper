import { describe, expect, it } from "vitest";

import {
  forecastAjnaNextEligibleRate,
  resolveAjnaSynthesisPolicy,
  synthesizeAjnaBorrowCandidate,
  synthesizeAjnaHeuristicCandidates,
  synthesizeAjnaLendAndBorrowCandidate,
  synthesizeAjnaLendCandidate
} from "../src/ajna/snapshot.js";
import type { KeeperConfig } from "../src/types.js";
import { baseConfig, WAD } from "./ajna-test-fixtures.js";

describe("resolveAjnaSynthesisPolicy", () => {
  it("auto-enables exact plus heuristic synthesis when a simulation sender is available", () => {
    const policy = resolveAjnaSynthesisPolicy(
      {
        ...baseConfig,
        simulationSenderAddress: "0x2222222222222222222222222222222222222222"
      },
      {}
    );

    expect(policy).toEqual({
      simulationLend: true,
      simulationBorrow: true,
      heuristicLend: true,
      heuristicBorrow: true
    });
  });

  it("falls back to heuristics when no simulation sender is available", () => {
    const policy = resolveAjnaSynthesisPolicy(baseConfig, {});

    expect(policy).toEqual({
      simulationLend: false,
      simulationBorrow: false,
      heuristicLend: true,
      heuristicBorrow: true
    });
  });

  it("respects explicit synthesis flags when provided", () => {
    const policy = resolveAjnaSynthesisPolicy(
      {
        ...baseConfig,
        enableSimulationBackedBorrowSynthesis: true,
        enableHeuristicBorrowSynthesis: true,
        enableHeuristicLendSynthesis: false
      },
      {}
    );

    expect(policy).toEqual({
      simulationLend: false,
      simulationBorrow: true,
      heuristicLend: false,
      heuristicBorrow: true
    });
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

  it("suppresses heuristic lend and dual candidates when pre-window lend is disabled", () => {
    const config: KeeperConfig = {
      ...baseConfig,
      targetRateBps: 800,
      enableHeuristicLendSynthesis: true,
      enableHeuristicBorrowSynthesis: false,
      drawDebtLimitIndex: 3000
    };
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

    const allowedCandidates = synthesizeAjnaHeuristicCandidates(state, config, {
      quoteTokenScale: 1n,
      nowTimestamp: state.nowTimestamp
    });
    const blockedCandidates = synthesizeAjnaHeuristicCandidates(state, config, {
      quoteTokenScale: 1n,
      nowTimestamp: state.nowTimestamp,
      allowPreWindowLend: false
    });

    expect(allowedCandidates.some((candidate) => candidate.intent === "LEND")).toBe(true);
    expect(blockedCandidates.some((candidate) => candidate.intent === "LEND")).toBe(false);
    expect(blockedCandidates.some((candidate) => candidate.intent === "LEND_AND_BORROW")).toBe(
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

import { describe, expect, it } from "vitest";

import { planCycle } from "../src/planner.js";
import type { KeeperConfig, PoolSnapshot } from "../src/types.js";

const baseConfig: KeeperConfig = {
  chainId: 8453,
  poolId: "base:pool",
  targetRateBps: 1000,
  toleranceBps: 1000,
  toleranceMode: "relative",
  completionPolicy: "next_move_would_overshoot",
  executionBufferBps: 50,
  maxQuoteTokenExposure: 1_000_000n,
  maxBorrowExposure: 1_000_000n,
  snapshotAgeMaxSeconds: 90,
  minTimeBeforeRateWindowSeconds: 120,
  minExecutableActionQuoteToken: 1n,
  recheckBeforeSubmit: true
};

function snapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    snapshotFingerprint: "same",
    poolId: "base:pool",
    chainId: 8453,
    blockNumber: 10n,
    blockTimestamp: 1_000,
    snapshotAgeSeconds: 5,
    secondsUntilNextRateUpdate: 1_000,
    currentRateBps: 800,
    predictedNextOutcome: "STEP_DOWN",
    predictedNextRateBps: 700,
    candidates: [],
    ...overrides
  };
}

describe("planCycle", () => {
  it("no-ops when already inside the target band", () => {
    const plan = planCycle(
      snapshot({
        currentRateBps: 950,
        predictedNextRateBps: 900
      }),
      baseConfig
    );

    expect(plan.intent).toBe("NO_OP");
    expect(plan.operatorCapitalRequired).toBe(0n);
    expect(plan.operatorCapitalAtRisk).toBe(0n);
  });

  it("no-ops when the natural move already improves convergence", () => {
    const plan = planCycle(
      snapshot({
        predictedNextOutcome: "STEP_UP",
        predictedNextRateBps: 900
      }),
      baseConfig
    );

    expect(plan.intent).toBe("NO_OP");
    expect(plan.reason).toMatch(/already converges/);
  });

  it("schedules UPDATE_INTEREST when a convergent natural move is already due", () => {
    const plan = planCycle(
      snapshot({
        secondsUntilNextRateUpdate: 0,
        predictedNextOutcome: "STEP_UP",
        predictedNextRateBps: 900
      }),
      baseConfig
    );

    expect(plan.intent).toBe("NO_OP");
    expect(plan.requiredSteps).toEqual([{ type: "UPDATE_INTEREST", bufferPolicy: "none" }]);
  });

  it("chooses the best candidate and applies an execution buffer", () => {
    const plan = planCycle(
      snapshot({
        candidates: [
          {
            id: "dual",
            intent: "LEND_AND_BORROW",
            minimumExecutionSteps: [
              {
                type: "ADD_QUOTE",
                amount: 100n,
                bucketIndex: 3000,
                expiry: 2_000
              },
              {
                type: "DRAW_DEBT",
                amount: 50n,
                limitIndex: 3200
              }
            ],
            predictedOutcome: "STEP_UP",
            predictedRateBpsAfterNextUpdate: 950,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: 150n,
            explanation: "dual side move reaches the target band"
          }
        ]
      }),
      baseConfig
    );

    expect(plan.intent).toBe("LEND_AND_BORROW");
    expect(plan.requiredSteps).toHaveLength(2);
    expect(plan.quoteTokenDelta).toBe(150n);
    expect(plan.additionalCollateralRequired).toBe(0n);
    expect(plan.netQuoteBorrowed).toBe(-50n);
    expect(plan.operatorCapitalRequired).toBe(100n);
    expect(plan.operatorCapitalAtRisk).toBe(100n);
    expect(plan.requiredSteps[0]).toMatchObject({
      type: "ADD_QUOTE",
      amount: 101n
    });
    expect(plan.requiredSteps[1]).toMatchObject({
      type: "DRAW_DEBT",
      amount: 51n
    });
  });

  it("does not append UPDATE_INTEREST to a selected mutating candidate when the rate update is due", () => {
    const plan = planCycle(
      snapshot({
        secondsUntilNextRateUpdate: 0,
        candidates: [
          {
            id: "lend",
            intent: "LEND",
            minimumExecutionSteps: [
              {
                type: "ADD_QUOTE",
                amount: 100n,
                bucketIndex: 3000,
                expiry: 2_000
              }
            ],
            predictedOutcome: "STEP_UP",
            predictedRateBpsAfterNextUpdate: 950,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: 100n,
            explanation: "lend then update"
          }
        ]
      }),
      baseConfig
    );

    expect(plan.requiredSteps).toHaveLength(1);
    expect(plan.requiredSteps[0]).toMatchObject({
      type: "ADD_QUOTE"
    });
  });

  it("can choose a candidate using planningRateBps instead of only the next update rate", () => {
    const plan = planCycle(
      snapshot({
        currentRateBps: 800,
        predictedNextOutcome: "STEP_DOWN",
        predictedNextRateBps: 700,
        candidates: [
          {
            id: "multi-cycle-borrow",
            intent: "BORROW",
            minimumExecutionSteps: [
              {
                type: "DRAW_DEBT",
                amount: 10n,
                limitIndex: 3000
              }
            ],
            predictedOutcome: "STEP_DOWN",
            predictedRateBpsAfterNextUpdate: 700,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: 10n,
            explanation: "two-update borrow path reaches the band",
            planningRateBps: 950,
            planningLookaheadUpdates: 2
          }
        ]
      }),
      baseConfig
    );

    expect(plan.intent).toBe("BORROW");
    expect(plan.reason).toMatch(/two-update borrow path/);
  });

  it("prefers a multi-cycle borrower plan over a passive one-step improvement", () => {
    const config: KeeperConfig = {
      ...baseConfig,
      targetRateBps: 1300,
      toleranceBps: 50
    };

    const plan = planCycle(
      snapshot({
        currentRateBps: 1000,
        predictedNextOutcome: "STEP_UP",
        predictedNextRateBps: 1100,
        candidates: [
          {
            id: "multi-cycle-borrow",
            intent: "BORROW",
            minimumExecutionSteps: [
              {
                type: "DRAW_DEBT",
                amount: 10n,
                limitIndex: 3000
              }
            ],
            predictedOutcome: "STEP_UP",
            predictedRateBpsAfterNextUpdate: 1100,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: 10n,
            explanation: "two-update borrow path reaches the target band",
            planningRateBps: 1295,
            planningLookaheadUpdates: 2
          }
        ]
      }),
      config
    );

    expect(plan.intent).toBe("BORROW");
    expect(plan.reason).toMatch(/two-update borrow path/);
  });

  it("does not spend capital when the passive path already lands in band", () => {
    const plan = planCycle(
      snapshot({
        currentRateBps: 800,
        predictedNextOutcome: "STEP_UP",
        predictedNextRateBps: 950,
        candidates: [
          {
            id: "borrow-but-unnecessary",
            intent: "BORROW",
            minimumExecutionSteps: [
              {
                type: "DRAW_DEBT",
                amount: 10n,
                limitIndex: 3000
              }
            ],
            predictedOutcome: "STEP_UP",
            predictedRateBpsAfterNextUpdate: 960,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: 10n,
            explanation: "borrow path also lands in band",
            planningRateBps: 980,
            planningLookaheadUpdates: 2
          }
        ]
      }),
      baseConfig
    );

    expect(plan.intent).toBe("NO_OP");
    expect(plan.reason).toMatch(/already converges/);
  });

  it("prefers a borrower candidate that beats the passive multi-update baseline", () => {
    const config: KeeperConfig = {
      ...baseConfig,
      targetRateBps: 1300,
      toleranceBps: 50
    };

    const plan = planCycle(
      snapshot({
        currentRateBps: 900,
        predictedNextOutcome: "STEP_DOWN",
        predictedNextRateBps: 810,
        planningRateBps: 656,
        planningLookaheadUpdates: 3,
        candidates: [
          {
            id: "borrow-lookahead",
            intent: "BORROW",
            minimumExecutionSteps: [
              {
                type: "DRAW_DEBT",
                amount: 5n,
                limitIndex: 3000,
                collateralAmount: 10n
              }
            ],
            predictedOutcome: "STEP_DOWN",
            predictedRateBpsAfterNextUpdate: 810,
            resultingDistanceToTargetBps: 483,
            quoteTokenDelta: 5n,
            explanation: "simulation-backed draw-debt threshold improves the 3-update path",
            planningRateBps: 810,
            planningLookaheadUpdates: 3
          }
        ]
      }),
      config
    );

    expect(plan.intent).toBe("BORROW");
    expect(plan.reason).toMatch(/3-update path/);
    expect(plan.additionalCollateralRequired).toBe(10n);
    expect(plan.netQuoteBorrowed).toBe(5n);
    expect(plan.operatorCapitalRequired).toBe(10n);
    expect(plan.operatorCapitalAtRisk).toBe(10n);
  });
});

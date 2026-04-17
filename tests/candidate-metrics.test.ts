import { describe, expect, it } from "vitest";

import {
  derivePlanCandidateCapitalMetrics,
  resolveCandidateCapitalMetrics
} from "../src/candidate-metrics.js";
import type { PlanCandidate } from "../src/types.js";

const ZERO = {
  quoteTokenDelta: 0n,
  quoteInventoryDeployed: 0n,
  quoteInventoryReleased: 0n,
  additionalCollateralRequired: 0n,
  netQuoteBorrowed: 0n,
  operatorCapitalRequired: 0n,
  operatorCapitalAtRisk: 0n
};

describe("derivePlanCandidateCapitalMetrics", () => {
  it("returns zeros for an empty step list", () => {
    expect(derivePlanCandidateCapitalMetrics([])).toEqual(ZERO);
  });

  it("treats UPDATE_INTEREST as a no-op", () => {
    expect(
      derivePlanCandidateCapitalMetrics([
        { type: "UPDATE_INTEREST", bufferPolicy: "none" }
      ])
    ).toEqual(ZERO);
  });

  it("clamps operatorCapitalAtRisk to zero when a plan releases more than it locks", () => {
    const metrics = derivePlanCandidateCapitalMetrics([
      { type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 }
    ]);
    expect(metrics.operatorCapitalAtRisk).toBe(0n);
    expect(metrics.quoteInventoryReleased).toBe(100n);
    expect(metrics.netQuoteBorrowed).toBe(100n);
  });

  it("accumulates REPAY_DEBT with collateralAmountToPull", () => {
    const metrics = derivePlanCandidateCapitalMetrics([
      { type: "ADD_COLLATERAL", amount: 50n, bucketIndex: 1 },
      { type: "REPAY_DEBT", amount: 30n, collateralAmountToPull: 10n }
    ]);
    expect(metrics.operatorCapitalRequired).toBe(80n);
    expect(metrics.operatorCapitalAtRisk).toBe(40n);
    expect(metrics.netQuoteBorrowed).toBe(-30n);
  });

  it("handles REMOVE_COLLATERAL — reduces at-risk only", () => {
    const metrics = derivePlanCandidateCapitalMetrics([
      { type: "ADD_COLLATERAL", amount: 100n, bucketIndex: 1 },
      { type: "REMOVE_COLLATERAL", amount: 40n }
    ]);
    expect(metrics.operatorCapitalAtRisk).toBe(60n);
    expect(metrics.operatorCapitalRequired).toBe(100n);
  });

  it("aggregates dual REMOVE_QUOTE + DRAW_DEBT correctly", () => {
    const metrics = derivePlanCandidateCapitalMetrics([
      { type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 },
      { type: "DRAW_DEBT", amount: 80n, limitIndex: 3000, collateralAmount: 20n }
    ]);
    expect(metrics.quoteInventoryReleased).toBe(100n);
    expect(metrics.additionalCollateralRequired).toBe(20n);
    expect(metrics.netQuoteBorrowed).toBe(180n);
    expect(metrics.operatorCapitalRequired).toBe(20n);
    expect(metrics.operatorCapitalAtRisk).toBe(0n);
  });
});

describe("resolveCandidateCapitalMetrics", () => {
  const baseCandidate: PlanCandidate = {
    id: "lend",
    intent: "LEND",
    minimumExecutionSteps: [
      { type: "ADD_QUOTE", amount: 100n, bucketIndex: 1, expiry: 0 }
    ],
    predictedOutcome: "STEP_UP",
    predictedRateBpsAfterNextUpdate: 950,
    resultingDistanceToTargetBps: 0,
    quoteTokenDelta: 100n,
    explanation: "lend"
  };

  it("falls back to derived metrics when candidate has no explicit fields", () => {
    const metrics = resolveCandidateCapitalMetrics(baseCandidate);
    expect(metrics.quoteInventoryDeployed).toBe(100n);
    expect(metrics.operatorCapitalRequired).toBe(100n);
  });

  it("prefers explicit candidate fields when present", () => {
    const metrics = resolveCandidateCapitalMetrics({
      ...baseCandidate,
      quoteInventoryDeployed: 42n
    });
    expect(metrics.quoteInventoryDeployed).toBe(42n);
  });
});

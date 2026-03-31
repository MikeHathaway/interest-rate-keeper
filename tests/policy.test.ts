import { describe, expect, it } from "vitest";

import { preSubmitRecheck, validatePlan } from "../src/policy.js";
import type { CyclePlan, KeeperConfig, PoolSnapshot } from "../src/types.js";

const config: KeeperConfig = {
  chainId: 8453,
  poolId: "base:pool",
  targetRateBps: 1000,
  toleranceBps: 1000,
  toleranceMode: "relative",
  completionPolicy: "next_move_would_overshoot",
  executionBufferBps: 50,
  maxQuoteTokenExposure: 1000n,
  maxBorrowExposure: 1000n,
  snapshotAgeMaxSeconds: 90,
  minTimeBeforeRateWindowSeconds: 120,
  minExecutableActionQuoteToken: 2n,
  recheckBeforeSubmit: true
};

const snapshot: PoolSnapshot = {
  snapshotFingerprint: "same",
  poolId: "base:pool",
  chainId: 8453,
  blockNumber: 10n,
  blockTimestamp: 1_000,
  snapshotAgeSeconds: 5,
  secondsUntilNextRateUpdate: 300,
  currentRateBps: 800,
  predictedNextOutcome: "STEP_DOWN",
  predictedNextRateBps: 700,
  metadata: {
    poolAddress: "0x1111111111111111111111111111111111111111",
    currentRateWad: "100000000000000000",
    currentDebtWad: "1000",
    debtEmaWad: "1000",
    depositEmaWad: "10000",
    debtColEmaWad: "2000",
    lupt0DebtEmaWad: "3000",
    lastInterestRateUpdateTimestamp: 900
  },
  candidates: [
    {
      id: "lend",
      validationSignature: "sig:v1",
      intent: "LEND",
      minimumExecutionSteps: [
        {
          type: "ADD_QUOTE",
          amount: 10n,
          bucketIndex: 1,
          expiry: 2_000
        }
      ],
      predictedOutcome: "STEP_UP",
      predictedRateBpsAfterNextUpdate: 950,
      resultingDistanceToTargetBps: 0,
      quoteTokenDelta: 10n,
      explanation: "lend"
    }
  ]
};

const plan: CyclePlan = {
  intent: "LEND",
  reason: "lend",
  targetBand: { minRateBps: 900, maxRateBps: 1100 },
  selectedCandidateId: "lend",
  requiredSteps: [
    {
      type: "ADD_QUOTE",
      amount: 10n,
      bucketIndex: 1,
      expiry: 2_000
    }
  ],
  predictedOutcomeAfterPlan: "STEP_UP",
  predictedRateBpsAfterNextUpdate: 950,
  quoteTokenDelta: 10n,
  additionalCollateralRequired: 0n,
  netQuoteBorrowed: -10n,
  operatorCapitalRequired: 10n,
  operatorCapitalAtRisk: 10n
};

describe("policy", () => {
  it("rejects stale snapshots", () => {
    const failure = validatePlan(plan, { ...snapshot, snapshotAgeSeconds: 91 }, config);
    expect(failure?.code).toBe("STALE_SNAPSHOT");
  });

  it("rejects too-small executable steps", () => {
    const firstStep = plan.requiredSteps[0];
    if (!firstStep || firstStep.type !== "ADD_QUOTE") {
      throw new Error("expected an ADD_QUOTE step in the test fixture");
    }

    const failure = validatePlan(
      {
        ...plan,
        requiredSteps: [{ ...firstStep, amount: 1n }]
      },
      snapshot,
      config
    );
    expect(failure?.code).toBe("MIN_EXECUTION_AMOUNT");
  });

  it("allows a new block when the semantic pool state is unchanged", () => {
    const failure = preSubmitRecheck(
      plan,
      snapshot,
      {
        ...snapshot,
        snapshotFingerprint: "different",
        blockNumber: 11n,
        blockTimestamp: 1_012,
        snapshotAgeSeconds: 8
      },
      config
    );

    expect(failure).toBeUndefined();
  });

  it("aborts when the pool state changed before submission", () => {
    const failure = preSubmitRecheck(
      plan,
      snapshot,
      {
        ...snapshot,
        snapshotFingerprint: "different",
        metadata: {
          ...snapshot.metadata,
          currentDebtWad: "2000"
        }
      },
      config
    );
    expect(failure?.code).toBe("POOL_STATE_CHANGED");
  });

  it("aborts when the selected candidate validation signature changes", () => {
    const freshSnapshot: PoolSnapshot = {
      ...snapshot,
      snapshotFingerprint: "different",
      blockNumber: 11n,
      blockTimestamp: 1_012,
      snapshotAgeSeconds: 8,
      candidates: snapshot.candidates.map((candidate) => ({
        ...candidate,
        validationSignature: "sig:v2"
      }))
    };

    const failure = preSubmitRecheck(plan, snapshot, freshSnapshot, config);
    expect(failure?.code).toBe("CANDIDATE_INVALIDATED");
  });

  it("allows immediate UPDATE_INTEREST plans inside the unsafe window", () => {
    const failure = validatePlan(
      {
        ...plan,
        requiredSteps: [{ type: "UPDATE_INTEREST", bufferPolicy: "none" }]
      },
      { ...snapshot, secondsUntilNextRateUpdate: 0 },
      config
    );

    expect(failure).toBeUndefined();
  });

  it("allows already-due mutating plans that will consume the overdue update", () => {
    const failure = validatePlan(
      plan,
      { ...snapshot, secondsUntilNextRateUpdate: 0 },
      config
    );

    expect(failure).toBeUndefined();
  });
});

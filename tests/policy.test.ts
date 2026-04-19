import { describe, expect, it } from "vitest";

import {
  managedPrefixSafetyGuards,
  preSubmitRecheck,
  validatePlan
} from "../src/core/planning/policy.js";
import type { CyclePlan, KeeperConfig, PoolSnapshot } from "../src/core/types.js";

const config: KeeperConfig = {
  chainId: 8453,
  poolId: "base:pool",
  targetRateBps: 1000,
  toleranceBps: 1000,
  toleranceMode: "relative",
  completionPolicy: "next_move_would_overshoot",
  executionBufferBps: 0,
  maxQuoteTokenExposure: 1000n,
  maxBorrowExposure: 1000n,
  snapshotAgeMaxSeconds: 90,
  minTimeBeforeRateWindowSeconds: 120,
  minExecutableQuoteTokenAmount: 2n,
  minExecutableBorrowAmount: 2n,
  minExecutableCollateralAmount: 2n,
  recheckBeforeSubmit: true,
  allowHeuristicExecution: false
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
  quoteInventoryDeployed: 10n,
  quoteInventoryReleased: 0n,
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

  it("rejects too-small draw-debt collateral amounts", () => {
    const failure = validatePlan(
      {
        ...plan,
        intent: "BORROW",
        requiredSteps: [
          {
            type: "DRAW_DEBT",
            amount: 10n,
            limitIndex: 1,
            collateralAmount: 1n
          }
        ]
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

  it("allows preventive action when the current rate is in band but the next eligible update leaves the band", () => {
    const inBandSnapshot: PoolSnapshot = {
      ...snapshot,
      currentRateBps: 950,
      predictedNextRateBps: 800,
      predictedNextOutcome: "STEP_DOWN"
    };
    const preventivePlan: CyclePlan = {
      ...plan,
      predictedRateBpsAfterNextUpdate: 950
    };

    const failure = preSubmitRecheck(
      preventivePlan,
      inBandSnapshot,
      {
        ...inBandSnapshot,
        snapshotFingerprint: "different",
        blockNumber: 11n,
        blockTimestamp: 1_012,
        snapshotAgeSeconds: 8
      },
      config
    );

    expect(failure).toBeUndefined();
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

  it("rejects managed remove-quote plans that exceed the configured inventory release cap", () => {
    const failure = validatePlan(
      {
        ...plan,
        requiredSteps: [
          {
            type: "REMOVE_QUOTE",
            amount: 250n,
            bucketIndex: 1
          }
        ],
        quoteTokenDelta: 250n,
        quoteInventoryDeployed: 0n,
        quoteInventoryReleased: 250n,
        netQuoteBorrowed: 250n,
        operatorCapitalRequired: 0n,
        operatorCapitalAtRisk: 0n
      },
      {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: true,
          managedTotalWithdrawableQuoteAmount: "1000"
        }
      },
      {
        ...config,
        enableManagedInventoryUpwardControl: true,
        maxManagedInventoryReleaseBps: 2000
      }
    );

    expect(failure?.code).toBe("MANAGED_RELEASE_CAP_EXCEEDED");
  });

  it("rejects managed remove-quote plans that fail the controllability gate", () => {
    const failure = validatePlan(
      {
        ...plan,
        requiredSteps: [
          {
            type: "REMOVE_QUOTE",
            amount: 100n,
            bucketIndex: 1
          }
        ],
        predictedRateBpsAfterNextUpdate: 946,
        quoteTokenDelta: 100n,
        quoteInventoryDeployed: 0n,
        quoteInventoryReleased: 100n,
        netQuoteBorrowed: 100n,
        operatorCapitalRequired: 0n,
        operatorCapitalAtRisk: 0n
      },
      {
        ...snapshot,
        predictedNextRateBps: 900,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: true,
          managedTotalWithdrawableQuoteAmount: "1000"
        }
      },
      {
        ...config,
        enableManagedInventoryUpwardControl: true,
        minimumManagedSensitivityBpsPer10PctRelease: 10
      }
    );

    expect(failure?.code).toBe("MANAGED_CONTROLLABILITY_TOO_LOW");
  });

  it("rejects managed plans when eligibility flipped to false in the fresh snapshot", () => {
    const removeQuotePlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        { type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 }
      ],
      quoteTokenDelta: 100n,
      quoteInventoryDeployed: 0n,
      quoteInventoryReleased: 100n,
      netQuoteBorrowed: 100n,
      operatorCapitalRequired: 0n,
      operatorCapitalAtRisk: 0n
    };

    const failure = validatePlan(
      removeQuotePlan,
      {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: false,
          managedInventoryIneligibilityReason: "no withdrawable inventory"
        }
      },
      { ...config, enableManagedInventoryUpwardControl: true }
    );
    expect(failure?.code).toBe("MANAGED_CONTROL_UNAVAILABLE");
    expect(failure?.reason).toMatch(/no withdrawable inventory/);
  });

  it("rejects managed dual plans when dual eligibility flipped to false", () => {
    const dualPlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        { type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 },
        { type: "DRAW_DEBT", amount: 50n, limitIndex: 1, collateralAmount: 25n }
      ],
      quoteTokenDelta: 100n,
      quoteInventoryDeployed: 0n,
      quoteInventoryReleased: 100n,
      netQuoteBorrowed: 150n,
      additionalCollateralRequired: 25n,
      operatorCapitalRequired: 25n,
      operatorCapitalAtRisk: 25n
    };

    const failure = validatePlan(
      dualPlan,
      {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: true,
          managedDualUpwardEligible: false,
          managedDualIneligibilityReason: "dual path gated",
          managedTotalWithdrawableQuoteAmount: "1000"
        }
      },
      {
        ...config,
        enableManagedInventoryUpwardControl: true,
        enableManagedDualUpwardControl: true
      }
    );
    expect(failure?.code).toBe("MANAGED_CONTROL_UNAVAILABLE");
    expect(failure?.reason).toMatch(/dual path gated/);
  });

  it("rejects managed plans when the fresh snapshot has no withdrawable inventory totals", () => {
    const removeQuotePlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        { type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 }
      ],
      quoteTokenDelta: 100n,
      quoteInventoryDeployed: 0n,
      quoteInventoryReleased: 100n,
      netQuoteBorrowed: 100n,
      operatorCapitalRequired: 0n,
      operatorCapitalAtRisk: 0n
    };

    const failure = validatePlan(
      removeQuotePlan,
      {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: true
        }
      },
      { ...config, enableManagedInventoryUpwardControl: true }
    );
    expect(failure?.code).toBe("MANAGED_CONTROL_UNAVAILABLE");
    expect(failure?.reason).toMatch(/withdrawable managed inventory/);
  });

  it("runs managedInventoryGuards during preSubmitRecheck", () => {
    const removeQuotePlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        { type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 }
      ],
      quoteTokenDelta: 100n,
      quoteInventoryDeployed: 0n,
      quoteInventoryReleased: 100n,
      netQuoteBorrowed: 100n,
      operatorCapitalRequired: 0n,
      operatorCapitalAtRisk: 0n
    };

    const eligibleMetadata = {
      ...snapshot.metadata,
      managedInventoryUpwardEligible: true,
      managedTotalWithdrawableQuoteAmount: "1000"
    };

    const previousSnapshot: PoolSnapshot = {
      ...snapshot,
      metadata: eligibleMetadata
    };

    const freshSnapshot: PoolSnapshot = {
      ...snapshot,
      snapshotFingerprint: "different",
      blockNumber: 11n,
      blockTimestamp: 1_012,
      snapshotAgeSeconds: 8,
      metadata: {
        ...eligibleMetadata,
        managedInventoryUpwardEligible: false,
        managedInventoryIneligibilityReason: "inventory depleted by another actor"
      }
    };

    const failure = preSubmitRecheck(
      removeQuotePlan,
      previousSnapshot,
      freshSnapshot,
      { ...config, enableManagedInventoryUpwardControl: true }
    );

    expect(failure?.code).toBe("MANAGED_CONTROL_UNAVAILABLE");
    expect(failure?.reason).toMatch(/inventory depleted by another actor/);
  });

  it("aborts preSubmitRecheck when plan steps no longer match the fresh candidate steps", () => {
    const tamperedPlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        {
          type: "ADD_QUOTE",
          amount: 9_999n,
          bucketIndex: 1,
          expiry: 2_000
        }
      ],
      quoteTokenDelta: 9_999n,
      quoteInventoryDeployed: 9_999n,
      netQuoteBorrowed: -9_999n,
      operatorCapitalRequired: 9_999n,
      operatorCapitalAtRisk: 9_999n
    };

    const failure = preSubmitRecheck(
      tamperedPlan,
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

    expect(failure?.code).toBe("CANDIDATE_INVALIDATED");
    expect(failure?.reason).toMatch(/no longer match/);
  });

  it("rejects managed plans whose fresh snapshot no longer shows improvement over baseline", () => {
    const failure = validatePlan(
      {
        ...plan,
        requiredSteps: [
          { type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 }
        ],
        predictedRateBpsAfterNextUpdate: 600,
        quoteTokenDelta: 100n,
        quoteInventoryDeployed: 0n,
        quoteInventoryReleased: 100n,
        netQuoteBorrowed: 100n,
        operatorCapitalRequired: 0n,
        operatorCapitalAtRisk: 0n
      },
      {
        ...snapshot,
        predictedNextRateBps: 700,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: true,
          managedTotalWithdrawableQuoteAmount: "1000"
        }
      },
      {
        ...config,
        enableManagedInventoryUpwardControl: true,
        minimumManagedSensitivityBpsPer10PctRelease: 10
      }
    );

    expect(failure?.code).toBe("MANAGED_CONTROLLABILITY_TOO_LOW");
    expect(failure?.reason).toMatch(/no longer improves the passive path/);
  });

  it("rejects managed plans whose release fraction rounds to zero under the sensitivity gate", () => {
    const failure = validatePlan(
      {
        ...plan,
        requiredSteps: [
          { type: "REMOVE_QUOTE", amount: 2n, bucketIndex: 1 }
        ],
        predictedRateBpsAfterNextUpdate: 900,
        quoteTokenDelta: 2n,
        quoteInventoryDeployed: 0n,
        quoteInventoryReleased: 2n,
        netQuoteBorrowed: 2n,
        operatorCapitalRequired: 0n,
        operatorCapitalAtRisk: 0n
      },
      {
        ...snapshot,
        predictedNextRateBps: 700,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: true,
          managedTotalWithdrawableQuoteAmount: "1000000000000000000000"
        }
      },
      {
        ...config,
        enableManagedInventoryUpwardControl: true,
        minimumManagedSensitivityBpsPer10PctRelease: 1_000_000
      }
    );

    expect(failure?.code).toBe("MANAGED_CONTROLLABILITY_TOO_LOW");
    expect(failure?.reason).toMatch(/controllability gate|release fraction/i);
  });

  it("does not reject ADD_QUOTE plans whose fresh-candidate expiry drifted forward", () => {
    // C1 regression: auto-synthesized ADD_QUOTE candidates recompute expiry
    // from `now` at every read. A plan built at t=0 must not be invalidated
    // by a recheck a few seconds later just because the fresh candidate's
    // expiry advanced.
    const driftedFreshSnapshot: PoolSnapshot = {
      ...snapshot,
      snapshotFingerprint: "different",
      blockNumber: 11n,
      blockTimestamp: 1_012,
      snapshotAgeSeconds: 8,
      candidates: snapshot.candidates.map((candidate) => ({
        ...candidate,
        minimumExecutionSteps: candidate.minimumExecutionSteps.map((step) =>
          step.type === "ADD_QUOTE"
            ? { ...step, expiry: step.expiry + 12 }
            : step
        )
      }))
    };

    const failure = preSubmitRecheck(plan, snapshot, driftedFreshSnapshot, config);
    expect(failure).toBeUndefined();
  });

  it("does not reject non-managed plans when the fresh snapshot's managed state shifts", () => {
    // C2 regression: managed-control diagnostics are keeper-local and must
    // not trip sameSemanticPoolState for non-managed plans.
    const driftedFreshSnapshot: PoolSnapshot = {
      ...snapshot,
      snapshotFingerprint: "different",
      blockNumber: 11n,
      blockTimestamp: 1_012,
      snapshotAgeSeconds: 8,
      metadata: {
        ...snapshot.metadata,
        managedInventoryUpwardEligible: false,
        managedDualUpwardEligible: false,
        managedTotalWithdrawableQuoteAmount: "0",
        managedInventoryIneligibilityReason: "curator drained own bucket"
      }
    };

    const failure = preSubmitRecheck(plan, snapshot, driftedFreshSnapshot, config);
    expect(failure).toBeUndefined();
  });

  it("managedPrefixSafetyGuards skips improvement/sensitivity checks", () => {
    // C3 regression: prefix-safety must not reject a prefix just because
    // its improvement or sensitivity is lower than the full dual plan's
    // threshold. Only eligibility + release cap are safety invariants.
    const prefixPlan: CyclePlan = {
      ...plan,
      requiredSteps: [{ type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 }],
      // Predicted rate shows minimal improvement — would fail sensitivity.
      predictedRateBpsAfterNextUpdate: 705,
      quoteTokenDelta: 100n,
      quoteInventoryDeployed: 0n,
      quoteInventoryReleased: 100n,
      netQuoteBorrowed: 100n,
      operatorCapitalRequired: 0n,
      operatorCapitalAtRisk: 0n
    };

    const prefixFriendlySnapshot: PoolSnapshot = {
      ...snapshot,
      predictedNextRateBps: 700,
      metadata: {
        ...snapshot.metadata,
        managedInventoryUpwardEligible: true,
        managedTotalWithdrawableQuoteAmount: "1000"
      }
    };

    const failure = managedPrefixSafetyGuards(
      prefixPlan,
      prefixFriendlySnapshot,
      {
        ...config,
        enableManagedInventoryUpwardControl: true,
        // Thresholds that the prefix alone CANNOT meet; the full dual would.
        minimumManagedImprovementBps: 100,
        minimumManagedSensitivityBpsPer10PctRelease: 1_000_000
      }
    );

    // Improvement/sensitivity are NOT checked by the prefix guard, so this
    // passes — leaving the dual loop free to proceed to DRAW_DEBT.
    expect(failure).toBeUndefined();
  });

  it("managedPrefixSafetyGuards still enforces release cap", () => {
    const prefixPlan: CyclePlan = {
      ...plan,
      requiredSteps: [{ type: "REMOVE_QUOTE", amount: 500n, bucketIndex: 1 }],
      predictedRateBpsAfterNextUpdate: 900,
      quoteTokenDelta: 500n,
      quoteInventoryDeployed: 0n,
      quoteInventoryReleased: 500n,
      netQuoteBorrowed: 500n,
      operatorCapitalRequired: 0n,
      operatorCapitalAtRisk: 0n
    };

    const failure = managedPrefixSafetyGuards(
      prefixPlan,
      {
        ...snapshot,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: true,
          managedTotalWithdrawableQuoteAmount: "1000"
        }
      },
      {
        ...config,
        enableManagedInventoryUpwardControl: true,
        // 500/1000 = 50% released, cap is 20% → fail.
        maxManagedInventoryReleaseBps: 2_000
      }
    );

    expect(failure?.code).toBe("MANAGED_RELEASE_CAP_EXCEEDED");
  });

  it("rejects managed plans whose fresh-snapshot improvement falls below the configured floor", () => {
    // H1 regression: minimumManagedImprovementBps must be revalidated at
    // recheck time, even when the sensitivity gate is not configured. Without
    // this check, a plan that improved 50 bps at planning can degrade to 1 bp
    // at recheck and still pass.
    const removeQuotePlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        { type: "REMOVE_QUOTE", amount: 100n, bucketIndex: 1 }
      ],
      predictedRateBpsAfterNextUpdate: 705,
      quoteTokenDelta: 100n,
      quoteInventoryDeployed: 0n,
      quoteInventoryReleased: 100n,
      netQuoteBorrowed: 100n,
      operatorCapitalRequired: 0n,
      operatorCapitalAtRisk: 0n
    };

    const failure = validatePlan(
      removeQuotePlan,
      {
        ...snapshot,
        predictedNextRateBps: 700,
        metadata: {
          ...snapshot.metadata,
          managedInventoryUpwardEligible: true,
          managedTotalWithdrawableQuoteAmount: "1000"
        }
      },
      {
        ...config,
        enableManagedInventoryUpwardControl: true,
        // Improvement is 5 bps (705 - 700). Floor is 50 bps → fails.
        // Sensitivity gate intentionally left off to cover the early-return path.
        minimumManagedImprovementBps: 50
      }
    );

    expect(failure?.code).toBe("MANAGED_CONTROLLABILITY_TOO_LOW");
    expect(failure?.reason).toMatch(/below the configured floor of 50 bps/);
  });

  it("rejects plans whose ADD_QUOTE expiry has already elapsed at submission time", () => {
    // M1 regression: C1 fix removes `expiry` from step-body comparison,
    // which means a stale expiry could pass recheck and revert at submission
    // (wasted gas). preSubmitRecheck must catch expired steps via a dedicated
    // freshness check independent of the normalization.
    const addQuotePlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        {
          type: "ADD_QUOTE",
          amount: 10n,
          bucketIndex: 1,
          expiry: 1_000 // same as fresh block timestamp → expired
        }
      ]
    };

    // Use a fresh snapshot with matching candidate (to isolate the expiry check
    // from CANDIDATE_INVALIDATED). Same fingerprint so sameSemanticPoolState
    // passes.
    const freshSnapshot: PoolSnapshot = {
      ...snapshot,
      blockTimestamp: 1_000,
      candidates: [
        {
          ...snapshot.candidates[0]!,
          minimumExecutionSteps: [
            {
              type: "ADD_QUOTE",
              amount: 10n,
              bucketIndex: 1,
              expiry: 1_000
            }
          ]
        }
      ]
    };

    const failure = preSubmitRecheck(addQuotePlan, snapshot, freshSnapshot, config);
    expect(failure?.code).toBe("EXPIRED_STEP");
    expect(failure?.reason).toMatch(/expiry 1000 is at or before/);
  });

  it("accepts ADD_QUOTE plans whose expiry is still in the future", () => {
    // M1 happy path: expiry still in the future at recheck time.
    const addQuotePlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        {
          type: "ADD_QUOTE",
          amount: 10n,
          bucketIndex: 1,
          expiry: 5_000
        }
      ]
    };

    const freshSnapshot: PoolSnapshot = {
      ...snapshot,
      blockTimestamp: 1_000,
      snapshotFingerprint: "different",
      snapshotAgeSeconds: 5,
      candidates: [
        {
          ...snapshot.candidates[0]!,
          minimumExecutionSteps: [
            {
              type: "ADD_QUOTE",
              amount: 10n,
              bucketIndex: 1,
              expiry: 5_000
            }
          ]
        }
      ]
    };

    const failure = preSubmitRecheck(addQuotePlan, snapshot, freshSnapshot, config);
    expect(failure).toBeUndefined();
  });

  it("rejects manual ADD_COLLATERAL plans whose expiry has already elapsed", () => {
    const addCollateralPlan: CyclePlan = {
      ...plan,
      requiredSteps: [
        {
          type: "ADD_COLLATERAL",
          amount: 10n,
          bucketIndex: 1,
          expiry: 1_000
        }
      ]
    };

    const failure = validatePlan(addCollateralPlan, snapshot, config);
    expect(failure?.code).toBe("EXPIRED_STEP");
    expect(failure?.reason).toMatch(/ADD_COLLATERAL step expiry 1000 is at or before/);
  });

  it("rejects ADD_COLLATERAL plans whose expiry has already elapsed at submission time", () => {
    const { selectedCandidateId: _selectedCandidateId, ...planWithoutCandidate } = plan;
    const addCollateralPlan: CyclePlan = {
      ...planWithoutCandidate,
      requiredSteps: [
        {
          type: "ADD_COLLATERAL",
          amount: 10n,
          bucketIndex: 1,
          expiry: 1_000
        }
      ]
    };

    const freshSnapshot: PoolSnapshot = {
      ...snapshot,
      blockTimestamp: 1_000,
      candidates: []
    };

    const failure = preSubmitRecheck(
      addCollateralPlan,
      { ...snapshot, candidates: [] },
      freshSnapshot,
      config
    );
    expect(failure?.code).toBe("EXPIRED_STEP");
    expect(failure?.reason).toMatch(/ADD_COLLATERAL step expiry 1000 is at or before/);
  });

  it("accepts ADD_COLLATERAL plans whose expiry is still in the future", () => {
    const { selectedCandidateId: _selectedCandidateId, ...planWithoutCandidate } = plan;
    const addCollateralPlan: CyclePlan = {
      ...planWithoutCandidate,
      requiredSteps: [
        {
          type: "ADD_COLLATERAL",
          amount: 10n,
          bucketIndex: 1,
          expiry: 5_000
        }
      ]
    };

    const freshSnapshot: PoolSnapshot = {
      ...snapshot,
      blockTimestamp: 1_000,
      snapshotFingerprint: "different",
      snapshotAgeSeconds: 5,
      candidates: []
    };

    const failure = preSubmitRecheck(
      addCollateralPlan,
      { ...snapshot, candidates: [] },
      freshSnapshot,
      config
    );
    expect(failure).toBeUndefined();
  });
});

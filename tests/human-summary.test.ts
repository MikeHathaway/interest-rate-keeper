import { describe, expect, it } from "vitest";

import { formatCycleCapitalSummary } from "../src/human-summary.js";
import { type CycleResult } from "../src/core/types.js";

describe("formatCycleCapitalSummary", () => {
  it("formats a short human-readable capital summary", () => {
    const result: CycleResult = {
      dryRun: true,
      status: "EXECUTED",
      reason: "executed",
      poolId: "base:pool",
      chainId: 8453,
      snapshotFingerprint: "snapshot",
      transactionHashes: ["0xabc"],
      executedSteps: [],
      plan: {
        intent: "LEND_AND_BORROW",
        reason: "dual move",
        targetBand: {
          minRateBps: 900,
          maxRateBps: 1100
        },
        selectedCandidateId: "dual",
        selectedCandidateExecutionMode: "supported",
        requiredSteps: [],
        predictedOutcomeAfterPlan: "STEP_UP",
        predictedRateBpsAfterNextUpdate: 950,
        planningRateBps: 1005,
        planningLookaheadUpdates: 3,
        quoteTokenDelta: 150n,
        quoteInventoryDeployed: 100n,
        quoteInventoryReleased: 0n,
        additionalCollateralRequired: 25n,
        netQuoteBorrowed: -50n,
        operatorCapitalRequired: 125n,
        operatorCapitalAtRisk: 125n
      }
    };

    expect(formatCycleCapitalSummary(result)).toBe(
      "summary dry_run=true status=EXECUTED intent=LEND_AND_BORROW inventory_backed=false candidate_mode=supported lookahead=3 planning_rate=1005 inventory_deployed=100 inventory_released=0 required=125 at_risk=125 net_quote=-50 addl_collateral=25"
    );
  });
});

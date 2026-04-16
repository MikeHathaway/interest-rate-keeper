import { describe, expect, it } from "vitest";

import { DryRunExecutionBackend, StepwiseExecutionBackend } from "../src/execute.js";
import {
  formatKeeperHubResponse,
  resolveKeeperHubPayload,
  runKeeperHubPayload
} from "../src/keeperhub.js";

describe("keeperhub", () => {
  it("preserves planning metadata on payload snapshots and manual candidates", () => {
    const payload = resolveKeeperHubPayload({
      config: {
        chainId: 8453,
        poolAddress: "0x1111111111111111111111111111111111111111",
        targetRateBps: 1200,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000000",
        maxBorrowExposure: "500000",
        manualCandidates: [
          {
            id: "borrow",
            intent: "BORROW",
            minimumExecutionSteps: [
              {
                type: "DRAW_DEBT",
                amount: "100",
                limitIndex: 3000
              }
            ],
            predictedOutcome: "STEP_UP",
            predictedRateBpsAfterNextUpdate: 1100,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: "100",
            explanation: "manual multi-cycle borrow",
            planningRateBps: 1195,
            planningLookaheadUpdates: 3
          }
        ]
      },
      snapshot: {
        snapshotFingerprint: "payload",
        poolId: "8453:0x1111111111111111111111111111111111111111",
        chainId: 8453,
        blockNumber: "10",
        blockTimestamp: 1000,
        snapshotAgeSeconds: 5,
        secondsUntilNextRateUpdate: 300,
        currentRateBps: 1000,
        predictedNextOutcome: "STEP_UP",
        predictedNextRateBps: 1100,
        planningRateBps: 1195,
        planningLookaheadUpdates: 3,
        candidates: []
      }
    });

    expect(payload.config.manualCandidates?.[0]?.planningRateBps).toBe(1195);
    expect(payload.config.manualCandidates?.[0]?.planningLookaheadUpdates).toBe(3);
    expect(payload.config.manualCandidates?.[0]?.additionalCollateralRequired).toBe(0n);
    expect(payload.config.manualCandidates?.[0]?.netQuoteBorrowed).toBe(100n);
    expect(payload.snapshot.planningRateBps).toBe(1195);
    expect(payload.snapshot.planningLookaheadUpdates).toBe(3);
  });

  it("derives capital metrics for payload snapshot candidates", () => {
    const payload = resolveKeeperHubPayload({
      config: {
        chainId: 8453,
        poolId: "base:pool",
        targetRateBps: 1000,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000",
        maxBorrowExposure: "1000"
      },
      snapshot: {
        snapshotFingerprint: "payload",
        poolId: "base:pool",
        chainId: 8453,
        blockNumber: "10",
        blockTimestamp: 1000,
        snapshotAgeSeconds: 5,
        secondsUntilNextRateUpdate: 300,
        currentRateBps: 1000,
        predictedNextOutcome: "STEP_UP",
        predictedNextRateBps: 1100,
        candidates: [
          {
            id: "dual",
            intent: "LEND_AND_BORROW",
            minimumExecutionSteps: [
              {
                type: "ADD_QUOTE",
                amount: "100",
                bucketIndex: 1,
                expiry: 2000
              },
              {
                type: "DRAW_DEBT",
                amount: "50",
                limitIndex: 2,
                collateralAmount: "25"
              }
            ],
            predictedOutcome: "STEP_UP",
            predictedRateBpsAfterNextUpdate: 950,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: "150",
            explanation: "dual move"
          }
        ]
      }
    });

    expect(payload.snapshot.candidates[0]?.additionalCollateralRequired).toBe(25n);
    expect(payload.snapshot.candidates[0]?.quoteInventoryDeployed).toBe(100n);
    expect(payload.snapshot.candidates[0]?.quoteInventoryReleased).toBe(0n);
    expect(payload.snapshot.candidates[0]?.netQuoteBorrowed).toBe(-50n);
    expect(payload.snapshot.candidates[0]?.operatorCapitalRequired).toBe(125n);
    expect(payload.snapshot.candidates[0]?.operatorCapitalAtRisk).toBe(125n);
  });

  it("rejects fractional planning lookahead values in payload snapshots", () => {
    expect(() =>
      resolveKeeperHubPayload({
        config: {
          chainId: 8453,
          poolId: "base:pool",
          targetRateBps: 1000,
          toleranceBps: 1000,
          maxQuoteTokenExposure: "1000",
          maxBorrowExposure: "1000"
        },
        snapshot: {
          snapshotFingerprint: "payload",
          poolId: "base:pool",
          chainId: 8453,
          blockNumber: "10",
          blockTimestamp: 1000,
          snapshotAgeSeconds: 5,
          secondsUntilNextRateUpdate: 300,
          currentRateBps: 1000,
          predictedNextOutcome: "STEP_UP",
          predictedNextRateBps: 1100,
          planningLookaheadUpdates: 1.5,
          candidates: []
        }
      })
    ).toThrow(/planningLookaheadUpdates/);
  });

  it("disables recheck when running a static payload without live read config", async () => {
    const result = await runKeeperHubPayload(
      {
        config: {
          chainId: 8453,
          poolId: "base:pool",
          targetRateBps: 1000,
          toleranceBps: 1000,
          toleranceMode: "relative",
          completionPolicy: "next_move_would_overshoot",
          executionBufferBps: 0,
          maxQuoteTokenExposure: "1000",
          maxBorrowExposure: "1000",
          snapshotAgeMaxSeconds: 90,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: true
        },
        snapshot: {
          snapshotFingerprint: "payload",
          poolId: "base:pool",
          chainId: 8453,
          blockNumber: "10",
          blockTimestamp: 1000,
          snapshotAgeSeconds: 5,
          secondsUntilNextRateUpdate: 600,
          currentRateBps: 800,
          predictedNextOutcome: "STEP_DOWN",
          predictedNextRateBps: 700,
          candidates: [
            {
              id: "dual",
              intent: "LEND_AND_BORROW",
              minimumExecutionSteps: [
                {
                  type: "ADD_QUOTE",
                  amount: "100",
                  bucketIndex: 1,
                  expiry: 2000
                },
                {
                  type: "DRAW_DEBT",
                  amount: "50",
                  limitIndex: 2
                }
              ],
              predictedOutcome: "STEP_UP",
              predictedRateBpsAfterNextUpdate: 950,
              resultingDistanceToTargetBps: 0,
              quoteTokenDelta: "150",
              explanation: "dual move"
            }
          ]
        }
      },
      {
        executor: new StepwiseExecutionBackend({
          ADD_QUOTE: async () => ({ transactionHash: "0xadd" }),
          DRAW_DEBT: async () => ({ transactionHash: "0xdraw" })
        })
      }
    );

    expect(result.status).toBe("EXECUTED");
    expect(result.transactionHashes).toEqual(["0xadd", "0xdraw"]);
  });

  it("includes selected capital metrics in KeeperHub responses", async () => {
    const result = await runKeeperHubPayload(
      {
        config: {
          chainId: 8453,
          poolId: "base:pool",
          targetRateBps: 1000,
          toleranceBps: 1000,
          toleranceMode: "relative",
          completionPolicy: "next_move_would_overshoot",
          executionBufferBps: 50,
          maxQuoteTokenExposure: "1000",
          maxBorrowExposure: "1000",
          snapshotAgeMaxSeconds: 90,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: false
        },
        snapshot: {
          snapshotFingerprint: "payload",
          poolId: "base:pool",
          chainId: 8453,
          blockNumber: "10",
          blockTimestamp: 1000,
          snapshotAgeSeconds: 5,
          secondsUntilNextRateUpdate: 600,
          currentRateBps: 800,
          predictedNextOutcome: "STEP_DOWN",
          predictedNextRateBps: 700,
          candidates: [
            {
              id: "borrow",
              intent: "BORROW",
              minimumExecutionSteps: [
                {
                  type: "DRAW_DEBT",
                  amount: "50",
                  limitIndex: 2,
                  collateralAmount: "25"
                }
              ],
              predictedOutcome: "STEP_UP",
              predictedRateBpsAfterNextUpdate: 950,
              resultingDistanceToTargetBps: 0,
              quoteTokenDelta: "50",
              explanation: "borrow move"
            }
          ]
        }
      },
      {
        executor: new StepwiseExecutionBackend({
          DRAW_DEBT: async () => ({ transactionHash: "0xdraw" })
        })
      }
    );

    const formatted = JSON.parse(formatKeeperHubResponse(result)) as {
      dryRun: boolean;
      candidateSource?: string;
      candidateExecutionMode?: string;
      predictedOutcomeAfterPlan: string;
      predictedRateBpsAfterNextUpdate: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
      capital: Record<string, string>;
    };

    expect(formatted.dryRun).toBe(false);
    expect(formatted.candidateSource).toBeUndefined();
    expect(formatted.candidateExecutionMode).toBeUndefined();
    expect(formatted.predictedOutcomeAfterPlan).toBe("STEP_UP");
    expect(formatted.predictedRateBpsAfterNextUpdate).toBe(950);
    expect(formatted.planningRateBps).toBeUndefined();
    expect(formatted.planningLookaheadUpdates).toBeUndefined();
    expect(formatted.capital).toEqual({
      quoteTokenDelta: "51",
      quoteInventoryDeployed: "0",
      quoteInventoryReleased: "0",
      additionalCollateralRequired: "25",
      netQuoteBorrowed: "51",
      operatorCapitalRequired: "25",
      operatorCapitalAtRisk: "25"
    });
  });

  it("allows advisory heuristic planning when an overridden dry-run config opts into it", async () => {
    const result = await runKeeperHubPayload(
      {
        config: {
          chainId: 8453,
          poolId: "base:pool",
          targetRateBps: 1000,
          toleranceBps: 50,
          toleranceMode: "absolute",
          completionPolicy: "next_move_would_overshoot",
          executionBufferBps: 0,
          maxQuoteTokenExposure: "1000",
          maxBorrowExposure: "1000",
          snapshotAgeMaxSeconds: 90,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: false
        },
        snapshot: {
          snapshotFingerprint: "payload",
          poolId: "base:pool",
          chainId: 8453,
          blockNumber: "10",
          blockTimestamp: 1000,
          snapshotAgeSeconds: 5,
          secondsUntilNextRateUpdate: 600,
          currentRateBps: 800,
          predictedNextOutcome: "STEP_DOWN",
          predictedNextRateBps: 700,
          candidates: [
            {
              id: "heuristic-borrow",
              intent: "BORROW",
              candidateSource: "heuristic",
              executionMode: "advisory",
              minimumExecutionSteps: [
                {
                  type: "DRAW_DEBT",
                  amount: "50",
                  limitIndex: 2
                }
              ],
              predictedOutcome: "STEP_UP",
              predictedRateBpsAfterNextUpdate: 950,
              resultingDistanceToTargetBps: 0,
              quoteTokenDelta: "50",
              explanation: "heuristic borrow"
            }
          ]
        }
      },
      {
        executor: new StepwiseExecutionBackend({
          DRAW_DEBT: async () => ({ transactionHash: "0xdraw" })
        })
      },
      {
        config: {
          ...resolveKeeperHubPayload({
            config: {
              chainId: 8453,
              poolId: "base:pool",
              targetRateBps: 1000,
              toleranceBps: 50,
              toleranceMode: "absolute",
              completionPolicy: "next_move_would_overshoot",
              executionBufferBps: 0,
              maxQuoteTokenExposure: "1000",
              maxBorrowExposure: "1000",
              snapshotAgeMaxSeconds: 90,
              minTimeBeforeRateWindowSeconds: 120,
              minExecutableActionQuoteToken: "1",
              recheckBeforeSubmit: false
            },
            snapshot: {
              snapshotFingerprint: "payload",
              poolId: "base:pool",
              chainId: 8453,
              blockNumber: "10",
              blockTimestamp: 1000,
              snapshotAgeSeconds: 5,
              secondsUntilNextRateUpdate: 600,
              currentRateBps: 800,
              predictedNextOutcome: "STEP_DOWN",
              predictedNextRateBps: 700,
              candidates: []
            }
          }).config,
          allowHeuristicExecution: true
        }
      }
    );

    expect(result.status).toBe("EXECUTED");
    expect(result.plan.selectedCandidateSource).toBe("heuristic");
    expect(result.plan.selectedCandidateExecutionMode).toBe("advisory");
  });

  it("marks dry-run responses explicitly and carries planning metadata", async () => {
    const result = await runKeeperHubPayload(
      {
        config: {
          chainId: 8453,
          poolId: "base:pool",
          targetRateBps: 1000,
          toleranceBps: 50,
          toleranceMode: "absolute",
          completionPolicy: "next_move_would_overshoot",
          executionBufferBps: 0,
          maxQuoteTokenExposure: "1000",
          maxBorrowExposure: "1000",
          snapshotAgeMaxSeconds: 90,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: false,
          allowHeuristicExecution: true
        },
        snapshot: {
          snapshotFingerprint: "payload",
          poolId: "base:pool",
          chainId: 8453,
          blockNumber: "10",
          blockTimestamp: 1000,
          snapshotAgeSeconds: 5,
          secondsUntilNextRateUpdate: 600,
          currentRateBps: 800,
          predictedNextOutcome: "STEP_DOWN",
          predictedNextRateBps: 700,
          candidates: [
            {
              id: "heuristic-borrow",
              intent: "BORROW",
              candidateSource: "heuristic",
              executionMode: "advisory",
              minimumExecutionSteps: [
                {
                  type: "DRAW_DEBT",
                  amount: "50",
                  limitIndex: 2
                }
              ],
              predictedOutcome: "STEP_UP",
              predictedRateBpsAfterNextUpdate: 950,
              resultingDistanceToTargetBps: 0,
              quoteTokenDelta: "50",
              explanation: "heuristic borrow",
              planningRateBps: 990,
              planningLookaheadUpdates: 2
            }
          ]
        }
      },
      {
        executor: new DryRunExecutionBackend()
      }
    );

    const formatted = JSON.parse(formatKeeperHubResponse(result)) as {
      dryRun: boolean;
      candidateExecutionMode?: string;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
    };

    expect(result.dryRun).toBe(true);
    expect(result.plan.planningRateBps).toBe(990);
    expect(result.plan.planningLookaheadUpdates).toBe(2);
    expect(formatted.dryRun).toBe(true);
    expect(formatted.candidateExecutionMode).toBe("advisory");
    expect(formatted.planningRateBps).toBe(990);
    expect(formatted.planningLookaheadUpdates).toBe(2);
  });

  it("marks inventory-backed plans in KeeperHub responses", () => {
    const response = formatKeeperHubResponse({
      dryRun: true,
      status: "NO_OP",
      reason: "managed remove-quote plan",
      poolId: "base:pool",
      chainId: 8453,
      snapshotFingerprint: "snapshot",
      transactionHashes: [],
      executedSteps: [],
      plan: {
        intent: "LEND",
        reason: "managed remove quote",
        targetBand: {
          minRateBps: 900,
          maxRateBps: 1100
        },
        requiredSteps: [
          {
            type: "REMOVE_QUOTE",
            amount: 100n,
            bucketIndex: 3000
          }
        ],
        predictedOutcomeAfterPlan: "STEP_UP",
        predictedRateBpsAfterNextUpdate: 1000,
        quoteTokenDelta: 100n,
        quoteInventoryDeployed: 0n,
        quoteInventoryReleased: 100n,
        additionalCollateralRequired: 0n,
        netQuoteBorrowed: 100n,
        operatorCapitalRequired: 0n,
        operatorCapitalAtRisk: 0n
      }
    });

    expect(response).toMatch(/"inventoryBacked":true/);
  });
});

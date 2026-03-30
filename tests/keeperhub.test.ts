import { describe, expect, it } from "vitest";

import { StepwiseExecutionBackend } from "../src/execute.js";
import { resolveKeeperHubPayload, runKeeperHubPayload } from "../src/keeperhub.js";

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
    expect(payload.snapshot.planningRateBps).toBe(1195);
    expect(payload.snapshot.planningLookaheadUpdates).toBe(3);
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
});

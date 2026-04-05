import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DryRunExecutionBackend, StepwiseExecutionBackend } from "../src/execute.js";
import { runCycle } from "../src/run-cycle.js";
import { StaticSnapshotSource } from "../src/snapshot.js";
import type { KeeperConfig, PoolSnapshot } from "../src/types.js";

const baseConfig: KeeperConfig = {
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
  minExecutableQuoteTokenAmount: 1n,
  minExecutableBorrowAmount: 1n,
  minExecutableCollateralAmount: 1n,
  recheckBeforeSubmit: true,
  allowHeuristicExecution: false
};

function buildSnapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    snapshotFingerprint: "same",
    poolId: "base:pool",
    chainId: 8453,
    blockNumber: 10n,
    blockTimestamp: 1_000,
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
            amount: 100n,
            bucketIndex: 1,
            expiry: 2_000
          },
          {
            type: "DRAW_DEBT",
            amount: 50n,
            limitIndex: 2
          }
        ],
        predictedOutcome: "STEP_UP",
        predictedRateBpsAfterNextUpdate: 950,
        resultingDistanceToTargetBps: 0,
        quoteTokenDelta: 150n,
        explanation: "dual side move"
      }
    ],
    ...overrides
  };
}

function buildPostAddQuoteSnapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return buildSnapshot({
    snapshotFingerprint: "after-add-quote",
    blockNumber: 11n,
    currentRateBps: 700,
    predictedNextOutcome: "STEP_UP",
    predictedNextRateBps: 800,
    candidates: [
      {
        id: "borrow-only",
        intent: "BORROW",
        minimumExecutionSteps: [
          {
            type: "DRAW_DEBT",
            amount: 50n,
            limitIndex: 2
          }
        ],
        predictedOutcome: "STEP_UP",
        predictedRateBpsAfterNextUpdate: 950,
        resultingDistanceToTargetBps: 0,
        quoteTokenDelta: 50n,
        explanation: "borrow-only follow-up remains valid"
      }
    ],
    ...overrides
  });
}

describe("runCycle", () => {
  it("marks dry-run cycles explicitly", async () => {
    const result = await runCycle(baseConfig, {
      snapshotSource: new StaticSnapshotSource([buildSnapshot()]),
      executor: new DryRunExecutionBackend()
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.dryRun).toBe(true);
    expect(result.reason).toMatch(/dry-run completed successfully/i);
  });

  it("returns a no-op when the natural move already converges", async () => {
    const result = await runCycle(baseConfig, {
      snapshotSource: new StaticSnapshotSource([
        buildSnapshot({
          predictedNextOutcome: "STEP_UP",
          predictedNextRateBps: 950,
          candidates: []
        })
      ]),
      executor: new StepwiseExecutionBackend({})
    });

    expect(result.status).toBe("NO_OP");
    expect(result.dryRun).toBe(false);
  });

  it("executes an update-only plan even when the top-level intent is NO_OP", async () => {
    const result = await runCycle(baseConfig, {
      snapshotSource: new StaticSnapshotSource([
        buildSnapshot({
          secondsUntilNextRateUpdate: 0,
          predictedNextOutcome: "STEP_UP",
          predictedNextRateBps: 950,
          candidates: []
        }),
        buildSnapshot({
          secondsUntilNextRateUpdate: 0,
          predictedNextOutcome: "STEP_UP",
          predictedNextRateBps: 950,
          candidates: []
        })
      ]),
      executor: new StepwiseExecutionBackend({
        UPDATE_INTEREST: async () => ({ transactionHash: "0xupdate" })
      })
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.transactionHashes).toEqual(["0xupdate"]);
  });

  it("executes and writes a structured run log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "keeper-run-"));
    const result = await runCycle(
      {
        ...baseConfig,
        logPath: join(directory, "runs.jsonl")
      },
      {
        snapshotSource: new StaticSnapshotSource([
          buildSnapshot(),
          buildSnapshot(),
          buildPostAddQuoteSnapshot()
        ]),
        executor: new StepwiseExecutionBackend({
          ADD_QUOTE: async () => ({ transactionHash: "0xadd" }),
          DRAW_DEBT: async () => ({ transactionHash: "0xdraw" })
        })
      }
    );

    expect(result.status).toBe("EXECUTED");
    expect(result.transactionHashes).toEqual(["0xadd", "0xdraw"]);

    const contents = await readFile(join(directory, "runs.jsonl"), "utf8");
    expect(contents).toContain("\"status\":\"EXECUTED\"");
  });

  it("surfaces partial failures", async () => {
    const result = await runCycle(baseConfig, {
      snapshotSource: new StaticSnapshotSource([
        buildSnapshot(),
        buildSnapshot(),
        buildPostAddQuoteSnapshot()
      ]),
      executor: new StepwiseExecutionBackend({
        ADD_QUOTE: async () => ({ transactionHash: "0xadd" }),
        DRAW_DEBT: async () => {
          throw new Error("borrow failed");
        }
      })
    });

    expect(result.status).toBe("PARTIAL_FAILURE");
    expect(result.transactionHashes).toEqual(["0xadd"]);
    expect(result.failedStepIndex).toBe(1);
  });

  it("rechecks after the first step and stops cleanly if no remaining step is needed", async () => {
    const result = await runCycle(baseConfig, {
      snapshotSource: new StaticSnapshotSource([
        buildSnapshot(),
        buildSnapshot(),
        buildPostAddQuoteSnapshot({
          currentRateBps: 950,
          predictedNextRateBps: 1000,
          candidates: []
        })
      ]),
      executor: new StepwiseExecutionBackend({
        ADD_QUOTE: async () => ({ transactionHash: "0xadd" }),
        DRAW_DEBT: async () => ({ transactionHash: "0xdraw" })
      })
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.transactionHashes).toEqual(["0xadd"]);
    expect(result.executedSteps).toHaveLength(1);
  });

  it("rechecks after the first step and surfaces a partial failure when the remaining step changes", async () => {
    const result = await runCycle(baseConfig, {
      snapshotSource: new StaticSnapshotSource([
        buildSnapshot(),
        buildSnapshot(),
        buildPostAddQuoteSnapshot({
          candidates: [
            {
              id: "changed-borrow",
              intent: "BORROW",
              minimumExecutionSteps: [
                {
                  type: "DRAW_DEBT",
                  amount: 60n,
                  limitIndex: 2
                }
              ],
              predictedOutcome: "STEP_UP",
              predictedRateBpsAfterNextUpdate: 960,
              resultingDistanceToTargetBps: 0,
              quoteTokenDelta: 60n,
              explanation: "remaining borrow amount changed"
            }
          ]
        })
      ]),
      executor: new StepwiseExecutionBackend({
        ADD_QUOTE: async () => ({ transactionHash: "0xadd" }),
        DRAW_DEBT: async () => ({ transactionHash: "0xdraw" })
      })
    });

    expect(result.status).toBe("PARTIAL_FAILURE");
    expect(result.transactionHashes).toEqual(["0xadd"]);
    expect(result.failedStepIndex).toBe(1);
    expect(result.error).toMatch(/remaining step is no longer valid/i);
  });
});

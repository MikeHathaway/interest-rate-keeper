import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StepwiseExecutionBackend } from "../src/execute.js";
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
  minExecutableActionQuoteToken: 1n,
  recheckBeforeSubmit: true
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

describe("runCycle", () => {
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
        snapshotSource: new StaticSnapshotSource([buildSnapshot(), buildSnapshot()]),
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
      snapshotSource: new StaticSnapshotSource([buildSnapshot(), buildSnapshot()]),
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
});

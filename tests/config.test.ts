import { describe, expect, it } from "vitest";

import { resolveKeeperConfig } from "../src/config.js";

describe("resolveKeeperConfig", () => {
  it("parses a valid config", () => {
    const config = resolveKeeperConfig({
      chainId: 8453,
      poolId: "base:pool",
      targetRateBps: 1200,
      toleranceBps: 1000,
      poolAddress: "0x1111111111111111111111111111111111111111",
      rpcUrl: "https://base.example.invalid",
      addQuoteBucketIndex: 3000,
      addQuoteExpirySeconds: 7200,
      enableSimulationBackedLendSynthesis: true,
      enableSimulationBackedBorrowSynthesis: true,
      simulationSenderAddress: "0x2222222222222222222222222222222222222222",
      drawDebtLimitIndex: 3100,
      drawDebtLimitIndexes: [2800, 3000, 3100],
      drawDebtCollateralAmount: "2500000000000000000",
      enableHeuristicLendSynthesis: true,
      maxQuoteTokenExposure: "1000000",
      maxBorrowExposure: "500000"
    });

    expect(config.toleranceMode).toBe("relative");
    expect(config.executionBufferBps).toBe(50);
    expect(config.maxQuoteTokenExposure).toBe(1000000n);
    expect(config.poolAddress).toBe("0x1111111111111111111111111111111111111111");
    expect(config.rpcUrl).toBe("https://base.example.invalid");
    expect(config.addQuoteBucketIndex).toBe(3000);
    expect(config.addQuoteExpirySeconds).toBe(7200);
    expect(config.enableSimulationBackedLendSynthesis).toBe(true);
    expect(config.enableSimulationBackedBorrowSynthesis).toBe(true);
    expect(config.simulationSenderAddress).toBe("0x2222222222222222222222222222222222222222");
    expect(config.drawDebtLimitIndex).toBe(3100);
    expect(config.drawDebtLimitIndexes).toEqual([2800, 3000, 3100]);
    expect(config.drawDebtCollateralAmount).toBe(2500000000000000000n);
    expect(config.enableHeuristicLendSynthesis).toBe(true);
  });

  it("parses manual candidates", () => {
    const config = resolveKeeperConfig({
      chainId: 8453,
      poolAddress: "0x1111111111111111111111111111111111111111",
      targetRateBps: 1200,
      toleranceBps: 1000,
      maxQuoteTokenExposure: "1000000",
      maxBorrowExposure: "500000",
      manualCandidates: [
        {
          id: "lend",
          intent: "LEND",
          minimumExecutionSteps: [
            {
              type: "ADD_QUOTE",
              amount: "100",
              bucketIndex: 1,
              expiry: 2_000
            }
          ],
          predictedOutcome: "STEP_UP",
          predictedRateBpsAfterNextUpdate: 1100,
          resultingDistanceToTargetBps: 0,
          quoteTokenDelta: "100",
          explanation: "manual lend"
        }
      ]
    });

    expect(config.poolId).toBe("8453:0x1111111111111111111111111111111111111111");
    expect(config.manualCandidates).toHaveLength(1);
  });

  it("rejects invalid completion policy", () => {
    expect(() =>
      resolveKeeperConfig({
        chainId: 1,
        poolId: "pool",
        targetRateBps: 1000,
        toleranceBps: 500,
        completionPolicy: "bad",
        maxQuoteTokenExposure: "1",
        maxBorrowExposure: "1"
      })
    ).toThrow(/completionPolicy/);
  });
});

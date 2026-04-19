import { describe, expect, it } from "vitest";

import { parseCliArgs, resolveKeeperConfig } from "../src/core/config/config.js";

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
      addQuoteBucketIndexes: [2800, 3000, 3200],
      removeQuoteBucketIndex: 2900,
      removeQuoteBucketIndexes: [2800, 2900, 3000],
      addQuoteExpirySeconds: 7200,
      enableSimulationBackedLendSynthesis: true,
      enableSimulationBackedBorrowSynthesis: true,
      enableManagedInventoryUpwardControl: true,
      enableManagedDualUpwardControl: true,
      minimumManagedImprovementBps: 15,
      maxManagedInventoryReleaseBps: 2500,
      minimumManagedSensitivityBpsPer10PctRelease: 5,
      simulationSenderAddress: "0x2222222222222222222222222222222222222222",
      drawDebtLimitIndex: 3100,
      drawDebtLimitIndexes: [2800, 3000, 3100],
      drawDebtCollateralAmount: "2500000000000000000",
      drawDebtCollateralAmounts: ["1000000000000000000", "2500000000000000000"],
      borrowSimulationLookaheadUpdates: 2,
      enableHeuristicLendSynthesis: true,
      enableHeuristicBorrowSynthesis: true,
      maxQuoteTokenExposure: "1000000",
      maxBorrowExposure: "500000"
    });

    expect(config.toleranceMode).toBe("relative");
    expect(config.executionBufferBps).toBe(50);
    expect(config.maxQuoteTokenExposure).toBe(1000000n);
    expect(config.minExecutableQuoteTokenAmount).toBe(1n);
    expect(config.minExecutableBorrowAmount).toBe(1n);
    expect(config.minExecutableCollateralAmount).toBe(1n);
    expect(config.allowHeuristicExecution).toBe(false);
    expect(config.poolAddress).toBe("0x1111111111111111111111111111111111111111");
    expect(config.rpcUrl).toBe("https://base.example.invalid");
    expect(config.addQuoteBucketIndex).toBe(3000);
    expect(config.addQuoteBucketIndexes).toEqual([2800, 3000, 3200]);
    expect(config.removeQuoteBucketIndex).toBe(2900);
    expect(config.removeQuoteBucketIndexes).toEqual([2800, 2900, 3000]);
    expect(config.addQuoteExpirySeconds).toBe(7200);
    expect(config.enableSimulationBackedLendSynthesis).toBe(true);
    expect(config.enableSimulationBackedBorrowSynthesis).toBe(true);
    expect(config.enableManagedInventoryUpwardControl).toBe(true);
    expect(config.enableManagedDualUpwardControl).toBe(true);
    expect(config.minimumManagedImprovementBps).toBe(15);
    expect(config.maxManagedInventoryReleaseBps).toBe(2500);
    expect(config.minimumManagedSensitivityBpsPer10PctRelease).toBe(5);
    expect(config.simulationSenderAddress).toBe("0x2222222222222222222222222222222222222222");
    expect(config.drawDebtLimitIndex).toBe(3100);
    expect(config.drawDebtLimitIndexes).toEqual([2800, 3000, 3100]);
    expect(config.drawDebtCollateralAmount).toBe(2500000000000000000n);
    expect(config.drawDebtCollateralAmounts).toEqual([
      1000000000000000000n,
      2500000000000000000n
    ]);
    expect(config.borrowSimulationLookaheadUpdates).toBe(2);
    expect(config.enableHeuristicLendSynthesis).toBe(true);
    expect(config.enableHeuristicBorrowSynthesis).toBe(true);
  });

  it("supports split executable floors and the heuristic execution toggle", () => {
    const config = resolveKeeperConfig({
      chainId: 8453,
      poolId: "base:pool",
      targetRateBps: 1200,
      toleranceBps: 1000,
      maxQuoteTokenExposure: "1000000",
      maxBorrowExposure: "500000",
      minExecutableQuoteTokenAmount: "11",
      minExecutableBorrowAmount: "22",
      minExecutableCollateralAmount: "33",
      allowHeuristicExecution: true
    });

    expect(config.minExecutableQuoteTokenAmount).toBe(11n);
    expect(config.minExecutableBorrowAmount).toBe(22n);
    expect(config.minExecutableCollateralAmount).toBe(33n);
    expect(config.allowHeuristicExecution).toBe(true);
  });

  it("rejects managed inventory release caps above 10000 bps", () => {
    expect(() =>
      resolveKeeperConfig({
        chainId: 8453,
        poolId: "base:pool",
        targetRateBps: 1200,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000000",
        maxBorrowExposure: "500000",
        maxManagedInventoryReleaseBps: 10001
      })
    ).toThrow(/maxManagedInventoryReleaseBps/);
  });

  it("rejects maxManagedInventoryReleaseBps = 0", () => {
    expect(() =>
      resolveKeeperConfig({
        chainId: 8453,
        poolId: "base:pool",
        targetRateBps: 1200,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000000",
        maxBorrowExposure: "500000",
        maxManagedInventoryReleaseBps: 0
      })
    ).toThrow(/greater than zero/);
  });

  it("rejects enableManagedDualUpwardControl without enableManagedInventoryUpwardControl", () => {
    expect(() =>
      resolveKeeperConfig({
        chainId: 8453,
        poolId: "base:pool",
        targetRateBps: 1200,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000000",
        maxBorrowExposure: "500000",
        enableManagedDualUpwardControl: true
      })
    ).toThrow(/enableManagedInventoryUpwardControl/);
  });

  it("rejects empty removeQuoteBucketIndexes", () => {
    expect(() =>
      resolveKeeperConfig({
        chainId: 8453,
        poolId: "base:pool",
        targetRateBps: 1200,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000000",
        maxBorrowExposure: "500000",
        removeQuoteBucketIndexes: []
      })
    ).toThrow(/must not be empty/);
  });

  it("de-duplicates and sorts removeQuoteBucketIndexes", () => {
    const config = resolveKeeperConfig({
      chainId: 8453,
      poolId: "base:pool",
      targetRateBps: 1200,
      toleranceBps: 1000,
      maxQuoteTokenExposure: "1000000",
      maxBorrowExposure: "500000",
      removeQuoteBucketIndexes: [3000, 2800, 3000, 2900]
    });
    expect(config.removeQuoteBucketIndexes).toEqual([2800, 2900, 3000]);
  });

  it("rejects non-boolean enableManagedInventoryUpwardControl", () => {
    expect(() =>
      resolveKeeperConfig({
        chainId: 8453,
        poolId: "base:pool",
        targetRateBps: 1200,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000000",
        maxBorrowExposure: "500000",
        enableManagedInventoryUpwardControl: "yes"
      })
    ).toThrow(/enableManagedInventoryUpwardControl/);
  });

  it("rejects negative minimumManagedImprovementBps", () => {
    expect(() =>
      resolveKeeperConfig({
        chainId: 8453,
        poolId: "base:pool",
        targetRateBps: 1200,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000000",
        maxBorrowExposure: "500000",
        minimumManagedImprovementBps: -5
      })
    ).toThrow(/minimumManagedImprovementBps/);
  });

  it("rejects negative minimumManagedSensitivityBpsPer10PctRelease", () => {
    expect(() =>
      resolveKeeperConfig({
        chainId: 8453,
        poolId: "base:pool",
        targetRateBps: 1200,
        toleranceBps: 1000,
        maxQuoteTokenExposure: "1000000",
        maxBorrowExposure: "500000",
        minimumManagedSensitivityBpsPer10PctRelease: -1
      })
    ).toThrow(/minimumManagedSensitivityBpsPer10PctRelease/);
  });

  it("maps the legacy minExecutableActionQuoteToken field onto all action floors", () => {
    const config = resolveKeeperConfig({
      chainId: 8453,
      poolId: "base:pool",
      targetRateBps: 1200,
      toleranceBps: 1000,
      maxQuoteTokenExposure: "1000000",
      maxBorrowExposure: "500000",
      minExecutableActionQuoteToken: "7"
    });

    expect(config.minExecutableQuoteTokenAmount).toBe(7n);
    expect(config.minExecutableBorrowAmount).toBe(7n);
    expect(config.minExecutableCollateralAmount).toBe(7n);
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
          explanation: "manual lend",
          planningRateBps: 1195,
          planningLookaheadUpdates: 3
        }
      ]
    });

    expect(config.poolId).toBe("8453:0x1111111111111111111111111111111111111111");
    expect(config.manualCandidates).toHaveLength(1);
    expect(config.manualCandidates?.[0]?.planningRateBps).toBe(1195);
    expect(config.manualCandidates?.[0]?.planningLookaheadUpdates).toBe(3);
    expect(config.manualCandidates?.[0]?.additionalCollateralRequired).toBe(0n);
    expect(config.manualCandidates?.[0]?.netQuoteBorrowed).toBe(-100n);
    expect(config.manualCandidates?.[0]?.operatorCapitalRequired).toBe(100n);
    expect(config.manualCandidates?.[0]?.operatorCapitalAtRisk).toBe(100n);
  });

  it("derives borrower capital metrics for manual candidates", () => {
    const config = resolveKeeperConfig({
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
              limitIndex: 3000,
              collateralAmount: "25"
            }
          ],
          predictedOutcome: "STEP_UP",
          predictedRateBpsAfterNextUpdate: 1100,
          resultingDistanceToTargetBps: 0,
          quoteTokenDelta: "100",
          explanation: "manual borrow"
        }
      ]
    });

    expect(config.manualCandidates?.[0]?.additionalCollateralRequired).toBe(25n);
    expect(config.manualCandidates?.[0]?.netQuoteBorrowed).toBe(100n);
    expect(config.manualCandidates?.[0]?.operatorCapitalRequired).toBe(25n);
    expect(config.manualCandidates?.[0]?.operatorCapitalAtRisk).toBe(25n);
  });

  it("rejects manual candidates with non-integer step indexes", () => {
    expect(() =>
      resolveKeeperConfig({
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
                bucketIndex: 1.5,
                expiry: 2000
              }
            ],
            predictedOutcome: "STEP_UP",
            predictedRateBpsAfterNextUpdate: 1100,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: "100",
            explanation: "bad lend"
          }
        ]
      })
    ).toThrow(/bucketIndex/);
  });

  it("rejects manual candidates with negative step amounts", () => {
    expect(() =>
      resolveKeeperConfig({
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
                amount: "-100",
                limitIndex: 3000
              }
            ],
            predictedOutcome: "STEP_UP",
            predictedRateBpsAfterNextUpdate: 1100,
            resultingDistanceToTargetBps: 0,
            quoteTokenDelta: "100",
            explanation: "bad borrow"
          }
        ]
      })
    ).toThrow(/amount/);
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

  it("parses the CLI summary flag", () => {
    expect(
      parseCliArgs(["run", "--config", "./keeper.config.json", "--dry-run", "--summary"])
    ).toEqual({
      mode: "run",
      configPath: "./keeper.config.json",
      dryRun: true,
      summary: true
    });
  });
});

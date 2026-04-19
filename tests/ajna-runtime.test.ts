import { describe, expect, it } from "vitest";

import {
  assertGasCostWithinCap,
  estimateGasCostWei
} from "../src/ajna/adapter/executor.js";
import { resolveAjnaSignerAddress } from "../src/ajna/adapter/runtime.js";
import { resolveSimulationExecutionCompatibility } from "../src/ajna/adapter/synthesis-policy.js";
import type { KeeperConfig } from "../src/core/types.js";

const baseConfig: KeeperConfig = {
  chainId: 8453,
  poolId: "base:pool",
  targetRateBps: 1000,
  toleranceBps: 1000,
  toleranceMode: "relative",
  completionPolicy: "next_move_would_overshoot",
  executionBufferBps: 50,
  maxQuoteTokenExposure: 1_000_000n,
  maxBorrowExposure: 1_000_000n,
  snapshotAgeMaxSeconds: 90,
  minTimeBeforeRateWindowSeconds: 120,
  minExecutableQuoteTokenAmount: 1n,
  minExecutableBorrowAmount: 1n,
  minExecutableCollateralAmount: 1n,
  recheckBeforeSubmit: true,
  allowHeuristicExecution: false
};

describe("ajna runtime helpers", () => {
  it("derives signer addresses from the configured private key env", () => {
    const signer = resolveAjnaSignerAddress({
      AJNA_KEEPER_PRIVATE_KEY:
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    });

    expect(signer).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("marks simulation execution as incompatible when the simulation sender differs from the live signer", () => {
    const compatibility = resolveSimulationExecutionCompatibility(
      {
        ...baseConfig,
        simulationSenderAddress: "0x0000000000000000000000000000000000000001"
      },
      {
        AJNA_KEEPER_PRIVATE_KEY:
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      }
    );

    expect(compatibility.executionCompatible).toBe(false);
    expect(compatibility.reason).toMatch(/different sender/i);
  });

  it("estimates gas cost in wei and enforces maxGasCostWei", () => {
    expect(estimateGasCostWei(21_000n, 100n)).toBe(2_100_000n);

    expect(() =>
      assertGasCostWithinCap(21_000n, 100n, 2_000_000n, "updateInterest")
    ).toThrow(/maxGasCostWei/i);

    expect(() =>
      assertGasCostWithinCap(21_000n, 100n, 2_100_000n, "updateInterest")
    ).not.toThrow();
  });
});

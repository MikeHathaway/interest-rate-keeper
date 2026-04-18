import { describe, expect, it, vi } from "vitest";

import {
  buildSimulationPreamble,
  resolveEffectiveAccountState
} from "../src/ajna/snapshot-sim-context.js";
import type { AjnaPoolStateRead } from "../src/ajna/snapshot-internal.js";
import type { AjnaRatePrediction } from "../src/ajna/rate-state.js";
import { baseConfig } from "./ajna-test-fixtures.js";

const POOL_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const SENDER = "0x2222222222222222222222222222222222222222" as const;
const BORROWER = "0x3333333333333333333333333333333333333333" as const;

const baseReadState = {
  blockNumber: 10n,
  blockTimestamp: 1_000,
  rateState: {
    currentRateWad: 100_000_000_000_000_000n,
    currentDebtWad: 500n,
    debtEmaWad: 1n,
    depositEmaWad: 1n,
    debtColEmaWad: 1n,
    lupt0DebtEmaWad: 1n,
    lastInterestRateUpdateTimestamp: 900,
    nowTimestamp: 1_000
  },
  prediction: {
    predictedOutcome: "NO_CHANGE" as const,
    predictedNextRateWad: 100_000_000_000_000_000n,
    predictedNextRateBps: 900,
    secondsUntilNextRateUpdate: 3600
  },
  immediatePrediction: {
    predictedOutcome: "NO_CHANGE" as const,
    predictedNextRateWad: 100_000_000_000_000_000n,
    predictedNextRateBps: 900,
    secondsUntilNextRateUpdate: 3600
  },
  inflatorWad: 1n,
  totalT0Debt: 1n,
  totalT0DebtInAuction: 0n,
  t0Debt2ToCollateralWad: 1n,
  quoteTokenAddress: "0xaaaa000000000000000000000000000000000000" as const,
  collateralAddress: "0xbbbb000000000000000000000000000000000000" as const,
  quoteTokenScale: 1n,
  poolType: 0
} satisfies AjnaPoolStateRead;

describe("buildSimulationPreamble", () => {
  // Supply an accountState so the sender resolution doesn't fall through to
  // env-var lookup (which throws outside a configured execution environment).
  const senderAccountState = {
    simulationSenderAddress: SENDER,
    borrowerAddress: BORROWER
  } as const;

  it("flags baselineInBand=true when the baseline prediction lands in band", () => {
    const preamble = buildSimulationPreamble(
      baseReadState,
      { ...baseConfig, targetRateBps: 900, toleranceBps: 50, toleranceMode: "absolute" },
      { poolAddress: POOL_ADDRESS, accountState: senderAccountState }
    );
    expect(preamble.baselineInBand).toBe(true);
  });

  it("flags baselineInBand=false when the baseline is outside the band", () => {
    const preamble = buildSimulationPreamble(
      baseReadState,
      { ...baseConfig, targetRateBps: 1200, toleranceBps: 50, toleranceMode: "absolute" },
      { poolAddress: POOL_ADDRESS, accountState: senderAccountState }
    );
    expect(preamble.baselineInBand).toBe(false);
  });

  it("uses accountState.simulationSenderAddress when provided", () => {
    const preamble = buildSimulationPreamble(baseReadState, baseConfig, {
      poolAddress: POOL_ADDRESS,
      accountState: {
        simulationSenderAddress: SENDER,
        borrowerAddress: BORROWER
      }
    });
    expect(preamble.simulationSenderAddress).toBe(SENDER);
    expect(preamble.borrowerAddress).toBe(BORROWER);
  });

  it("produces a stable snapshotFingerprint for identical inputs", () => {
    const a = buildSimulationPreamble(baseReadState, baseConfig, {
      poolAddress: POOL_ADDRESS,
      accountState: { simulationSenderAddress: SENDER, borrowerAddress: BORROWER }
    });
    const b = buildSimulationPreamble(baseReadState, baseConfig, {
      poolAddress: POOL_ADDRESS,
      accountState: { simulationSenderAddress: SENDER, borrowerAddress: BORROWER }
    });
    expect(a.snapshotFingerprint).toBe(b.snapshotFingerprint);
  });
});

describe("resolveEffectiveAccountState", () => {
  it("returns the supplied accountState without issuing any RPC call", async () => {
    const mockClient = {
      multicall: vi.fn(),
      readContract: vi.fn(),
      getBlock: vi.fn()
    };
    const accountState = {
      simulationSenderAddress: SENDER,
      borrowerAddress: BORROWER
    };

    const result = await resolveEffectiveAccountState(
      mockClient as never,
      baseReadState,
      baseConfig,
      {
        poolAddress: POOL_ADDRESS,
        accountState,
        needsQuoteState: true,
        needsCollateralState: true
      }
    );

    expect(result).toBe(accountState);
    expect(mockClient.multicall).not.toHaveBeenCalled();
    expect(mockClient.readContract).not.toHaveBeenCalled();
  });
});

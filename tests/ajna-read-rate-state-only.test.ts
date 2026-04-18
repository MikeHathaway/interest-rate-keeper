import { describe, expect, it, vi, beforeEach } from "vitest";

import { clearAjnaSnapshotCaches } from "../src/ajna/snapshot.js";
import { readAjnaPoolRateStateOnly } from "../src/ajna/snapshot-read.js";

const POOL = "0x1111111111111111111111111111111111111111" as const;

function makeMockClient(overrides?: {
  interestRateInfo?: readonly [bigint, bigint];
  debtInfo?: readonly [bigint, bigint, bigint, bigint];
  emasInfo?: readonly [bigint, bigint, bigint, bigint];
  blockNumber?: bigint;
  blockTimestamp?: bigint;
}) {
  const interestRateInfo = overrides?.interestRateInfo ?? [100_000_000_000_000_000n, 1_700_000_000n];
  const debtInfo = overrides?.debtInfo ?? [500n, 0n, 0n, 0n];
  const emasInfo = overrides?.emasInfo ?? [11n, 22n, 33n, 44n];
  return {
    chain: { id: 8453, contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } },
    getBlock: vi.fn().mockResolvedValue({
      number: overrides?.blockNumber ?? 10n,
      timestamp: overrides?.blockTimestamp ?? 1_700_000_100n
    }),
    multicall: vi.fn().mockResolvedValue([interestRateInfo, debtInfo, emasInfo])
  };
}

describe("readAjnaPoolRateStateOnly", () => {
  beforeEach(() => {
    clearAjnaSnapshotCaches();
  });

  it("maps interestRateInfo tuple to currentRateWad and lastInterestRateUpdateTimestamp", async () => {
    const client = makeMockClient({
      interestRateInfo: [123_456_789_000_000_000n, 1_700_000_000n]
    });
    const snap = await readAjnaPoolRateStateOnly(client as never, POOL);
    expect(snap.rateState.currentRateWad).toBe(123_456_789_000_000_000n);
    expect(snap.rateState.lastInterestRateUpdateTimestamp).toBe(1_700_000_000);
  });

  it("maps debtInfo[0] to currentDebtWad (other slots ignored)", async () => {
    const client = makeMockClient({ debtInfo: [999n, 1n, 2n, 3n] });
    const snap = await readAjnaPoolRateStateOnly(client as never, POOL);
    expect(snap.rateState.currentDebtWad).toBe(999n);
  });

  it("maps emasInfo tuple order: [debtColEma, lupt0DebtEma, debtEma, depositEma]", async () => {
    const client = makeMockClient({ emasInfo: [11n, 22n, 33n, 44n] });
    const snap = await readAjnaPoolRateStateOnly(client as never, POOL);
    expect(snap.rateState.debtColEmaWad).toBe(11n);
    expect(snap.rateState.lupt0DebtEmaWad).toBe(22n);
    expect(snap.rateState.debtEmaWad).toBe(33n);
    expect(snap.rateState.depositEmaWad).toBe(44n);
  });

  it("defaults nowTimestamp to block.timestamp when nowSeconds is not supplied", async () => {
    const client = makeMockClient({ blockTimestamp: 1_700_123_456n });
    const snap = await readAjnaPoolRateStateOnly(client as never, POOL);
    expect(snap.rateState.nowTimestamp).toBe(1_700_123_456);
  });

  it("respects explicit nowSeconds override", async () => {
    const client = makeMockClient();
    const snap = await readAjnaPoolRateStateOnly(client as never, POOL, 9_999_999);
    expect(snap.rateState.nowTimestamp).toBe(9_999_999);
  });

  it("pins getBlock + multicall to the supplied blockNumber", async () => {
    const client = makeMockClient();
    // Make getBlock echo back whatever blockNumber it was asked about so we
    // can verify the multicall uses that block too.
    client.getBlock = vi.fn().mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
      number: blockNumber ?? 10n,
      timestamp: 1_700_000_100n
    }));
    await readAjnaPoolRateStateOnly(client as never, POOL, undefined, 500n);
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: 500n });
    expect(client.multicall).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 500n })
    );
  });
});

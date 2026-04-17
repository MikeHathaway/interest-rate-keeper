import { describe, expect, it } from "vitest";

import {
  ceilDiv,
  managedImprovementBps,
  maximumManagedReleasedQuoteAmount,
  normalizedManagedSensitivityBpsPer10PctRelease,
  releasedQuoteInventoryAmount,
  stepsUseManagedDual,
  stepsUseManagedRemoveQuote
} from "../src/managed-controls.js";

describe("managedImprovementBps", () => {
  it("is positive when candidate reduces distance", () => {
    expect(managedImprovementBps(100, 60)).toBe(40);
  });

  it("is zero when candidate ties baseline", () => {
    expect(managedImprovementBps(50, 50)).toBe(0);
  });

  it("is negative when candidate makes things worse", () => {
    expect(managedImprovementBps(20, 30)).toBe(-10);
  });
});

describe("maximumManagedReleasedQuoteAmount", () => {
  it("returns the total when cap is 10000 bps", () => {
    expect(maximumManagedReleasedQuoteAmount(1000n, 10_000)).toBe(1000n);
  });

  it("returns zero when cap is 0 bps", () => {
    expect(maximumManagedReleasedQuoteAmount(1000n, 0)).toBe(0n);
  });

  it("truncates when total * bps is not divisible by 10000", () => {
    expect(maximumManagedReleasedQuoteAmount(7n, 5_000)).toBe(3n);
  });
});

describe("normalizedManagedSensitivityBpsPer10PctRelease", () => {
  it("returns undefined when improvement is non-positive", () => {
    expect(normalizedManagedSensitivityBpsPer10PctRelease(0, 100n, 1_000n)).toBeUndefined();
    expect(normalizedManagedSensitivityBpsPer10PctRelease(-5, 100n, 1_000n)).toBeUndefined();
  });

  it("returns undefined when released is zero", () => {
    expect(normalizedManagedSensitivityBpsPer10PctRelease(50, 0n, 1_000n)).toBeUndefined();
  });

  it("returns undefined when total withdrawable is zero", () => {
    expect(normalizedManagedSensitivityBpsPer10PctRelease(50, 100n, 0n)).toBeUndefined();
  });

  it("computes sensitivity per 10% release using ceilDiv on the fraction", () => {
    // 100 / 1000 = 10% -> releaseFractionBps = 1000
    // improvement 50bps -> normalized = (50 * 1000) / 1000 = 50n
    expect(normalizedManagedSensitivityBpsPer10PctRelease(50, 100n, 1_000n)).toBe(50n);
  });

  it("keeps tiny releases visible via ceil rounding", () => {
    // 1 / 1_000_000 rounds up to fractionBps = 1 -> normalized = 10 * 1000 / 1 = 10_000n
    expect(
      normalizedManagedSensitivityBpsPer10PctRelease(10, 1n, 1_000_000n)
    ).toBe(10_000n);
  });
});

describe("stepsUseManagedRemoveQuote / stepsUseManagedDual", () => {
  it("returns false for empty step arrays", () => {
    expect(stepsUseManagedDual([])).toBe(false);
    expect(stepsUseManagedRemoveQuote([])).toBe(false);
  });

  it("returns true for remove-quote-only when asked", () => {
    const steps = [
      { type: "REMOVE_QUOTE" as const, amount: 1n, bucketIndex: 1 }
    ];
    expect(stepsUseManagedRemoveQuote(steps)).toBe(true);
    expect(stepsUseManagedDual(steps)).toBe(false);
  });

  it("returns true for dual when REMOVE_QUOTE + DRAW_DEBT both present", () => {
    const steps = [
      { type: "REMOVE_QUOTE" as const, amount: 1n, bucketIndex: 1 },
      { type: "DRAW_DEBT" as const, amount: 1n, limitIndex: 1 }
    ];
    expect(stepsUseManagedDual(steps)).toBe(true);
  });
});

describe("releasedQuoteInventoryAmount", () => {
  it("sums only REMOVE_QUOTE amounts", () => {
    expect(
      releasedQuoteInventoryAmount([
        { type: "REMOVE_QUOTE", amount: 10n, bucketIndex: 1 },
        { type: "ADD_QUOTE", amount: 99n, bucketIndex: 2, expiry: 0 },
        { type: "REMOVE_QUOTE", amount: 5n, bucketIndex: 3 }
      ])
    ).toBe(15n);
  });

  it("returns 0 for empty steps", () => {
    expect(releasedQuoteInventoryAmount([])).toBe(0n);
  });
});

describe("ceilDiv", () => {
  it("rounds up non-exact division", () => {
    expect(ceilDiv(5n, 2n)).toBe(3n);
  });

  it("is exact when divisible", () => {
    expect(ceilDiv(4n, 2n)).toBe(2n);
  });

  it("returns 1n for 1n / n when n >= 1", () => {
    expect(ceilDiv(1n, 1_000n)).toBe(1n);
  });
});

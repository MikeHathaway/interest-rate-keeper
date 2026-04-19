import { describe, expect, it } from "vitest";

import { calculateMaxWithdrawableQuoteAmountFromLp } from "../src/ajna/read/pool-state.js";

const WAD = 1_000_000_000_000_000_000n;

describe("calculateMaxWithdrawableQuoteAmountFromLp", () => {
  it("converts lender LP into the lender's quote-token share", () => {
    const quoteAmount = calculateMaxWithdrawableQuoteAmountFromLp({
      bucketLPAccumulator: 100n * WAD,
      availableCollateral: 0n,
      bucketDeposit: 80n * WAD,
      lenderLpBalance: 25n * WAD,
      bucketPriceWad: WAD
    });

    expect(quoteAmount).toBe(20n * WAD);
  });

  it("caps the lender quote amount at the bucket deposit", () => {
    const quoteAmount = calculateMaxWithdrawableQuoteAmountFromLp({
      bucketLPAccumulator: 10n * WAD,
      availableCollateral: 10n * WAD,
      bucketDeposit: 10n * WAD,
      lenderLpBalance: 10n * WAD,
      bucketPriceWad: 2n * WAD
    });

    expect(quoteAmount).toBe(10n * WAD);
  });
});

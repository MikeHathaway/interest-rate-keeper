import {
  forecastAjnaNextEligibleRate,
  type RateMoveOutcome
} from "../../src/index.js";

export const WAD = 1_000_000_000_000_000_000n;
export const TWELVE_HOURS_SECONDS = 12 * 60 * 60;
export const FORK_TIME_SKIP_SECONDS = 12 * 60 * 60 + 5;
export const AJNA_COLLATERALIZATION_FACTOR_WAD = 1_040_000_000_000_000_000n;
export const AJNA_FLOAT_STEP = 1.005;

type DepositEntry = {
  amount: bigint;
  bucketIndex: number;
};

export function wmul(left: bigint, right: bigint): bigint {
  return (left * right + 500_000_000_000_000_000n) / 1_000_000_000_000_000_000n;
}

export function wdiv(left: bigint, right: bigint): bigint {
  if (right === 0n) {
    return 0n;
  }

  return (left * 1_000_000_000_000_000_000n + right / 2n) / right;
}

// Kept in sync with src/ajna/protocol-constants.ts priceToFenwickIndex —
// same defensive guards against non-finite / non-positive inputs. Falls back
// to MAX (7388) when math degenerates, matching the `?? MAX_AJNA_LIMIT_INDEX`
// call-site pattern used in production (protocol-approx.ts).
export function priceToFenwickIndex(priceWad: bigint): number {
  const price = Number(priceWad) / 1e18;
  if (!Number.isFinite(price) || price <= 0) {
    return 7388;
  }

  const rawIndex = Math.log(price) / Math.log(AJNA_FLOAT_STEP);
  const ceilIndex = Math.ceil(rawIndex);
  const fenwickIndex =
    rawIndex < 0 && ceilIndex - rawIndex > 0.5 ? 4157 - ceilIndex : 4156 - ceilIndex;

  if (!Number.isFinite(fenwickIndex)) {
    return 7388;
  }

  return Math.max(0, Math.min(7388, fenwickIndex));
}

export function fenwickIndexToPriceWad(index: number): bigint {
  const bucketIndex = 4156 - index;
  const price = AJNA_FLOAT_STEP ** bucketIndex;
  return BigInt(Math.round(price * 1e18));
}

export function deriveRequiredCollateralWad(
  amountWad: bigint,
  limitIndex: number,
  multiplierBps = 10_500
): bigint {
  const priceWad = fenwickIndexToPriceWad(limitIndex);
  const baseCollateralWad = wdiv(wmul(amountWad, AJNA_COLLATERALIZATION_FACTOR_WAD), priceWad);
  return (baseCollateralWad * BigInt(multiplierBps) + 9_999n) / 10_000n;
}

export function ceilWdiv(left: bigint, right: bigint): bigint {
  if (right === 0n) {
    return 0n;
  }

  return (left * WAD + right - 1n) / right;
}

export function borrowFeeRateWad(rateWad: bigint): bigint {
  const weeklyRate = wdiv(rateWad, 52n * WAD);
  const minimumFeeRate = 500_000_000_000_000n;
  return weeklyRate > minimumFeeRate ? weeklyRate : minimumFeeRate;
}

export function wadToFloat(value: bigint): number {
  return Number(value) / 1e18;
}

export function floatToWad(value: number): bigint {
  return BigInt(Math.round(value * 1e18));
}

export function pendingInflatorApproxWad(
  inflatorWad: bigint,
  rateWad: bigint,
  elapsedSeconds: number
): bigint {
  const factor = Math.exp((wadToFloat(rateWad) * elapsedSeconds) / (365 * 24 * 60 * 60));
  return floatToWad(wadToFloat(inflatorWad) * factor);
}

export function blendEmaApproxWad(
  previousWad: bigint,
  cachedWad: bigint,
  elapsedSeconds: number,
  halfLifeHours: number
): bigint {
  const elapsedHours = elapsedSeconds / 3600;
  const weight = Math.exp((-Math.log(2) * elapsedHours) / halfLifeHours);
  return floatToWad(weight * wadToFloat(previousWad) + (1 - weight) * wadToFloat(cachedWad));
}

export function treeSumDepositsWad(deposits: readonly DepositEntry[]): bigint {
  return deposits.reduce((sum, deposit) => sum + deposit.amount * WAD, 0n);
}

export function prefixSumDepositsWad(
  deposits: readonly DepositEntry[],
  fenwickIndex: number
): bigint {
  return deposits.reduce(
    (sum, deposit) => (deposit.bucketIndex <= fenwickIndex ? sum + deposit.amount * WAD : sum),
    0n
  );
}

export function findLupFenwickIndexForDebtWad(
  deposits: readonly DepositEntry[],
  debtWad: bigint
): number {
  const sortedDeposits = [...deposits].sort((left, right) => left.bucketIndex - right.bucketIndex);
  let runningSum = 0n;

  for (const deposit of sortedDeposits) {
    runningSum += deposit.amount * WAD;
    if (runningSum >= debtWad) {
      return deposit.bucketIndex;
    }
  }

  return sortedDeposits.at(-1)?.bucketIndex ?? 7388;
}

export function computeMeaningfulDepositForDepositsWad(
  deposits: readonly DepositEntry[],
  t0DebtInAuction: bigint,
  nonAuctionedT0Debt: bigint,
  inflatorWad: bigint,
  t0Debt2ToCollateralWad: bigint
): bigint {
  const maxPriceWad = fenwickIndexToPriceWad(0);
  const minPriceWad = fenwickIndexToPriceWad(7388);
  let meaningfulDeposit = treeSumDepositsWad(deposits);

  if (nonAuctionedT0Debt !== 0n) {
    const dwatpWad = wdiv(
      wmul(wmul(inflatorWad, t0Debt2ToCollateralWad), AJNA_COLLATERALIZATION_FACTOR_WAD),
      nonAuctionedT0Debt
    );

    if (dwatpWad >= maxPriceWad) {
      meaningfulDeposit = 0n;
    } else if (dwatpWad >= minPriceWad) {
      meaningfulDeposit = prefixSumDepositsWad(deposits, priceToFenwickIndex(dwatpWad));
    }
  }

  const debtInAuctionWad = wmul(t0DebtInAuction, inflatorWad);
  return meaningfulDeposit - (meaningfulDeposit < debtInAuctionWad ? meaningfulDeposit : debtInAuctionWad);
}

export type ApproximatePreWindowBorrowState = {
  currentRateWad: bigint;
  currentDebtWad: bigint;
  debtEmaWad: bigint;
  depositEmaWad: bigint;
  debtColEmaWad: bigint;
  lupt0DebtEmaWad: bigint;
  inflatorWad: bigint;
  totalT0Debt: bigint;
  totalT0DebtInAuction: bigint;
  t0Debt2ToCollateralWad: bigint;
  borrowerT0Debt: bigint;
  borrowerCollateral: bigint;
  secondsUntilNextRateUpdate: number;
};

export type ApproximatePreWindowBorrowForecast = {
  nextRateBps: number;
  nextOutcome: RateMoveOutcome;
  terminalRateBps: number;
  nextDistanceToTargetBps: number;
  terminalDistanceToTargetBps: number;
};

export function approximatePreWindowBorrowForecast(
  state: ApproximatePreWindowBorrowState,
  deposits: readonly DepositEntry[],
  amountWad: bigint,
  collateralAmountWad: bigint,
  targetRateBps: number
): ApproximatePreWindowBorrowForecast {
  const t0BorrowAmount = ceilWdiv(amountWad, state.inflatorWad);
  const t0DebtChange = wmul(t0BorrowAmount, borrowFeeRateWad(state.currentRateWad) + WAD);
  const nonAuctionedT0Debt = state.totalT0Debt - state.totalT0DebtInAuction;
  const nextNonAuctionedT0Debt = nonAuctionedT0Debt + t0DebtChange;
  const borrowerDebtPost = state.borrowerT0Debt + t0DebtChange;
  const borrowerCollateralPost = state.borrowerCollateral + collateralAmountWad;
  const debt2ColPre =
    state.borrowerCollateral === 0n ? 0n : (state.borrowerT0Debt ** 2n) / state.borrowerCollateral;
  const debt2ColPost =
    borrowerCollateralPost === 0n ? 0n : (borrowerDebtPost ** 2n) / borrowerCollateralPost;
  const nextT0Debt2ToCollateral =
    state.t0Debt2ToCollateralWad + debt2ColPost - debt2ColPre;

  const cachedDebtWad = wmul(nextNonAuctionedT0Debt, state.inflatorWad);
  const cachedMeaningfulDepositWad = (() => {
    const computed = computeMeaningfulDepositForDepositsWad(
      deposits,
      state.totalT0DebtInAuction,
      nextNonAuctionedT0Debt,
      state.inflatorWad,
      nextT0Debt2ToCollateral
    );
    return computed > cachedDebtWad ? computed : cachedDebtWad;
  })();
  const cachedDebtColWad = wmul(state.inflatorWad, nextT0Debt2ToCollateral);
  const cachedLupIndex = findLupFenwickIndexForDebtWad(deposits, cachedDebtWad);
  const cachedLupT0DebtWad = wmul(fenwickIndexToPriceWad(cachedLupIndex), nextNonAuctionedT0Debt);

  const nextDebtEmaWad = blendEmaApproxWad(
    state.debtEmaWad,
    cachedDebtWad,
    state.secondsUntilNextRateUpdate,
    12
  );
  const nextDepositEmaWad = blendEmaApproxWad(
    state.depositEmaWad,
    cachedMeaningfulDepositWad,
    state.secondsUntilNextRateUpdate,
    12
  );
  const nextDebtColEmaWad = blendEmaApproxWad(
    state.debtColEmaWad,
    cachedDebtColWad,
    state.secondsUntilNextRateUpdate,
    84
  );
  const nextLupT0DebtEmaWad = blendEmaApproxWad(
    state.lupt0DebtEmaWad,
    cachedLupT0DebtWad,
    state.secondsUntilNextRateUpdate,
    84
  );

  const nextPrediction = forecastAjnaNextEligibleRate({
    currentRateWad: state.currentRateWad,
    currentDebtWad: cachedDebtWad,
    debtEmaWad: nextDebtEmaWad,
    depositEmaWad: nextDepositEmaWad,
    debtColEmaWad: nextDebtColEmaWad,
    lupt0DebtEmaWad: nextLupT0DebtEmaWad,
    lastInterestRateUpdateTimestamp: 0,
    nowTimestamp: TWELVE_HOURS_SECONDS + 1
  });

  const inflatorAfterNextUpdate = pendingInflatorApproxWad(
    state.inflatorWad,
    state.currentRateWad,
    state.secondsUntilNextRateUpdate
  );
  const terminalDebtWad = wmul(nextNonAuctionedT0Debt, inflatorAfterNextUpdate);
  const terminalMeaningfulDepositWad = (() => {
    const computed = computeMeaningfulDepositForDepositsWad(
      deposits,
      state.totalT0DebtInAuction,
      nextNonAuctionedT0Debt,
      inflatorAfterNextUpdate,
      nextT0Debt2ToCollateral
    );
    return computed > terminalDebtWad ? computed : terminalDebtWad;
  })();
  const terminalDebtColWad = wmul(inflatorAfterNextUpdate, nextT0Debt2ToCollateral);
  const terminalLupIndex = findLupFenwickIndexForDebtWad(deposits, terminalDebtWad);
  const terminalLupT0DebtWad = wmul(
    fenwickIndexToPriceWad(terminalLupIndex),
    nextNonAuctionedT0Debt
  );

  const terminalPrediction = forecastAjnaNextEligibleRate({
    currentRateWad: nextPrediction.predictedNextRateWad,
    currentDebtWad: terminalDebtWad,
    debtEmaWad: blendEmaApproxWad(nextDebtEmaWad, terminalDebtWad, FORK_TIME_SKIP_SECONDS, 12),
    depositEmaWad: blendEmaApproxWad(
      nextDepositEmaWad,
      terminalMeaningfulDepositWad,
      FORK_TIME_SKIP_SECONDS,
      12
    ),
    debtColEmaWad: blendEmaApproxWad(
      nextDebtColEmaWad,
      terminalDebtColWad,
      FORK_TIME_SKIP_SECONDS,
      84
    ),
    lupt0DebtEmaWad: blendEmaApproxWad(
      nextLupT0DebtEmaWad,
      terminalLupT0DebtWad,
      FORK_TIME_SKIP_SECONDS,
      84
    ),
    lastInterestRateUpdateTimestamp: 0,
    nowTimestamp: TWELVE_HOURS_SECONDS + 1
  });

  return {
    nextRateBps: nextPrediction.predictedNextRateBps,
    nextOutcome: nextPrediction.predictedOutcome,
    terminalRateBps: terminalPrediction.predictedNextRateBps,
    nextDistanceToTargetBps: Math.abs(nextPrediction.predictedNextRateBps - targetRateBps),
    terminalDistanceToTargetBps: Math.abs(terminalPrediction.predictedNextRateBps - targetRateBps)
  };
}

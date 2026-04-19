export const AJNA_FLOAT_STEP = 1.005;

export const AJNA_COLLATERALIZATION_FACTOR_WAD = 1_040_000_000_000_000_000n;

export const AJNA_FENWICK_ZERO_INDEX = 4156;

export const MAX_AJNA_LIMIT_INDEX = 7_388;

export function priceToFenwickIndex(priceWad: bigint): number | undefined {
  const price = Number(priceWad) / 1e18;
  if (!Number.isFinite(price) || price <= 0) {
    return undefined;
  }

  const rawIndex = Math.log(price) / Math.log(AJNA_FLOAT_STEP);
  const ceilIndex = Math.ceil(rawIndex);
  const fenwickIndex =
    rawIndex < 0 && ceilIndex - rawIndex > 0.5
      ? AJNA_FENWICK_ZERO_INDEX + 1 - ceilIndex
      : AJNA_FENWICK_ZERO_INDEX - ceilIndex;

  if (!Number.isFinite(fenwickIndex)) {
    return undefined;
  }

  return Math.max(0, Math.min(MAX_AJNA_LIMIT_INDEX, fenwickIndex));
}

export function fenwickIndexToPriceWad(index: number): bigint {
  const bucketIndex = AJNA_FENWICK_ZERO_INDEX - index;
  const price = AJNA_FLOAT_STEP ** bucketIndex;
  return BigInt(Math.round(price * 1e18));
}

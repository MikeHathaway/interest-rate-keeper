import { type PublicClient } from "viem";

import { ajnaPoolAbi } from "./abi.js";
import {
  type AjnaRateState,
  hasUninitializedAjnaEmaState,
  wdiv,
  wmul
} from "./rate-state.js";
import { resolveCandidateCapitalMetrics } from "../candidate-metrics.js";
import {
  type HexAddress,
  type KeeperConfig,
  type PlanCandidate
} from "../types.js";

const AJNA_COLLATERALIZATION_FACTOR_WAD = 1_040_000_000_000_000_000n;
const AJNA_FLOAT_STEP = 1.005;
const MAX_AJNA_LIMIT_INDEX = 7_388;
const EXACT_BORROW_LIMIT_INDEX_OFFSETS = [-500, -250, 0, 250, 500] as const;
const EXACT_BORROW_PROTOCOL_SAMPLE_POINTS = [
  500,
  1_000,
  1_500,
  2_000,
  2_500,
  3_000,
  3_500,
  4_000,
  5_000,
  6_000,
  7_000
] as const;
const BORROW_BUCKET_PROBE_OFFSETS = [-250, -100, -50, 0, 50, 100, 250] as const;
const PREWINDOW_LEND_BUCKET_OFFSETS = [0, -5, -10, -20, -50, -100, -250, -500, -1_000] as const;
const MAX_SIMULATION_BORROW_COLLATERAL_SAMPLES = 12;
const DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES = 3;
const PREWINDOW_BORROW_INTERMEDIATE_LOOKAHEAD_UPDATES = 2;
const MULTI_CYCLE_LEND_SEARCH_EXPANSION_FACTOR = 1_000n;
const EXACT_SAME_CYCLE_BORROW_MAX_SAMPLES = 8;
const EXACT_SAME_CYCLE_BORROW_LOW_END_SAMPLES = 5;
const EXACT_PREWINDOW_BORROW_MAX_SAMPLES = 12;
const EXACT_PREWINDOW_BORROW_LOW_END_SAMPLES = 7;
const EXACT_MULTI_CYCLE_BORROW_MAX_SAMPLES = 16;
const EXACT_MULTI_CYCLE_BORROW_LOW_END_SAMPLES = 8;
const DEFAULT_MAX_PROMISING_DUAL_BASINS = 6;
const DEFAULT_EXHAUSTIVE_DUAL_AXIS_SPAN = 64n;

export interface DualSearchPoint {
  quoteAmount: bigint;
  drawDebtAmount: bigint;
}

export interface DualSearchMatch<T> extends DualSearchPoint {
  evaluation: T;
}

export interface ScalarSearchMatch<T> {
  amount: bigint;
  evaluation: T;
}

interface SnapshotWindowState {
  immediatePrediction: {
    secondsUntilNextRateUpdate: number;
  };
  meaningfulDepositThresholdFenwickIndex?: number;
}

function resolveMinimumCollateralActionAmount(config: KeeperConfig): bigint {
  return config.minExecutableCollateralAmount > 0n
    ? config.minExecutableCollateralAmount
    : 1n;
}

export function resolveDrawDebtLimitIndexes(config: KeeperConfig): number[] {
  const configured = [
    ...(config.drawDebtLimitIndexes ?? []),
    ...(config.drawDebtLimitIndex === undefined ? [] : [config.drawDebtLimitIndex])
  ];

  return Array.from(new Set(configured)).sort((left, right) => left - right);
}

export function resolveAddQuoteBucketIndexes(config: KeeperConfig): number[] {
  const configured = [
    ...(config.addQuoteBucketIndexes ?? []),
    ...(config.addQuoteBucketIndex === undefined ? [] : [config.addQuoteBucketIndex])
  ];

  return Array.from(new Set(configured)).sort((left, right) => left - right);
}

export function priceToFenwickIndex(priceWad: bigint): number | undefined {
  const price = Number(priceWad) / 1e18;
  if (!Number.isFinite(price) || price <= 0) {
    return undefined;
  }

  const rawIndex = Math.log(price) / Math.log(AJNA_FLOAT_STEP);
  const ceilIndex = Math.ceil(rawIndex);
  const fenwickIndex =
    rawIndex < 0 && ceilIndex - rawIndex > 0.5 ? 4157 - ceilIndex : 4156 - ceilIndex;

  if (!Number.isFinite(fenwickIndex)) {
    return undefined;
  }

  return Math.max(0, Math.min(MAX_AJNA_LIMIT_INDEX, fenwickIndex));
}

export function deriveMeaningfulDepositThresholdFenwickIndex(
  inflatorWad: bigint,
  totalT0Debt: bigint,
  totalT0DebtInAuction: bigint,
  t0Debt2ToCollateralWad: bigint
): number | undefined {
  if (totalT0Debt <= totalT0DebtInAuction) {
    return undefined;
  }

  const nonAuctionedT0Debt = totalT0Debt - totalT0DebtInAuction;
  const dwatpWad = wdiv(
    wmul(wmul(inflatorWad, t0Debt2ToCollateralWad), AJNA_COLLATERALIZATION_FACTOR_WAD),
    nonAuctionedT0Debt
  );

  return priceToFenwickIndex(dwatpWad);
}

export function resolvePreWindowLendBucketIndexes(
  readState: SnapshotWindowState,
  config: KeeperConfig
): number[] {
  const configured = resolveAddQuoteBucketIndexes(config);
  if (readState.immediatePrediction.secondsUntilNextRateUpdate <= 0) {
    return configured;
  }

  if (configured.length > 0) {
    return configured;
  }

  const thresholdIndex = readState.meaningfulDepositThresholdFenwickIndex;
  if (thresholdIndex === undefined) {
    return configured;
  }

  const resolvedIndexes: number[] = [];
  const seen = new Set<number>();

  for (const offset of PREWINDOW_LEND_BUCKET_OFFSETS) {
    const bucketIndex = thresholdIndex + offset;
    if (bucketIndex < 0 || bucketIndex > MAX_AJNA_LIMIT_INDEX || seen.has(bucketIndex)) {
      continue;
    }

    seen.add(bucketIndex);
    resolvedIndexes.push(bucketIndex);
  }

  return resolvedIndexes;
}

export function resolveDrawDebtCollateralAmounts(config: KeeperConfig): bigint[] {
  const configured = [
    ...(config.drawDebtCollateralAmounts ?? []),
    ...(config.drawDebtCollateralAmount === undefined ? [] : [config.drawDebtCollateralAmount])
  ];

  if (configured.length === 0) {
    return [0n];
  }

  const minimumCollateralAmount = resolveMinimumCollateralActionAmount(config);

  return Array.from(
    new Set(
      configured.filter(
        (collateralAmount) =>
          collateralAmount === 0n || collateralAmount >= minimumCollateralAmount
      )
    )
  ).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function resolveSimulationBorrowLimitIndexes(config: KeeperConfig): number[] {
  const configured = resolveDrawDebtLimitIndexes(config);
  if (configured.length !== 1) {
    return configured;
  }

  const anchor = configured[0]!;

  return Array.from(
    new Set(
      [
        ...EXACT_BORROW_LIMIT_INDEX_OFFSETS.map((offset) => anchor + offset),
        ...EXACT_BORROW_PROTOCOL_SAMPLE_POINTS,
        MAX_AJNA_LIMIT_INDEX
      ].filter((limitIndex) => limitIndex >= 0)
    )
  ).sort((left, right) => left - right);
}

function buildBorrowBucketProbeIndexes(config: KeeperConfig): number[] {
  const seedIndexes = Array.from(
    new Set([
      ...resolveSimulationBorrowLimitIndexes(config),
      ...resolveAddQuoteBucketIndexes(config)
    ])
  );

  return Array.from(
    new Set(
      seedIndexes.flatMap((seedIndex) =>
        BORROW_BUCKET_PROBE_OFFSETS.map((offset) => seedIndex + offset)
      )
    )
  )
    .filter((bucketIndex) => bucketIndex >= 0 && bucketIndex <= MAX_AJNA_LIMIT_INDEX)
    .sort((left, right) => left - right);
}

export async function resolvePoolAwareBorrowLimitIndexes(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  blockNumber: bigint,
  config: KeeperConfig
): Promise<number[]> {
  const baseIndexes = resolveSimulationBorrowLimitIndexes(config);
  const probeIndexes = buildBorrowBucketProbeIndexes(config);
  if (probeIndexes.length === 0) {
    return baseIndexes;
  }

  const bucketResults = await Promise.all(
    probeIndexes.map(async (bucketIndex) => {
      try {
        const [, , bankruptcyTime, bucketDeposit] = await publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "bucketInfo",
          args: [BigInt(bucketIndex)],
          blockNumber
        });

        return {
          bucketIndex,
          bankruptcyTime,
          bucketDeposit
        };
      } catch {
        return undefined;
      }
    })
  );

  const fundedIndexes = bucketResults
    .filter(
      (
        bucket
      ): bucket is {
        bucketIndex: number;
        bankruptcyTime: bigint;
        bucketDeposit: bigint;
      } =>
        bucket !== undefined &&
        bucket.bankruptcyTime === 0n &&
        bucket.bucketDeposit > 0n
    )
    .sort((left, right) => {
      if (left.bucketDeposit !== right.bucketDeposit) {
        return left.bucketDeposit > right.bucketDeposit ? -1 : 1;
      }
      return left.bucketIndex - right.bucketIndex;
    })
    .map((bucket) => bucket.bucketIndex);

  return Array.from(new Set([...fundedIndexes, ...baseIndexes]));
}

export function resolveSimulationBorrowCollateralAmounts(
  config: KeeperConfig,
  maxAvailableCollateral: bigint,
  options: {
    borrowerHasExistingPosition?: boolean;
  } = {}
): bigint[] {
  const configured = resolveDrawDebtCollateralAmounts(config).filter(
    (collateralAmount) => collateralAmount <= maxAvailableCollateral
  );
  if (configured.length === 0) {
    return [];
  }

  if (configured.length !== 1) {
    return Array.from(
      new Set([
        ...(options.borrowerHasExistingPosition ? [0n] : []),
        ...configured
      ])
    ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  const anchor = configured[0]!;
  if (anchor === 0n) {
    return [0n];
  }

  const scaledCandidates = new Set<bigint>([
    anchor / 10n,
    anchor / 5n,
    anchor / 2n,
    anchor,
    anchor * 2n,
    anchor * 5n,
    anchor * 10n
  ]);
  let scaledUp = anchor * 10n;
  while (
    scaledCandidates.size < MAX_SIMULATION_BORROW_COLLATERAL_SAMPLES &&
    scaledUp < maxAvailableCollateral
  ) {
    scaledUp *= 10n;
    scaledCandidates.add(scaledUp);
  }

  return Array.from(
    new Set([
      ...(options.borrowerHasExistingPosition ? [0n] : []),
      ...Array.from(scaledCandidates)
    ])
  )
    .filter(
      (collateralAmount) =>
        collateralAmount >= 0n && collateralAmount <= maxAvailableCollateral
    )
    .sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
}

function buildDualBorrowSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint,
  anchorAmount: bigint
): bigint[] {
  const clampedAnchor =
    anchorAmount < minimumAmount
      ? minimumAmount
      : anchorAmount > maximumAmount
        ? maximumAmount
        : anchorAmount;

  const values = new Set<bigint>([minimumAmount, clampedAnchor, maximumAmount]);
  let down = clampedAnchor;
  for (let step = 0; step < 3; step += 1) {
    if (down <= minimumAmount) {
      break;
    }

    down = down / 2n;
    if (down >= minimumAmount) {
      values.add(down);
    }
  }

  let up = clampedAnchor;
  for (let step = 0; step < 4; step += 1) {
    if (up >= maximumAmount) {
      break;
    }

    up = up * 2n;
    if (up > maximumAmount) {
      up = maximumAmount;
    }
    values.add(up);
  }

  return Array.from(values).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function buildBroadBorrowSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint
): bigint[] {
  const values = new Set<bigint>([minimumAmount, maximumAmount]);

  for (const denominator of [1024n, 256n, 64n, 16n, 4n, 2n]) {
    const fraction = maximumAmount / denominator;
    if (fraction >= minimumAmount && fraction <= maximumAmount) {
      values.add(fraction);
    }
  }

  let scaled = minimumAmount;
  for (let step = 0; step < 6; step += 1) {
    if (scaled >= maximumAmount) {
      break;
    }

    scaled = scaled * 10n;
    if (scaled > maximumAmount) {
      scaled = maximumAmount;
    }
    values.add(scaled);
  }

  return Array.from(values).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function buildAnchoredSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint,
  anchorAmounts: Array<bigint | undefined>,
  options: {
    includeBroadSearch?: boolean;
  } = {}
): bigint[] {
  const values = new Set<bigint>();

  for (const anchorAmount of anchorAmounts) {
    if (anchorAmount === undefined) {
      continue;
    }

    for (const amount of buildDualBorrowSearchAmounts(
      minimumAmount,
      maximumAmount,
      anchorAmount
    )) {
      values.add(amount);
    }
  }

  if (values.size === 0 || options.includeBroadSearch !== false) {
    for (const amount of buildBroadBorrowSearchAmounts(minimumAmount, maximumAmount)) {
      values.add(amount);
    }
  }

  return Array.from(values).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function buildOneTwoFiveSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint
): bigint[] {
  if (minimumAmount > maximumAmount) {
    return [];
  }

  if (maximumAmount - minimumAmount <= DEFAULT_EXHAUSTIVE_DUAL_AXIS_SPAN) {
    const values: bigint[] = [];
    for (let value = minimumAmount; value <= maximumAmount; value += 1n) {
      values.push(value);
    }
    return values;
  }

  const values = new Set<bigint>([minimumAmount, maximumAmount]);
  for (let magnitude = 1n; magnitude <= maximumAmount; magnitude *= 10n) {
    for (const multiplier of [1n, 2n, 5n]) {
      const amount = magnitude * multiplier;
      if (amount >= minimumAmount && amount <= maximumAmount) {
        values.add(amount);
      }
    }

    if (magnitude > maximumAmount / 10n) {
      break;
    }
  }

  return Array.from(values).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function buildMultiCycleLendSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint,
  anchorAmounts: Array<bigint | undefined>
): bigint[] {
  const values = new Set<bigint>(buildOneTwoFiveSearchAmounts(minimumAmount, maximumAmount));
  const topEndDeltaCap =
    maximumAmount / 100n >= minimumAmount ? maximumAmount / 100n : minimumAmount;
  for (const deltaAmount of buildOneTwoFiveSearchAmounts(minimumAmount, topEndDeltaCap)) {
    const mirroredAmount = maximumAmount - (deltaAmount - minimumAmount);
    if (mirroredAmount >= minimumAmount && mirroredAmount <= maximumAmount) {
      values.add(mirroredAmount);
    }
  }

  for (const anchorAmount of anchorAmounts) {
    if (anchorAmount === undefined) {
      continue;
    }

    const clampedAnchor =
      anchorAmount < minimumAmount
        ? minimumAmount
        : anchorAmount > maximumAmount
          ? maximumAmount
          : anchorAmount;
    const lowerBound =
      clampedAnchor <= 1n
        ? minimumAmount
        : clampedAnchor / 100n < minimumAmount
          ? minimumAmount
          : clampedAnchor / 100n;
    let upperBound = clampedAnchor * MULTI_CYCLE_LEND_SEARCH_EXPANSION_FACTOR;
    if (upperBound < clampedAnchor) {
      upperBound = maximumAmount;
    }
    if (upperBound > maximumAmount) {
      upperBound = maximumAmount;
    }

    for (const amount of buildOneTwoFiveSearchAmounts(lowerBound, upperBound)) {
      values.add(amount);
    }

    for (const amount of buildDualBorrowSearchAmounts(
      minimumAmount,
      maximumAmount,
      clampedAnchor
    )) {
      values.add(amount);
    }
  }

  return Array.from(values).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function buildTokenScaleAnchorAmounts(
  tokenScale: bigint,
  minimumAmount: bigint,
  maximumAmount: bigint
): bigint[] {
  if (tokenScale <= 0n || minimumAmount > maximumAmount) {
    return [];
  }

  const values: bigint[] = [];
  let amount = tokenScale;
  for (let step = 0; step < 6; step += 1) {
    if (amount >= minimumAmount && amount <= maximumAmount) {
      values.push(amount);
    }

    if (amount > maximumAmount / 10n) {
      break;
    }

    amount *= 10n;
  }

  return values;
}

export function buildExposureFractionAnchorAmounts(
  maximumAmount: bigint,
  minimumAmount: bigint
): bigint[] {
  if (maximumAmount <= 0n || minimumAmount > maximumAmount) {
    return [];
  }

  const values = new Set<bigint>();
  for (const denominator of [1_000_000n, 100_000n, 10_000n, 1_000n, 100n, 50n, 20n, 10n, 2n]) {
    const amount = maximumAmount / denominator;
    if (amount >= minimumAmount && amount <= maximumAmount) {
      values.add(amount);
    }
  }

  return Array.from(values).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function buildSameCycleBorrowSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint,
  quoteTokenScale: bigint,
  anchorAmounts: Array<bigint | undefined>
): bigint[] {
  const rawAmounts = Array.from(
    new Set([
      ...buildAnchoredSearchAmounts(minimumAmount, maximumAmount, anchorAmounts),
      ...buildTokenScaleAnchorAmounts(quoteTokenScale, minimumAmount, maximumAmount),
      ...buildExposureFractionAnchorAmounts(maximumAmount, minimumAmount)
    ])
  ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return compressCapitalAwareSearchAmounts(
    rawAmounts,
    anchorAmounts,
    EXACT_SAME_CYCLE_BORROW_MAX_SAMPLES,
    EXACT_SAME_CYCLE_BORROW_LOW_END_SAMPLES
  );
}

export function buildPreWindowBorrowSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint,
  quoteTokenScale: bigint,
  anchorAmounts: Array<bigint | undefined>
): bigint[] {
  const rawAmounts = Array.from(
    new Set([
      ...buildAnchoredSearchAmounts(minimumAmount, maximumAmount, anchorAmounts, {
        includeBroadSearch: true
      }),
      ...buildTokenScaleAnchorAmounts(quoteTokenScale, minimumAmount, maximumAmount),
      ...buildExposureFractionAnchorAmounts(maximumAmount, minimumAmount)
    ])
  ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return compressCapitalAwareSearchAmounts(
    rawAmounts,
    anchorAmounts,
    EXACT_PREWINDOW_BORROW_MAX_SAMPLES,
    EXACT_PREWINDOW_BORROW_LOW_END_SAMPLES
  );
}

export function buildMultiCycleBorrowSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint,
  quoteTokenScale: bigint,
  anchorAmounts: Array<bigint | undefined>
): bigint[] {
  const rawAmounts = Array.from(
    new Set([
      ...buildAnchoredSearchAmounts(minimumAmount, maximumAmount, anchorAmounts, {
        includeBroadSearch: true
      }),
      ...buildTokenScaleAnchorAmounts(quoteTokenScale, minimumAmount, maximumAmount),
      ...buildExposureFractionAnchorAmounts(maximumAmount, minimumAmount)
    ])
  ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return compressCapitalAwareSearchAmounts(
    rawAmounts,
    anchorAmounts,
    EXACT_MULTI_CYCLE_BORROW_MAX_SAMPLES,
    EXACT_MULTI_CYCLE_BORROW_LOW_END_SAMPLES
  );
}

function buildAxisSearchAmounts(
  minimumAmount: bigint,
  maximumAmount: bigint,
  anchorAmounts: Array<bigint | undefined>,
  exhaustiveSpan: bigint = DEFAULT_EXHAUSTIVE_DUAL_AXIS_SPAN
): bigint[] {
  if (minimumAmount > maximumAmount) {
    return [];
  }

  if (maximumAmount - minimumAmount <= exhaustiveSpan) {
    const values: bigint[] = [];
    for (let value = minimumAmount; value <= maximumAmount; value += 1n) {
      values.push(value);
    }
    return values;
  }

  return buildAnchoredSearchAmounts(minimumAmount, maximumAmount, anchorAmounts, {
    includeBroadSearch: true
  });
}

function compressSearchAmounts(
  amounts: bigint[],
  anchorAmounts: Array<bigint | undefined>,
  maxSamples?: number
): bigint[] {
  if (!maxSamples || amounts.length <= maxSamples) {
    return amounts;
  }

  const retained = new Set<bigint>([amounts[0]!, amounts[amounts.length - 1]!]);
  for (const anchorAmount of anchorAmounts) {
    if (anchorAmount !== undefined && amounts.includes(anchorAmount)) {
      retained.add(anchorAmount);
    }
  }

  if (retained.size >= maxSamples) {
    return Array.from(retained).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
  }

  const evenlySpacedIndexes = new Set<number>([0, amounts.length - 1]);
  for (let sampleIndex = 1; sampleIndex < maxSamples - 1; sampleIndex += 1) {
    evenlySpacedIndexes.add(
      Math.round((sampleIndex * (amounts.length - 1)) / (maxSamples - 1))
    );
  }

  for (const amountIndex of Array.from(evenlySpacedIndexes).sort((left, right) => left - right)) {
    retained.add(amounts[amountIndex]!);
    if (retained.size >= maxSamples) {
      break;
    }
  }

  return Array.from(retained).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function compressCapitalAwareSearchAmounts(
  amounts: bigint[],
  anchorAmounts: Array<bigint | undefined>,
  maxSamples: number,
  lowEndSamples: number
): bigint[] {
  if (amounts.length <= maxSamples) {
    return amounts;
  }

  const required = new Set<bigint>([amounts[0]!, amounts[amounts.length - 1]!]);
  for (const anchorAmount of anchorAmounts) {
    if (anchorAmount !== undefined && amounts.includes(anchorAmount)) {
      required.add(anchorAmount);
    }
  }

  const retained = new Set<bigint>(required);
  for (const amount of amounts.slice(0, Math.min(lowEndSamples, amounts.length))) {
    if (required.has(amount)) {
      continue;
    }

    retained.add(amount);
    if (retained.size >= maxSamples) {
      break;
    }
  }

  if (retained.size < maxSamples) {
    const remainingIndexes = amounts
      .map((_, index) => index)
      .filter((index) => !retained.has(amounts[index]!));
    const remainingSamples = maxSamples - retained.size;

    if (remainingSamples > 0 && remainingIndexes.length > 0) {
      const evenlySpacedIndexes = new Set<number>();
      if (remainingSamples === 1) {
        evenlySpacedIndexes.add(remainingIndexes[remainingIndexes.length - 1]!);
      } else {
        for (let sampleIndex = 0; sampleIndex < remainingSamples; sampleIndex += 1) {
          evenlySpacedIndexes.add(
            remainingIndexes[
              Math.round((sampleIndex * (remainingIndexes.length - 1)) / (remainingSamples - 1))
            ]!
          );
        }
      }

      for (const amountIndex of Array.from(evenlySpacedIndexes).sort((left, right) => left - right)) {
        retained.add(amounts[amountIndex]!);
        if (retained.size >= maxSamples) {
          break;
        }
      }
    }
  }

  return Array.from(retained)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, maxSamples);
}

export async function searchCoarseToFineDualSpace<T>(options: {
  minimumQuoteAmount: bigint;
  maximumQuoteAmount: bigint;
  minimumBorrowAmount: bigint;
  maximumBorrowAmount: bigint;
  quoteAnchorAmounts: Array<bigint | undefined>;
  borrowAnchorAmounts: Array<bigint | undefined>;
  evaluate: (point: DualSearchPoint) => Promise<T | undefined>;
  isImprovement: (evaluation: T) => boolean;
  compareMatches: (left: DualSearchMatch<T>, right: DualSearchMatch<T>) => number;
  maxPromisingBasins?: number;
  exhaustiveAxisSpan?: bigint;
  maxQuoteSamples?: number;
  maxBorrowSamples?: number;
}): Promise<DualSearchMatch<T> | undefined> {
  const exhaustiveAxisSpan =
    options.exhaustiveAxisSpan ?? DEFAULT_EXHAUSTIVE_DUAL_AXIS_SPAN;
  const quoteSearchAmounts = compressSearchAmounts(
    buildAxisSearchAmounts(
      options.minimumQuoteAmount,
      options.maximumQuoteAmount,
      options.quoteAnchorAmounts,
      exhaustiveAxisSpan
    ),
    options.quoteAnchorAmounts,
    options.maxQuoteSamples
  );
  const borrowSearchAmounts = compressSearchAmounts(
    buildAxisSearchAmounts(
      options.minimumBorrowAmount,
      options.maximumBorrowAmount,
      options.borrowAnchorAmounts,
      exhaustiveAxisSpan
    ),
    options.borrowAnchorAmounts,
    options.maxBorrowSamples
  );
  if (quoteSearchAmounts.length === 0 || borrowSearchAmounts.length === 0) {
    return undefined;
  }

  const evaluationCache = new Map<string, T | null>();

  async function evaluateMatch(point: DualSearchPoint): Promise<DualSearchMatch<T> | undefined> {
    const cacheKey = `${point.quoteAmount.toString()}:${point.drawDebtAmount.toString()}`;
    if (!evaluationCache.has(cacheKey)) {
      evaluationCache.set(cacheKey, (await options.evaluate(point)) ?? null);
    }

    const evaluation = evaluationCache.get(cacheKey);
    if (evaluation === null || evaluation === undefined || !options.isImprovement(evaluation)) {
      return undefined;
    }

    return {
      ...point,
      evaluation
    };
  }

  async function refineQuoteForBorrow(
    drawDebtAmount: bigint,
    preferredQuoteAnchors: Array<bigint | undefined> = []
  ): Promise<DualSearchMatch<T> | undefined> {
    const candidateQuoteAmounts = compressSearchAmounts(
      buildAxisSearchAmounts(
        options.minimumQuoteAmount,
        options.maximumQuoteAmount,
        [...preferredQuoteAnchors, ...options.quoteAnchorAmounts],
        exhaustiveAxisSpan
      ),
      [...preferredQuoteAnchors, ...options.quoteAnchorAmounts],
      options.maxQuoteSamples
    );
    if (candidateQuoteAmounts.length === 0) {
      return undefined;
    }

    let lowerQuoteAmount = options.minimumQuoteAmount - 1n;
    let upperMatch: DualSearchMatch<T> | undefined;
    let previousSeedAmount = options.minimumQuoteAmount - 1n;

    for (const quoteAmount of candidateQuoteAmounts) {
      const match = await evaluateMatch({
        quoteAmount,
        drawDebtAmount
      });
      if (match) {
        lowerQuoteAmount = previousSeedAmount;
        upperMatch = match;
        break;
      }

      previousSeedAmount = quoteAmount;
    }

    if (!upperMatch) {
      return undefined;
    }

    while (upperMatch.quoteAmount - lowerQuoteAmount > 1n) {
      const middleQuoteAmount =
        lowerQuoteAmount + (upperMatch.quoteAmount - lowerQuoteAmount) / 2n;
      const middleMatch = await evaluateMatch({
        quoteAmount: middleQuoteAmount,
        drawDebtAmount
      });
      if (middleMatch) {
        upperMatch = middleMatch;
      } else {
        lowerQuoteAmount = middleQuoteAmount;
      }
    }

    return upperMatch;
  }

  const promisingBasins: DualSearchMatch<T>[] = [];
  for (const drawDebtAmount of borrowSearchAmounts) {
    for (const quoteAmount of quoteSearchAmounts) {
      const match = await evaluateMatch({
        quoteAmount,
        drawDebtAmount
      });
      if (match) {
        promisingBasins.push(match);
      }
    }
  }

  if (promisingBasins.length === 0) {
    return undefined;
  }

  promisingBasins.sort(options.compareMatches);
  const maxPromisingBasins =
    options.maxPromisingBasins ?? DEFAULT_MAX_PROMISING_DUAL_BASINS;
  let bestMatch: DualSearchMatch<T> | undefined;

  for (const basin of promisingBasins.slice(0, maxPromisingBasins)) {
    let basinBest =
      (await refineQuoteForBorrow(basin.drawDebtAmount, [basin.quoteAmount])) ?? basin;

    const basinBorrowIndex = borrowSearchAmounts.findIndex(
      (amount) => amount === basin.drawDebtAmount
    );
    const previousBorrowAmount =
      basinBorrowIndex > 0 ? borrowSearchAmounts[basinBorrowIndex - 1] : undefined;
    const nextBorrowAmount =
      basinBorrowIndex >= 0 && basinBorrowIndex < borrowSearchAmounts.length - 1
        ? borrowSearchAmounts[basinBorrowIndex + 1]
        : undefined;
    const lowerBorrowBoundary =
      previousBorrowAmount === undefined
        ? options.minimumBorrowAmount
        : previousBorrowAmount + 1n;
    const upperBorrowBoundary =
      nextBorrowAmount === undefined ? options.maximumBorrowAmount : nextBorrowAmount - 1n;

    if (lowerBorrowBoundary <= upperBorrowBoundary) {
      const refinementBorrowAmounts = compressSearchAmounts(
        buildAxisSearchAmounts(
          lowerBorrowBoundary,
          upperBorrowBoundary,
          [basin.drawDebtAmount],
          exhaustiveAxisSpan
        ),
        [basin.drawDebtAmount],
        options.maxBorrowSamples
      ).filter((amount) => amount !== basin.drawDebtAmount);

      for (const drawDebtAmount of refinementBorrowAmounts) {
        const refinedMatch = await refineQuoteForBorrow(drawDebtAmount, [
          basinBest.quoteAmount,
          basin.quoteAmount
        ]);
        if (
          refinedMatch &&
          options.compareMatches(refinedMatch, basinBest) < 0
        ) {
          basinBest = refinedMatch;
        }
      }
    }

    if (!bestMatch || options.compareMatches(basinBest, bestMatch) < 0) {
      bestMatch = basinBest;
    }
  }

  return bestMatch;
}

function collateralAmountForCandidate(candidate: PlanCandidate): bigint {
  return candidate.minimumExecutionSteps.reduce((total, step) => {
    if (step.type === "DRAW_DEBT") {
      return total + (step.collateralAmount ?? 0n);
    }

    if (step.type === "ADD_COLLATERAL") {
      return total + step.amount;
    }

    return total;
  }, 0n);
}

export function compareCandidatePreference(left: PlanCandidate, right: PlanCandidate): number {
  const leftCapital = resolveCandidateCapitalMetrics(left);
  const rightCapital = resolveCandidateCapitalMetrics(right);
  const leftInBand = left.resultingDistanceToTargetBps === 0 ? 0 : 1;
  const rightInBand = right.resultingDistanceToTargetBps === 0 ? 0 : 1;
  if (leftInBand !== rightInBand) {
    return leftInBand - rightInBand;
  }

  if (left.resultingDistanceToTargetBps !== right.resultingDistanceToTargetBps) {
    return left.resultingDistanceToTargetBps - right.resultingDistanceToTargetBps;
  }

  if (leftCapital.operatorCapitalRequired !== rightCapital.operatorCapitalRequired) {
    return leftCapital.operatorCapitalRequired < rightCapital.operatorCapitalRequired ? -1 : 1;
  }

  if (leftCapital.operatorCapitalAtRisk !== rightCapital.operatorCapitalAtRisk) {
    return leftCapital.operatorCapitalAtRisk < rightCapital.operatorCapitalAtRisk ? -1 : 1;
  }

  if (leftCapital.additionalCollateralRequired !== rightCapital.additionalCollateralRequired) {
    return leftCapital.additionalCollateralRequired <
      rightCapital.additionalCollateralRequired
      ? -1
      : 1;
  }

  if (leftCapital.quoteTokenDelta !== rightCapital.quoteTokenDelta) {
    return leftCapital.quoteTokenDelta < rightCapital.quoteTokenDelta ? -1 : 1;
  }

  const leftCollateral = collateralAmountForCandidate(left);
  const rightCollateral = collateralAmountForCandidate(right);
  if (leftCollateral !== rightCollateral) {
    return leftCollateral < rightCollateral ? -1 : 1;
  }

  return left.id.localeCompare(right.id);
}

export function resolveBorrowSimulationLookaheadAttempts(config: KeeperConfig): number[] {
  if (config.borrowSimulationLookaheadUpdates !== undefined) {
    return [config.borrowSimulationLookaheadUpdates];
  }

  return [1, DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES];
}

export function resolveTimedBorrowSimulationLookaheadAttempts(
  config: KeeperConfig,
  secondsUntilNextRateUpdate?: number,
  rateState?: AjnaRateState
): number[] {
  if (config.borrowSimulationLookaheadUpdates !== undefined) {
    return [config.borrowSimulationLookaheadUpdates];
  }

  if (secondsUntilNextRateUpdate !== undefined && secondsUntilNextRateUpdate > 0) {
    return [
      1,
      PREWINDOW_BORROW_INTERMEDIATE_LOOKAHEAD_UPDATES,
      DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES
    ];
  }

  if (rateState && !hasUninitializedAjnaEmaState(rateState)) {
    return [DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES];
  }

  return [1, DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES];
}

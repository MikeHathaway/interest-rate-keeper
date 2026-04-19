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

export function buildHighEndExposureFractionAnchorAmounts(
  maximumAmount: bigint,
  minimumAmount: bigint
): bigint[] {
  if (maximumAmount <= 0n || minimumAmount > maximumAmount) {
    return [];
  }

  const values = new Set<bigint>();
  for (const [numerator, denominator] of [
    [2n, 3n],
    [3n, 4n],
    [9n, 10n],
    [1n, 1n]
  ] as const) {
    const amount = (maximumAmount * numerator) / denominator;
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

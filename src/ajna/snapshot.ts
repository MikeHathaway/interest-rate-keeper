import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

import {
  defineChain,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  type Hex,
  type PublicClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ajnaPoolAbi, erc20Abi } from "./abi.js";
import {
  resolveCandidateCapitalMetrics,
  withPlanCandidateCapitalMetrics
} from "../candidate-metrics.js";
import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import { type SnapshotSource } from "../snapshot.js";
import {
  type AddQuoteStep,
  type DrawDebtStep,
  type ExecutionStep,
  type HexAddress,
  type KeeperConfig,
  type PlanCandidate,
  type PoolSnapshot,
  type RateMoveOutcome
} from "../types.js";

const WAD = 1_000_000_000_000_000_000n;
const HALF_WAD = WAD / 2n;
const TWELVE_HOURS_SECONDS = 12 * 60 * 60;
const RESET_RATE_WAD = WAD / 10n;
const RESET_THRESHOLD_WAD = 50_000_000_000_000_000n;
const INCREASE_COEFFICIENT_WAD = 1_100_000_000_000_000_000n;
const DECREASE_COEFFICIENT_WAD = 900_000_000_000_000_000n;
const MAX_RATE_WAD = 4n * WAD;
const MIN_RATE_WAD = 1_000_000_000_000_000n;
const DEFAULT_ADD_QUOTE_EXPIRY_SECONDS = 60 * 60;
const EXACT_DUAL_MAX_BUCKETS = 3;
const EXACT_DUAL_MAX_QUOTE_SAMPLES = 6;
const EXACT_DUAL_MAX_BORROW_SAMPLES = 6;
const EXACT_DUAL_MAX_PROMISING_BASINS = 3;
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
const AJNA_COLLATERALIZATION_FACTOR_WAD = 1_040_000_000_000_000_000n;
const AJNA_FLOAT_STEP = 1.005;
const MAX_AJNA_LIMIT_INDEX = 7_388;
const MAX_SIMULATION_BORROW_COLLATERAL_SAMPLES = 12;
const MAX_SIMULATION_ACCOUNT_STATE_CACHE_ENTRIES = 256;
const MAX_EXACT_SIMULATION_PATH_CACHE_ENTRIES = 20_000;
const MAX_SIMULATION_CANDIDATE_CACHE_ENTRIES = 2_048;
const DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES = 3;
const MULTI_CYCLE_LEND_SEARCH_EXPANSION_FACTOR = 1_000n;
const EXACT_MULTI_CYCLE_LEND_MAX_QUOTE_SAMPLES = 12;
const EXACT_MULTI_CYCLE_LEND_LOW_END_QUOTE_SAMPLES = 8;

interface SimulationAccountState {
  simulationSenderAddress: HexAddress;
  borrowerAddress: HexAddress;
  quoteTokenBalance?: bigint;
  quoteTokenAllowance?: bigint;
  collateralBalance?: bigint;
  collateralAllowance?: bigint;
}

export interface AjnaSynthesisPolicy {
  simulationLend: boolean;
  simulationBorrow: boolean;
  heuristicLend: boolean;
  heuristicBorrow: boolean;
}

interface LendSimulationPathResult {
  firstRateWadAfterNextUpdate: bigint;
  firstRateBpsAfterNextUpdate: number;
  firstOutcome: RateMoveOutcome;
  terminalRateBps: number;
  terminalDistanceToTargetBps: number;
}

interface BorrowSimulationPathResult extends LendSimulationPathResult {
}

type DualSimulationPathResult = BorrowSimulationPathResult;

interface CachedSimulationCandidates {
  candidates: PlanCandidate[];
  planningRateBps?: number;
  planningLookaheadUpdates?: number;
}

const simulationAccountStateCache = new Map<string, SimulationAccountState>();
const lendSimulationPathCache = new Map<string, LendSimulationPathResult | null>();
const borrowSimulationPathCache = new Map<string, BorrowSimulationPathResult | null>();
const simulationCandidateCache = new Map<string, CachedSimulationCandidates>();

function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, value);

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function buildSimulationCacheKey(parts: Array<string | number | bigint | undefined>): string {
  return parts
    .map((part) => {
      if (part === undefined) {
        return "-";
      }

      return typeof part === "bigint" ? part.toString() : String(part);
    })
    .join(":");
}

function buildSimulationCandidateCacheKey(
  snapshotFingerprint: string,
  config: KeeperConfig,
  accountState: SimulationAccountState
): string {
  return buildSimulationCacheKey([
    "candidate-set",
    snapshotFingerprint,
    config.targetRateBps,
    config.toleranceBps,
    config.toleranceMode,
    config.enableSimulationBackedLendSynthesis ? "sim-lend" : "no-sim-lend",
    config.enableSimulationBackedBorrowSynthesis ? "sim-borrow" : "no-sim-borrow",
    config.maxQuoteTokenExposure,
    config.maxBorrowExposure,
    config.minExecutableActionQuoteToken,
    config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS,
    resolveAddQuoteBucketIndexes(config).join(","),
    resolveDrawDebtLimitIndexes(config).join(","),
    resolveDrawDebtCollateralAmounts(config)
      .map((value) => value.toString())
      .join(","),
    config.borrowSimulationLookaheadUpdates ?? 1,
    accountState.simulationSenderAddress,
    accountState.borrowerAddress,
    accountState.quoteTokenBalance,
    accountState.quoteTokenAllowance,
    accountState.collateralBalance,
    accountState.collateralAllowance
  ]);
}

function hasExplicitSynthesisFlags(config: KeeperConfig): boolean {
  return (
    config.enableSimulationBackedLendSynthesis !== undefined ||
    config.enableSimulationBackedBorrowSynthesis !== undefined ||
    config.enableHeuristicLendSynthesis !== undefined ||
    config.enableHeuristicBorrowSynthesis !== undefined
  );
}

function hasResolvableSimulationSenderAddress(
  config: KeeperConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (config.simulationSenderAddress) {
    return true;
  }

  const candidate = env.AJNA_KEEPER_PRIVATE_KEY ?? env.PRIVATE_KEY;
  return candidate !== undefined && /^0x[a-fA-F0-9]{64}$/.test(candidate);
}

export function resolveAjnaSynthesisPolicy(
  config: KeeperConfig,
  env: NodeJS.ProcessEnv = process.env
): AjnaSynthesisPolicy {
  if (hasExplicitSynthesisFlags(config)) {
    return {
      simulationLend: config.enableSimulationBackedLendSynthesis === true,
      simulationBorrow: config.enableSimulationBackedBorrowSynthesis === true,
      heuristicLend: config.enableHeuristicLendSynthesis === true,
      heuristicBorrow: config.enableHeuristicBorrowSynthesis === true
    };
  }

  const canSimulate = hasResolvableSimulationSenderAddress(config, env);

  return {
    simulationLend: canSimulate,
    simulationBorrow: canSimulate,
    heuristicLend: true,
    heuristicBorrow: true
  };
}

function wmul(left: bigint, right: bigint): bigint {
  if (left === 0n || right === 0n) {
    return 0n;
  }

  return (left * right + HALF_WAD) / WAD;
}

function wdiv(left: bigint, right: bigint): bigint {
  if (right === 0n) {
    return 0n;
  }

  return (left * WAD + right / 2n) / right;
}

function clampRate(rateWad: bigint): bigint {
  if (rateWad < MIN_RATE_WAD) {
    return MIN_RATE_WAD;
  }

  if (rateWad > MAX_RATE_WAD) {
    return MAX_RATE_WAD;
  }

  return rateWad;
}

function toRateBps(rateWad: bigint): number {
  return Number((rateWad * 10_000n + HALF_WAD) / WAD);
}

function squareWithProtocolScaling(value: bigint): bigint {
  const scaled = value / 1_000_000_000n;
  return scaled * scaled;
}

function secondsUntilRateUpdateEligibility(
  nowSeconds: number,
  lastUpdateSeconds: number
): number {
  const elapsed = nowSeconds - lastUpdateSeconds;
  if (elapsed > TWELVE_HOURS_SECONDS) {
    return 0;
  }

  return TWELVE_HOURS_SECONDS + 1 - elapsed;
}

function smallestBigInt(...values: bigint[]): bigint {
  if (values.length === 0) {
    throw new Error("smallestBigInt requires at least one value");
  }

  return values.reduce((smallest, value) => (value < smallest ? value : smallest));
}

export interface AjnaRateState {
  currentRateWad: bigint;
  currentDebtWad: bigint;
  debtEmaWad: bigint;
  depositEmaWad: bigint;
  debtColEmaWad: bigint;
  lupt0DebtEmaWad: bigint;
  lastInterestRateUpdateTimestamp: number;
  nowTimestamp: number;
}

export interface AjnaRatePrediction {
  predictedOutcome: RateMoveOutcome;
  predictedNextRateWad: bigint;
  predictedNextRateBps: number;
  secondsUntilNextRateUpdate: number;
}

interface AjnaPoolStateRead {
  blockNumber: bigint;
  blockTimestamp: number;
  rateState: AjnaRateState;
  prediction: AjnaRatePrediction;
  immediatePrediction: AjnaRatePrediction;
  inflatorWad: bigint;
  totalT0Debt: bigint;
  totalT0DebtInAuction: bigint;
  t0Debt2ToCollateralWad: bigint;
  meaningfulDepositThresholdFenwickIndex?: number;
  quoteTokenAddress: HexAddress;
  collateralAddress: HexAddress;
  quoteTokenScale: bigint;
  poolType: number;
  borrowerState?: {
    borrowerAddress: HexAddress;
    t0Debt: bigint;
    collateral: bigint;
    npTpRatio: bigint;
  };
  loansState?: {
    maxBorrower: HexAddress;
    maxT0DebtToCollateral: bigint;
    noOfLoans: bigint;
  };
}

interface BorrowSimulationSynthesisResult {
  candidate?: PlanCandidate;
  baselinePlanningRateBps?: number;
  planningLookaheadUpdates?: number;
}

interface LendSimulationSynthesisResult {
  candidate?: PlanCandidate;
  baselinePlanningRateBps?: number;
  planningLookaheadUpdates?: number;
}

export function forecastAjnaNextEligibleRate(state: AjnaRateState): AjnaRatePrediction {
  const secondsUntilNextRateUpdate = secondsUntilRateUpdateEligibility(
    state.nowTimestamp,
    state.lastInterestRateUpdateTimestamp
  );

  if (
    state.currentRateWad > RESET_RATE_WAD &&
    state.debtEmaWad < wmul(state.depositEmaWad, RESET_THRESHOLD_WAD)
  ) {
    return {
      predictedOutcome: "RESET_TO_TEN",
      predictedNextRateWad: RESET_RATE_WAD,
      predictedNextRateBps: toRateBps(RESET_RATE_WAD),
      secondsUntilNextRateUpdate
    };
  }

  let mau = 0n;
  let mau102 = 0n;

  if (state.currentDebtWad !== 0n) {
    mau = wdiv(state.debtEmaWad, state.depositEmaWad);
    mau102 = (mau * 102n) / 100n;
  }

  const tu =
    state.lupt0DebtEmaWad !== 0n ? wdiv(state.debtColEmaWad, state.lupt0DebtEmaWad) : WAD;

  let nextRateWad = state.currentRateWad;

  if (4n * (tu - mau102) < squareWithProtocolScaling(tu + mau102 - WAD) - WAD) {
    nextRateWad = clampRate(wmul(state.currentRateWad, INCREASE_COEFFICIENT_WAD));
  } else if (4n * (tu - mau) > WAD - squareWithProtocolScaling(tu + mau - WAD)) {
    nextRateWad = clampRate(wmul(state.currentRateWad, DECREASE_COEFFICIENT_WAD));
  }

  const predictedOutcome: RateMoveOutcome =
    nextRateWad > state.currentRateWad
      ? "STEP_UP"
      : nextRateWad < state.currentRateWad
        ? "STEP_DOWN"
        : "NO_CHANGE";

  return {
    predictedOutcome,
    predictedNextRateWad: nextRateWad,
    predictedNextRateBps: toRateBps(nextRateWad),
    secondsUntilNextRateUpdate
  };
}

export function classifyAjnaNextRate(state: AjnaRateState): AjnaRatePrediction {
  const eligiblePrediction = forecastAjnaNextEligibleRate(state);

  if (
    eligiblePrediction.predictedOutcome === "RESET_TO_TEN" ||
    eligiblePrediction.secondsUntilNextRateUpdate <= 0
  ) {
    return eligiblePrediction;
  }

  return {
    predictedOutcome: "NO_CHANGE",
    predictedNextRateWad: state.currentRateWad,
    predictedNextRateBps: toRateBps(state.currentRateWad),
    secondsUntilNextRateUpdate: eligiblePrediction.secondsUntilNextRateUpdate
  };
}

function predictionChanged(
  baseline: AjnaRatePrediction,
  candidate: AjnaRatePrediction
): boolean {
  return (
    baseline.predictedOutcome !== candidate.predictedOutcome ||
    baseline.predictedNextRateWad !== candidate.predictedNextRateWad
  );
}

function addQuoteToRateState(
  state: AjnaRateState,
  quoteTokenAmount: bigint,
  quoteTokenScale: bigint
): AjnaRateState {
  return {
    ...state,
    depositEmaWad: state.depositEmaWad + quoteTokenAmount * quoteTokenScale
  };
}

function drawDebtIntoRateState(
  state: AjnaRateState,
  debtAmountWad: bigint,
  collateralAmountWad: bigint
): AjnaRateState {
  return {
    ...state,
    currentDebtWad: state.currentDebtWad + debtAmountWad,
    debtEmaWad: state.debtEmaWad + debtAmountWad,
    debtColEmaWad: state.debtColEmaWad + collateralAmountWad
  };
}

function resolveDrawDebtLimitIndexes(config: KeeperConfig): number[] {
  const configured = [
    ...(config.drawDebtLimitIndexes ?? []),
    ...(config.drawDebtLimitIndex === undefined ? [] : [config.drawDebtLimitIndex])
  ];

  return Array.from(new Set(configured)).sort((left, right) => left - right);
}

function resolveAddQuoteBucketIndexes(config: KeeperConfig): number[] {
  const configured = [
    ...(config.addQuoteBucketIndexes ?? []),
    ...(config.addQuoteBucketIndex === undefined ? [] : [config.addQuoteBucketIndex])
  ];

  return Array.from(new Set(configured)).sort((left, right) => left - right);
}

function priceToFenwickIndex(priceWad: bigint): number | undefined {
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

function deriveMeaningfulDepositThresholdFenwickIndex(
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

function resolvePreWindowLendBucketIndexes(
  readState: AjnaPoolStateRead,
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

function resolveDrawDebtCollateralAmounts(config: KeeperConfig): bigint[] {
  const configured = [
    ...(config.drawDebtCollateralAmounts ?? []),
    ...(config.drawDebtCollateralAmount === undefined ? [] : [config.drawDebtCollateralAmount])
  ];

  if (configured.length === 0) {
    return [0n];
  }

  return Array.from(new Set(configured)).sort((left, right) =>
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

async function resolvePoolAwareBorrowLimitIndexes(
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

function extractDrawDebtStep(candidate: PlanCandidate | undefined): DrawDebtStep | undefined {
  const drawDebtStep = candidate?.minimumExecutionSteps.find(
    (step): step is DrawDebtStep => step.type === "DRAW_DEBT"
  );

  return drawDebtStep;
}

function extractAddQuoteStep(candidate: PlanCandidate | undefined): AddQuoteStep | undefined {
  const addQuoteStep = candidate?.minimumExecutionSteps.find(
    (step): step is AddQuoteStep => step.type === "ADD_QUOTE"
  );

  return addQuoteStep;
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

function buildAnchoredSearchAmounts(
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

const DEFAULT_MAX_PROMISING_DUAL_BASINS = 6;
const DEFAULT_EXHAUSTIVE_DUAL_AXIS_SPAN = 64n;

export interface DualSearchPoint {
  quoteAmount: bigint;
  drawDebtAmount: bigint;
}

export interface DualSearchMatch<T> extends DualSearchPoint {
  evaluation: T;
}

interface ScalarSearchMatch<T> {
  amount: bigint;
  evaluation: T;
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

function buildMultiCycleLendSearchAmounts(
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

function buildTokenScaleAnchorAmounts(
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

function buildExposureFractionAnchorAmounts(
  maximumAmount: bigint,
  minimumAmount: bigint
): bigint[] {
  if (maximumAmount <= 0n || minimumAmount > maximumAmount) {
    return [];
  }

  const values = new Set<bigint>();
  for (const denominator of [1_000_000n, 100_000n, 10_000n, 1_000n, 100n, 10n, 2n]) {
    const amount = maximumAmount / denominator;
    if (amount >= minimumAmount && amount <= maximumAmount) {
      values.add(amount);
    }
  }

  return Array.from(values).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
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

function compressCapitalAwareSearchAmounts(
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

function finalizeCandidate(candidate: PlanCandidate): PlanCandidate {
  return withPlanCandidateCapitalMetrics(candidate);
}

function compareCandidatePreference(left: PlanCandidate, right: PlanCandidate): number {
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

function resolveBorrowSimulationLookaheadUpdates(config: KeeperConfig): number {
  return config.borrowSimulationLookaheadUpdates ?? 1;
}

export function resolveBorrowSimulationLookaheadAttempts(config: KeeperConfig): number[] {
  if (config.borrowSimulationLookaheadUpdates !== undefined) {
    return [config.borrowSimulationLookaheadUpdates];
  }

  return [1, DEFAULT_BORROW_LOOKAHEAD_FALLBACK_UPDATES];
}

function buildSnapshotFingerprint(
  poolAddress: HexAddress,
  blockNumber: bigint,
  state: AjnaRateState
): Hex {
  return keccak256(
    stringToHex(
      [
        poolAddress,
        blockNumber.toString(),
        state.currentRateWad.toString(),
        state.currentDebtWad.toString(),
        state.debtEmaWad.toString(),
        state.depositEmaWad.toString(),
        state.debtColEmaWad.toString(),
        state.lupt0DebtEmaWad.toString(),
        state.lastInterestRateUpdateTimestamp.toString(),
        state.nowTimestamp.toString()
      ].join(":")
    )
  );
}

function serializeExecutionStepForValidation(step: ExecutionStep): string {
  switch (step.type) {
    case "ADD_QUOTE":
      return [
        step.type,
        step.amount.toString(),
        String(step.bucketIndex),
        String(step.expiry),
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "REMOVE_QUOTE":
      return [
        step.type,
        step.amount.toString(),
        String(step.bucketIndex),
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "DRAW_DEBT":
      return [
        step.type,
        step.amount.toString(),
        String(step.limitIndex),
        step.collateralAmount?.toString() ?? "-",
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "REPAY_DEBT":
      return [
        step.type,
        step.amount.toString(),
        step.collateralAmountToPull?.toString() ?? "-",
        step.limitIndex === undefined ? "-" : String(step.limitIndex),
        step.recipient ?? "-",
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "ADD_COLLATERAL":
      return [
        step.type,
        step.amount.toString(),
        String(step.bucketIndex),
        step.expiry === undefined ? "-" : String(step.expiry),
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "REMOVE_COLLATERAL":
      return [
        step.type,
        step.amount.toString(),
        step.bucketIndex === undefined ? "-" : String(step.bucketIndex),
        step.bufferPolicy ?? "-",
        step.note ?? "-"
      ].join(":");
    case "UPDATE_INTEREST":
      return [step.type, step.bufferPolicy ?? "-", step.note ?? "-"].join(":");
  }
}

function referencedBucketIndexes(candidate: PlanCandidate): number[] {
  return Array.from(
    new Set(
      candidate.minimumExecutionSteps.flatMap((step) => {
        switch (step.type) {
          case "ADD_QUOTE":
          case "REMOVE_QUOTE":
          case "ADD_COLLATERAL":
            return [step.bucketIndex];
          case "REMOVE_COLLATERAL":
            return step.bucketIndex === undefined ? [] : [step.bucketIndex];
          default:
            return [];
        }
      })
    )
  ).sort((left, right) => left - right);
}

function serializeCandidateForValidation(candidate: PlanCandidate): string {
  return [
    candidate.intent,
    candidate.predictedOutcome,
    String(candidate.predictedRateBpsAfterNextUpdate),
    String(candidate.resultingDistanceToTargetBps),
    candidate.quoteTokenDelta.toString(),
    candidate.planningRateBps === undefined ? "-" : String(candidate.planningRateBps),
    candidate.planningLookaheadUpdates === undefined
      ? "-"
      : String(candidate.planningLookaheadUpdates),
    candidate.minimumExecutionSteps.map(serializeExecutionStepForValidation).join("|")
  ].join(":");
}

async function readManualCandidateBucketSignatures(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  blockNumber: bigint,
  manualCandidates: PlanCandidate[]
): Promise<Map<number, string>> {
  const bucketIndexes = Array.from(
    new Set(manualCandidates.flatMap((candidate) => referencedBucketIndexes(candidate)))
  ).sort((left, right) => left - right);
  const signatures = new Map<number, string>();

  await Promise.all(
    bucketIndexes.map(async (bucketIndex) => {
      try {
        const bucketState = await publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "bucketInfo",
          args: [BigInt(bucketIndex)],
          blockNumber
        });
        signatures.set(
          bucketIndex,
          bucketState.map((value) => value.toString()).join(":")
        );
      } catch {
        signatures.set(bucketIndex, "bucket-read-failed");
      }
    })
  );

  return signatures;
}

function buildManualCandidateValidationSignature(
  poolAddress: HexAddress,
  readState: AjnaPoolStateRead,
  candidate: PlanCandidate,
  bucketSignatures: Map<number, string>
): Hex {
  return keccak256(
    stringToHex(
      [
        poolAddress,
        readState.rateState.currentRateWad.toString(),
        readState.rateState.currentDebtWad.toString(),
        readState.rateState.debtEmaWad.toString(),
        readState.rateState.depositEmaWad.toString(),
        readState.rateState.debtColEmaWad.toString(),
        readState.rateState.lupt0DebtEmaWad.toString(),
        String(readState.rateState.lastInterestRateUpdateTimestamp),
        readState.loansState?.maxBorrower ?? "-",
        readState.loansState?.maxT0DebtToCollateral.toString() ?? "-",
        readState.loansState?.noOfLoans.toString() ?? "-",
        readState.borrowerState?.borrowerAddress ?? "-",
        readState.borrowerState?.t0Debt.toString() ?? "-",
        readState.borrowerState?.collateral.toString() ?? "-",
        readState.borrowerState?.npTpRatio.toString() ?? "-",
        referencedBucketIndexes(candidate)
          .map((bucketIndex) => `${bucketIndex}=${bucketSignatures.get(bucketIndex) ?? "-"}`)
          .join("|"),
        serializeCandidateForValidation(candidate)
      ].join(":")
    )
  );
}

async function enrichManualCandidatesForSnapshot(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  readState: AjnaPoolStateRead,
  manualCandidates: PlanCandidate[]
): Promise<PlanCandidate[]> {
  if (manualCandidates.length === 0) {
    return [];
  }

  const bucketSignatures = await readManualCandidateBucketSignatures(
    publicClient,
    poolAddress,
    readState.blockNumber,
    manualCandidates
  );

  return manualCandidates.map((candidate) => {
    const enrichedCandidate = structuredClone(candidate);
    enrichedCandidate.validationSignature = buildManualCandidateValidationSignature(
      poolAddress,
      readState,
      enrichedCandidate,
      bucketSignatures
    );
    return enrichedCandidate;
  });
}

async function readAjnaPoolState(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  nowSeconds?: number,
  blockNumber?: bigint,
  borrowerAddress?: HexAddress
): Promise<AjnaPoolStateRead> {
  const block = await publicClient.getBlock(
    blockNumber === undefined ? { blockTag: "latest" } : { blockNumber }
  );
  const effectiveBlockNumber = block.number;
  const effectiveNowSeconds = nowSeconds ?? Number(block.timestamp);

  const [
    [currentRateWad, interestRateUpdateTimestamp],
    [currentDebtWad, , , t0Debt2ToCollateralWad],
    [debtColEmaWad, lupt0DebtEmaWad, debtEmaWad, depositEmaWad],
    [inflatorWad],
    totalT0Debt,
    totalT0DebtInAuction,
    quoteTokenAddress,
    collateralAddress,
    quoteTokenScale,
    poolType,
    loansInfo,
    borrowerInfo
  ] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "interestRateInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "debtInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "emasInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "inflatorInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "totalT0Debt",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "totalT0DebtInAuction",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "quoteTokenAddress",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "collateralAddress",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "quoteTokenScale",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "poolType",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "loansInfo",
      blockNumber: effectiveBlockNumber
    }),
    borrowerAddress === undefined
      ? Promise.resolve(undefined)
      : publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "borrowerInfo",
          args: [borrowerAddress],
          blockNumber: effectiveBlockNumber
        })
  ]);

  const rateState: AjnaRateState = {
    currentRateWad,
    currentDebtWad,
    debtEmaWad,
    depositEmaWad,
    debtColEmaWad,
    lupt0DebtEmaWad,
    lastInterestRateUpdateTimestamp: Number(interestRateUpdateTimestamp),
    nowTimestamp: effectiveNowSeconds
  };
  const meaningfulDepositThresholdFenwickIndex = deriveMeaningfulDepositThresholdFenwickIndex(
    inflatorWad,
    totalT0Debt,
    totalT0DebtInAuction,
    t0Debt2ToCollateralWad
  );

  return {
    blockNumber: effectiveBlockNumber,
    blockTimestamp: Number(block.timestamp),
    rateState,
    prediction: forecastAjnaNextEligibleRate(rateState),
    immediatePrediction: classifyAjnaNextRate(rateState),
    inflatorWad,
    totalT0Debt,
    totalT0DebtInAuction,
    t0Debt2ToCollateralWad,
    ...(meaningfulDepositThresholdFenwickIndex === undefined
      ? {}
      : { meaningfulDepositThresholdFenwickIndex }),
    quoteTokenAddress,
    collateralAddress,
    quoteTokenScale,
    poolType,
    ...(borrowerInfo === undefined
      ? {}
      : {
          borrowerState: {
            borrowerAddress: borrowerAddress!,
            t0Debt: borrowerInfo[0],
            collateral: borrowerInfo[1],
            npTpRatio: borrowerInfo[2]
          }
        }),
    loansState: {
      maxBorrower: loansInfo[0] as HexAddress,
      maxT0DebtToCollateral: loansInfo[1],
      noOfLoans: loansInfo[2]
    }
  };
}

function buildPoolSnapshot(
  poolId: string,
  chainId: number,
  poolAddress: HexAddress,
  readState: AjnaPoolStateRead,
  autoCandidates: PlanCandidate[],
  manualCandidates: PlanCandidate[],
  autoCandidateSource?: "simulation" | "heuristic",
  planning?: {
    rateBps?: number;
    lookaheadUpdates?: number;
  }
): PoolSnapshot {
  return {
    snapshotFingerprint: buildSnapshotFingerprint(
      poolAddress,
      readState.blockNumber,
      readState.rateState
    ),
    poolId,
    chainId,
    blockNumber: readState.blockNumber,
    blockTimestamp: readState.blockTimestamp,
    snapshotAgeSeconds: Math.max(0, readState.rateState.nowTimestamp - readState.blockTimestamp),
    secondsUntilNextRateUpdate: readState.prediction.secondsUntilNextRateUpdate,
    currentRateBps: toRateBps(readState.rateState.currentRateWad),
    predictedNextOutcome: readState.prediction.predictedOutcome,
    predictedNextRateBps: readState.prediction.predictedNextRateBps,
    ...(planning?.rateBps === undefined ? {} : { planningRateBps: planning.rateBps }),
    ...(planning?.lookaheadUpdates === undefined
      ? {}
      : { planningLookaheadUpdates: planning.lookaheadUpdates }),
    candidates: [
      ...autoCandidates.map((candidate) => structuredClone(finalizeCandidate(candidate))),
      ...manualCandidates.map((candidate) => structuredClone(finalizeCandidate(candidate)))
    ],
    metadata: {
      poolAddress,
      quoteTokenAddress: readState.quoteTokenAddress,
      collateralAddress: readState.collateralAddress,
      quoteTokenScale: readState.quoteTokenScale.toString(),
      poolType: readState.poolType,
      maxBorrower: readState.loansState?.maxBorrower,
      maxT0DebtToCollateral: readState.loansState?.maxT0DebtToCollateral.toString(),
      noOfLoans: readState.loansState?.noOfLoans.toString(),
      borrowerAddress: readState.borrowerState?.borrowerAddress,
      borrowerT0Debt: readState.borrowerState?.t0Debt.toString(),
      borrowerCollateral: readState.borrowerState?.collateral.toString(),
      borrowerNpTpRatio: readState.borrowerState?.npTpRatio.toString(),
      currentRateWad: readState.rateState.currentRateWad.toString(),
      predictedNextRateWad: readState.prediction.predictedNextRateWad.toString(),
      immediatePredictedNextRateWad: readState.immediatePrediction.predictedNextRateWad.toString(),
      immediatePredictedNextOutcome: readState.immediatePrediction.predictedOutcome,
      lastInterestRateUpdateTimestamp: readState.rateState.lastInterestRateUpdateTimestamp,
      currentDebtWad: readState.rateState.currentDebtWad.toString(),
      debtEmaWad: readState.rateState.debtEmaWad.toString(),
      depositEmaWad: readState.rateState.depositEmaWad.toString(),
      debtColEmaWad: readState.rateState.debtColEmaWad.toString(),
      lupt0DebtEmaWad: readState.rateState.lupt0DebtEmaWad.toString(),
      autoCandidateCount: autoCandidates.length,
      autoCandidateSource,
      ...(planning?.rateBps === undefined ? {} : { planningRateBps: planning.rateBps }),
      ...(planning?.lookaheadUpdates === undefined
        ? {}
        : { planningLookaheadUpdates: planning.lookaheadUpdates })
    }
  };
}

async function readSimulationAccountState(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    needsQuoteState: boolean;
    needsCollateralState: boolean;
  }
): Promise<SimulationAccountState> {
  const simulationSenderAddress = resolveSimulationSenderAddress(config);
  const borrowerAddress = resolveSimulationBorrowerAddress(config, simulationSenderAddress);
  const snapshotFingerprint = buildSnapshotFingerprint(
    poolAddress,
    readState.blockNumber,
    readState.rateState
  );
  const cacheKey = buildSimulationCacheKey([
    "account-state",
    snapshotFingerprint,
    simulationSenderAddress,
    borrowerAddress,
    options.needsQuoteState ? "quote" : "no-quote",
    options.needsCollateralState ? "collateral" : "no-collateral"
  ]);
  const cached = simulationAccountStateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const [
    quoteTokenBalance,
    quoteTokenAllowance,
    collateralBalance,
    collateralAllowance
  ] = await Promise.all([
    options.needsQuoteState
      ? publicClient.readContract({
          address: readState.quoteTokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [simulationSenderAddress],
          blockNumber: readState.blockNumber
        })
      : Promise.resolve(undefined),
    options.needsQuoteState
      ? publicClient.readContract({
          address: readState.quoteTokenAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [simulationSenderAddress, poolAddress],
          blockNumber: readState.blockNumber
        })
      : Promise.resolve(undefined),
    options.needsCollateralState
      ? publicClient.readContract({
          address: readState.collateralAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [simulationSenderAddress],
          blockNumber: readState.blockNumber
        })
      : Promise.resolve(undefined),
    options.needsCollateralState
      ? publicClient.readContract({
          address: readState.collateralAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [simulationSenderAddress, poolAddress],
          blockNumber: readState.blockNumber
        })
      : Promise.resolve(undefined)
  ]);

  const accountState: SimulationAccountState = {
    simulationSenderAddress,
    borrowerAddress,
    ...(quoteTokenBalance === undefined ? {} : { quoteTokenBalance }),
    ...(quoteTokenAllowance === undefined ? {} : { quoteTokenAllowance }),
    ...(collateralBalance === undefined ? {} : { collateralBalance }),
    ...(collateralAllowance === undefined ? {} : { collateralAllowance })
  };
  setBoundedCacheEntry(
    simulationAccountStateCache,
    cacheKey,
    accountState,
    MAX_SIMULATION_ACCOUNT_STATE_CACHE_ENTRIES
  );
  return accountState;
}

export function synthesizeAjnaLendCandidate(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    quoteTokenScale: bigint;
    nowTimestamp: number;
    baselinePrediction?: AjnaRatePrediction;
  }
): PlanCandidate | undefined {
  const addQuoteBucketIndexes = resolveAddQuoteBucketIndexes(config);
  if (addQuoteBucketIndexes.length === 0 || options.quoteTokenScale <= 0n) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? classifyAjnaNextRate(state);
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
  if (baselineDistance === 0) {
    return undefined;
  }
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const maxAmount = config.maxQuoteTokenExposure;

  if (minimumAmount > maxAmount) {
    return undefined;
  }

  let bestCandidate: PlanCandidate | undefined;

  function evaluate(quoteTokenAmount: bigint): {
    prediction: AjnaRatePrediction;
    improvesConvergence: boolean;
  } {
    const prediction = forecastAjnaNextEligibleRate(
      addQuoteToRateState(state, quoteTokenAmount, options.quoteTokenScale)
    );
    const predictedDistance = distanceToTargetBand(
      prediction.predictedNextRateBps,
      targetBand
    );

    return {
      prediction,
      improvesConvergence:
        predictionChanged(baselinePrediction, prediction) &&
        predictedDistance < baselineDistance
    };
  }

  for (const addQuoteBucketIndex of addQuoteBucketIndexes) {
    let lowerBound = minimumAmount - 1n;
    let upperBound = minimumAmount;
    let upperEvaluation = evaluate(upperBound);

    while (!upperEvaluation.improvesConvergence) {
      lowerBound = upperBound;
      if (upperBound === maxAmount) {
        upperEvaluation = undefined as never;
        break;
      }

      upperBound = upperBound * 2n;
      if (upperBound > maxAmount) {
        upperBound = maxAmount;
      }
      upperEvaluation = evaluate(upperBound);
    }

    if (!upperEvaluation?.improvesConvergence) {
      continue;
    }

    while (upperBound - lowerBound > 1n) {
      const middle = lowerBound + (upperBound - lowerBound) / 2n;
      const middleEvaluation = evaluate(middle);
      if (middleEvaluation.improvesConvergence) {
        upperBound = middle;
        upperEvaluation = middleEvaluation;
      } else {
        lowerBound = middle;
      }
    }

    const expiry =
      options.nowTimestamp + (config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS);

    const candidate: PlanCandidate = {
      id: `auto-lend:${addQuoteBucketIndex}:add-quote:${upperBound.toString()}`,
      intent: "LEND",
      minimumExecutionSteps: [
        {
          type: "ADD_QUOTE",
          amount: upperBound,
          bucketIndex: addQuoteBucketIndex,
          expiry,
          note: "auto-synthesized add-quote threshold"
        }
      ],
      predictedOutcome: upperEvaluation.prediction.predictedOutcome,
      predictedRateBpsAfterNextUpdate: upperEvaluation.prediction.predictedNextRateBps,
      resultingDistanceToTargetBps: distanceToTargetBand(
        upperEvaluation.prediction.predictedNextRateBps,
        targetBand
      ),
      quoteTokenDelta: upperBound,
      explanation: `auto add-quote threshold changes the next Ajna move from ${baselinePrediction.predictedOutcome} to ${upperEvaluation.prediction.predictedOutcome}`
    };
    const finalizedCandidate = finalizeCandidate(candidate);

    if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
      bestCandidate = finalizedCandidate;
    }
  }

  return bestCandidate;
}

async function findOpenPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a local port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out waiting for localhost:${port}`);
}

async function stopChildProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
    }, 2_000);

    process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    process.kill("SIGTERM");
  });
}

async function withTemporaryAnvilFork<T>(
  options: {
    rpcUrl: string;
    chainId: number;
    blockNumber: bigint;
  },
  work: (context: {
    publicClient: PublicClient;
    testClient: ReturnType<typeof createTestClient>;
    walletClient: ReturnType<typeof createWalletClient>;
  }) => Promise<T>
): Promise<T> {
  return withLazyTemporaryAnvilFork(options, async (getContext) => {
    return work(await getContext());
  });
}

async function withLazyTemporaryAnvilFork<T>(
  options: {
    rpcUrl: string;
    chainId: number;
    blockNumber: bigint;
  },
  work: (getContext: () => Promise<{
    publicClient: PublicClient;
    testClient: ReturnType<typeof createTestClient>;
    walletClient: ReturnType<typeof createWalletClient>;
  }>) => Promise<T>
): Promise<T> {
  let handlePromise:
    | Promise<{
        publicClient: PublicClient;
        testClient: ReturnType<typeof createTestClient>;
        walletClient: ReturnType<typeof createWalletClient>;
        stop: () => Promise<void>;
      }>
    | undefined;

  async function getHandle() {
    if (!handlePromise) {
      handlePromise = startTemporaryAnvilFork(options);
    }

    return handlePromise;
  }

  try {
    return await work(async () => {
      const handle = await getHandle();
      return {
        publicClient: handle.publicClient,
        testClient: handle.testClient,
        walletClient: handle.walletClient
      };
    });
  } finally {
    if (handlePromise) {
      const handle = await handlePromise.catch(() => undefined);
      if (handle) {
        await handle.stop();
      }
    }
  }
}

async function startTemporaryAnvilFork(options: {
  rpcUrl: string;
  chainId: number;
  blockNumber: bigint;
}): Promise<{
  publicClient: PublicClient;
  testClient: ReturnType<typeof createTestClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  stop: () => Promise<void>;
}> {
  const port = await findOpenPort();
  let stderrBuffer = "";

  const anvil = spawn(
    "anvil",
    [
      "--fork-url",
      options.rpcUrl,
      "--fork-block-number",
      options.blockNumber.toString(),
      "--port",
      String(port),
      "--chain-id",
      String(options.chainId),
      "--silent"
    ],
    {
      stdio: ["ignore", "ignore", "pipe"]
    }
  );

  anvil.stderr?.setEncoding("utf8");
  anvil.stderr?.on("data", (chunk: string) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4_096);
  });

  try {
    await waitForPort(port);

    const rpcUrl = `http://127.0.0.1:${port}`;
    const forkChain = defineChain({
      id: options.chainId,
      name: `fork-${options.chainId}`,
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18
      },
      rpcUrls: {
        default: {
          http: [rpcUrl]
        }
      }
    });
    const publicClient = createPublicClient({
      transport: http(rpcUrl)
    });
    const testClient = createTestClient({
      mode: "anvil",
      transport: http(rpcUrl)
    });
    const walletClient = createWalletClient({
      chain: forkChain,
      transport: http(rpcUrl)
    });

    return {
      publicClient,
      testClient,
      walletClient,
      stop: async () => {
        await stopChildProcess(anvil);
      }
    };
  } catch (error) {
    await stopChildProcess(anvil);

    if (stderrBuffer.trim().length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${stderrBuffer.trim()}`
      );
    }

    throw error;
  }
}

function resolveSimulationSenderAddress(config: KeeperConfig): HexAddress {
  if (config.simulationSenderAddress) {
    return config.simulationSenderAddress;
  }

  const candidate = process.env.AJNA_KEEPER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!candidate) {
    throw new Error(
      "simulation-backed synthesis requires simulationSenderAddress or AJNA_KEEPER_PRIVATE_KEY/PRIVATE_KEY"
    );
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(candidate)) {
    throw new Error("simulation private key must be a 32-byte hex string");
  }

  return privateKeyToAccount(candidate as Hex).address as HexAddress;
}

function deriveRateMoveOutcome(
  previousRateWad: bigint,
  updatedRateWad: bigint
): RateMoveOutcome {
  if (updatedRateWad === RESET_RATE_WAD && previousRateWad > RESET_RATE_WAD) {
    return "RESET_TO_TEN";
  }

  if (updatedRateWad > previousRateWad) {
    return "STEP_UP";
  }

  if (updatedRateWad < previousRateWad) {
    return "STEP_DOWN";
  }

  return "NO_CHANGE";
}

async function synthesizeAjnaLendCandidateViaSimulation(
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    poolAddress: HexAddress;
    rpcUrl: string;
    baselinePrediction?: AjnaRatePrediction;
    accountState?: SimulationAccountState;
  }
): Promise<LendSimulationSynthesisResult | undefined> {
  const addQuoteBucketIndexes = resolveAddQuoteBucketIndexes(config);
  if (addQuoteBucketIndexes.length === 0) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? readState.prediction;
  if (distanceToTargetBand(baselinePrediction.predictedNextRateBps, targetBand) === 0) {
    return undefined;
  }
  const lookaheadUpdates = readState.immediatePrediction.secondsUntilNextRateUpdate > 0 ? 2 : 1;
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const heuristicSeedCandidate = synthesizeAjnaLendCandidate(readState.rateState, config, {
    quoteTokenScale: readState.quoteTokenScale,
    nowTimestamp: readState.rateState.nowTimestamp,
    baselinePrediction
  });
  const heuristicSeedAmounts = new Map<number, bigint>();
  if (heuristicSeedCandidate) {
    for (const step of heuristicSeedCandidate.minimumExecutionSteps) {
      if (step.type === "ADD_QUOTE") {
        heuristicSeedAmounts.set(step.bucketIndex, step.amount);
      }
    }
  }
  const simulationSenderAddress =
    options.accountState?.simulationSenderAddress ?? resolveSimulationSenderAddress(config);
  const snapshotFingerprint = buildSnapshotFingerprint(
    options.poolAddress,
    readState.blockNumber,
    readState.rateState
  );

  return withLazyTemporaryAnvilFork(
    {
      rpcUrl: options.rpcUrl,
      chainId: config.chainId,
      blockNumber: readState.blockNumber
    },
    async (getSimulationContext) => {
      let preparedSimulationContext = false;
      async function getPreparedSimulationContext() {
        const context = await getSimulationContext();
        if (!preparedSimulationContext) {
          await context.testClient.impersonateAccount({
            address: simulationSenderAddress
          });
          await context.testClient.setBalance({
            address: simulationSenderAddress,
            value: 10n ** 24n
          });
          preparedSimulationContext = true;
        }

        return context;
      }

      try {
        const effectiveAccountState =
          options.accountState ??
          (await (async (): Promise<SimulationAccountState> => {
            const { publicClient } = await getPreparedSimulationContext();
            const [quoteTokenBalance, quoteTokenAllowance] = await Promise.all([
              publicClient.readContract({
                address: readState.quoteTokenAddress,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [simulationSenderAddress]
              }),
              publicClient.readContract({
                address: readState.quoteTokenAddress,
                abi: erc20Abi,
                functionName: "allowance",
                args: [simulationSenderAddress, options.poolAddress]
              })
            ]);

            return {
              simulationSenderAddress,
              borrowerAddress: resolveSimulationBorrowerAddress(config, simulationSenderAddress),
              quoteTokenBalance,
              quoteTokenAllowance
            };
          })());

        const maxAmount = smallestBigInt(
          config.maxQuoteTokenExposure,
          effectiveAccountState.quoteTokenBalance ?? 0n,
          effectiveAccountState.quoteTokenAllowance ?? 0n
        );
        if (minimumAmount > maxAmount) {
          return undefined;
        }

        const expiryOffset = BigInt(
          config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS
        );
        const initialLastInterestRateUpdateTimestamp =
          readState.rateState.lastInterestRateUpdateTimestamp;
        const baselinePredictionState: AjnaRatePrediction = {
          predictedOutcome: baselinePrediction.predictedOutcome,
          predictedNextRateWad: baselinePrediction.predictedNextRateWad,
          predictedNextRateBps: baselinePrediction.predictedNextRateBps,
          secondsUntilNextRateUpdate: 0
        };
        let bestCandidate: PlanCandidate | undefined;

        async function simulateLendPath(
          addQuote:
            | {
                amount: bigint;
                bucketIndex: number;
              }
            | null
        ): Promise<LendSimulationPathResult> {
          const cacheKey = buildSimulationCacheKey([
            "lend",
            snapshotFingerprint,
            lookaheadUpdates,
            simulationSenderAddress,
            addQuote?.bucketIndex,
            addQuote?.amount ?? 0n
          ]);
          const cachedPath = lendSimulationPathCache.get(cacheKey);
          if (cachedPath !== undefined) {
            if (cachedPath === null) {
              throw new Error("cached lend simulation reverted");
            }
            return cachedPath;
          }

          const { publicClient, testClient, walletClient } = await getPreparedSimulationContext();
          const snapshotId = await testClient.snapshot();

          try {
            let firstRateWadAfterNextUpdate = readState.rateState.currentRateWad;
            let firstOutcome: RateMoveOutcome = "NO_CHANGE";
            let firstUpdateObserved = false;
            let simulatedReadState = readState;

            const maybeCaptureObservedUpdate = (stateAfterAction: AjnaPoolStateRead): void => {
              if (
                firstUpdateObserved ||
                stateAfterAction.rateState.lastInterestRateUpdateTimestamp ===
                  initialLastInterestRateUpdateTimestamp
              ) {
                return;
              }

              firstUpdateObserved = true;
              firstRateWadAfterNextUpdate = stateAfterAction.rateState.currentRateWad;
              firstOutcome = deriveRateMoveOutcome(
                readState.rateState.currentRateWad,
                firstRateWadAfterNextUpdate
              );
            };

            if (addQuote) {
              const simulationBlock = await publicClient.getBlock({ blockTag: "latest" });
              const hash = await walletClient.writeContract({
                account: simulationSenderAddress,
                chain: undefined,
                address: options.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "addQuoteToken",
                args: [
                  addQuote.amount,
                  BigInt(addQuote.bucketIndex),
                  simulationBlock.timestamp + expiryOffset
                ]
              });
              const receipt = await publicClient.waitForTransactionReceipt({ hash });
              if (receipt.status !== "success") {
                throw new Error("addQuoteToken simulation reverted");
              }

              const postActionReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              simulatedReadState = postActionReadState;
              maybeCaptureObservedUpdate(postActionReadState);
            }

            if (!firstUpdateObserved) {
              simulatedReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              if (simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate > 0) {
                await testClient.increaseTime({
                  seconds: simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate
                });
                await testClient.mine({
                  blocks: 1
                });
                simulatedReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              }

              const updateHash = await walletClient.writeContract({
                account: simulationSenderAddress,
                chain: undefined,
                address: options.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "updateInterest",
                args: []
              });
              const updateReceipt = await publicClient.waitForTransactionReceipt({
                hash: updateHash
              });
              if (updateReceipt.status !== "success") {
                throw new Error("updateInterest simulation reverted");
              }

              const postUpdateReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              simulatedReadState = postUpdateReadState;
              firstRateWadAfterNextUpdate = postUpdateReadState.rateState.currentRateWad;
              firstOutcome = deriveRateMoveOutcome(
                readState.rateState.currentRateWad,
                firstRateWadAfterNextUpdate
              );
            }

            let terminalRateWad = firstRateWadAfterNextUpdate;
            for (
              let completedLookaheadUpdates = 1;
              completedLookaheadUpdates < lookaheadUpdates;
              completedLookaheadUpdates += 1
            ) {
              if (simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate > 0) {
                await testClient.increaseTime({
                  seconds: simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate
                });
                await testClient.mine({
                  blocks: 1
                });
                simulatedReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              }

              const updateHash = await walletClient.writeContract({
                account: simulationSenderAddress,
                chain: undefined,
                address: options.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "updateInterest",
                args: []
              });
              const updateReceipt = await publicClient.waitForTransactionReceipt({
                hash: updateHash
              });
              if (updateReceipt.status !== "success") {
                throw new Error("updateInterest simulation reverted");
              }

              simulatedReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              terminalRateWad = simulatedReadState.rateState.currentRateWad;
            }

            const simulationResult: LendSimulationPathResult = {
              firstRateWadAfterNextUpdate,
              firstRateBpsAfterNextUpdate: toRateBps(firstRateWadAfterNextUpdate),
              firstOutcome,
              terminalRateBps: toRateBps(terminalRateWad),
              terminalDistanceToTargetBps: distanceToTargetBand(
                toRateBps(terminalRateWad),
                targetBand
              )
            };
            setBoundedCacheEntry(
              lendSimulationPathCache,
              cacheKey,
              simulationResult,
              MAX_EXACT_SIMULATION_PATH_CACHE_ENTRIES
            );
            return simulationResult;
          } catch (error) {
            setBoundedCacheEntry(
              lendSimulationPathCache,
              cacheKey,
              null,
              MAX_EXACT_SIMULATION_PATH_CACHE_ENTRIES
            );
            throw error;
          } finally {
            await testClient.revert({ id: snapshotId });
          }
        }

        let baselinePath: LendSimulationPathResult;
        try {
          baselinePath = await simulateLendPath(null);
        } catch {
          return undefined;
        }
        const baselineNextDistance = distanceToTargetBand(
          baselinePath.firstRateBpsAfterNextUpdate,
          targetBand
        );
        const baselineTerminalDistance = baselinePath.terminalDistanceToTargetBps;

        for (const addQuoteBucketIndex of addQuoteBucketIndexes) {
          const evaluate = async (
            quoteTokenAmount: bigint
          ): Promise<{
            predictedOutcome: RateMoveOutcome;
            predictedRateWadAfterNextUpdate: bigint;
            predictedRateBpsAfterNextUpdate: number;
            predictedDistanceToTargetBps: number;
            terminalRateBps: number;
            terminalDistanceToTargetBps: number;
            improvesConvergence: boolean;
          }> => {
            try {
              const candidatePath = await simulateLendPath({
                amount: quoteTokenAmount,
                bucketIndex: addQuoteBucketIndex
              });
              const predictedRateWadAfterNextUpdate = candidatePath.firstRateWadAfterNextUpdate;
              const predictedRateBpsAfterNextUpdate = candidatePath.firstRateBpsAfterNextUpdate;
              const predictedDistance = distanceToTargetBand(
                predictedRateBpsAfterNextUpdate,
                targetBand
              );
              const predictedOutcome = candidatePath.firstOutcome;

              return {
                predictedOutcome,
                predictedRateWadAfterNextUpdate,
                predictedRateBpsAfterNextUpdate,
                predictedDistanceToTargetBps: predictedDistance,
                terminalRateBps: candidatePath.terminalRateBps,
                terminalDistanceToTargetBps: candidatePath.terminalDistanceToTargetBps,
                improvesConvergence:
                  lookaheadUpdates > 1
                    ? candidatePath.terminalDistanceToTargetBps < baselineTerminalDistance
                    : predictionChanged(baselinePredictionState, {
                        predictedOutcome,
                        predictedNextRateWad: predictedRateWadAfterNextUpdate,
                        predictedNextRateBps: predictedRateBpsAfterNextUpdate,
                        secondsUntilNextRateUpdate: 0
                      }) &&
                      predictedDistance < baselineNextDistance
              };
            } catch {
              return {
                predictedOutcome: baselinePath.firstOutcome,
                predictedRateWadAfterNextUpdate: baselinePath.firstRateWadAfterNextUpdate,
                predictedRateBpsAfterNextUpdate: baselinePath.firstRateBpsAfterNextUpdate,
                predictedDistanceToTargetBps: baselineNextDistance,
                terminalRateBps: baselinePath.terminalRateBps,
                terminalDistanceToTargetBps: baselineTerminalDistance,
                improvesConvergence: false
              };
            }
          };

          let selectedQuoteAmount: bigint | undefined;
          let selectedEvaluation:
            | {
                predictedOutcome: RateMoveOutcome;
                predictedRateWadAfterNextUpdate: bigint;
                predictedRateBpsAfterNextUpdate: number;
                predictedDistanceToTargetBps: number;
                terminalRateBps: number;
                terminalDistanceToTargetBps: number;
                improvesConvergence: boolean;
              }
            | undefined;

          if (lookaheadUpdates > 1) {
            const anchorAmounts = [
              heuristicSeedAmounts.get(addQuoteBucketIndex),
              minimumAmount,
              ...buildExposureFractionAnchorAmounts(maxAmount, minimumAmount),
              ...buildTokenScaleAnchorAmounts(
                readState.quoteTokenScale,
                minimumAmount,
                maxAmount
              )
            ];
            const searchAmounts = compressCapitalAwareSearchAmounts(
              buildMultiCycleLendSearchAmounts(
                minimumAmount,
                maxAmount,
                anchorAmounts
              ),
              anchorAmounts,
              EXACT_MULTI_CYCLE_LEND_MAX_QUOTE_SAMPLES,
              EXACT_MULTI_CYCLE_LEND_LOW_END_QUOTE_SAMPLES
            );
            const improvingMatches: Array<
              ScalarSearchMatch<{
                predictedOutcome: RateMoveOutcome;
                predictedRateWadAfterNextUpdate: bigint;
                predictedRateBpsAfterNextUpdate: number;
                predictedDistanceToTargetBps: number;
                terminalRateBps: number;
                terminalDistanceToTargetBps: number;
                improvesConvergence: boolean;
              }>
            > = [];

            for (const quoteTokenAmount of searchAmounts) {
              const evaluation = await evaluate(quoteTokenAmount);
              if (evaluation.improvesConvergence) {
                improvingMatches.push({
                  amount: quoteTokenAmount,
                  evaluation
                });
              }
            }

            if (improvingMatches.length === 0) {
              continue;
            }

            improvingMatches.sort((left, right) => {
              if (left.amount !== right.amount) {
                return left.amount < right.amount ? -1 : 1;
              }

              if (
                left.evaluation.terminalDistanceToTargetBps !==
                right.evaluation.terminalDistanceToTargetBps
              ) {
                return (
                  left.evaluation.terminalDistanceToTargetBps -
                  right.evaluation.terminalDistanceToTargetBps
                );
              }

              if (
                left.evaluation.predictedDistanceToTargetBps !==
                right.evaluation.predictedDistanceToTargetBps
              ) {
                return (
                  left.evaluation.predictedDistanceToTargetBps -
                  right.evaluation.predictedDistanceToTargetBps
                );
              }

              return 0;
            });

            selectedQuoteAmount = improvingMatches[0]!.amount;
            selectedEvaluation = improvingMatches[0]!.evaluation;
          } else {
            let lowerBound = minimumAmount - 1n;
            let upperBound = heuristicSeedAmounts.get(addQuoteBucketIndex) ?? minimumAmount;
            if (upperBound < minimumAmount) {
              upperBound = minimumAmount;
            }
            if (upperBound > maxAmount) {
              upperBound = maxAmount;
            }
            let upperEvaluation = await evaluate(upperBound);

            while (!upperEvaluation.improvesConvergence) {
              lowerBound = upperBound;
              if (upperBound === maxAmount) {
                upperEvaluation = undefined as never;
                break;
              }

              upperBound = upperBound * 2n;
              if (upperBound > maxAmount) {
                upperBound = maxAmount;
              }
              upperEvaluation = await evaluate(upperBound);
            }

            if (!upperEvaluation?.improvesConvergence) {
              continue;
            }

            while (upperBound - lowerBound > 1n) {
              const middle = lowerBound + (upperBound - lowerBound) / 2n;
              const middleEvaluation = await evaluate(middle);
              if (middleEvaluation.improvesConvergence) {
                upperBound = middle;
                upperEvaluation = middleEvaluation;
              } else {
                lowerBound = middle;
              }
            }

            selectedQuoteAmount = upperBound;
            selectedEvaluation = upperEvaluation;
          }

          if (selectedQuoteAmount === undefined || selectedEvaluation === undefined) {
            continue;
          }

          const expiry =
            readState.rateState.nowTimestamp +
            (config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS);

          const candidate: PlanCandidate = {
            id: `sim-lend:${addQuoteBucketIndex}:add-quote:${selectedQuoteAmount.toString()}`,
            intent: "LEND",
            minimumExecutionSteps: [
              {
                type: "ADD_QUOTE",
                amount: selectedQuoteAmount,
                bucketIndex: addQuoteBucketIndex,
                expiry,
                note:
                  lookaheadUpdates > 1
                    ? "simulation-backed add-quote search result"
                    : "simulation-backed add-quote threshold"
              }
            ],
            predictedOutcome: selectedEvaluation.predictedOutcome,
            predictedRateBpsAfterNextUpdate: selectedEvaluation.predictedRateBpsAfterNextUpdate,
            resultingDistanceToTargetBps:
              lookaheadUpdates > 1
                ? selectedEvaluation.terminalDistanceToTargetBps
                : distanceToTargetBand(
                    selectedEvaluation.predictedRateBpsAfterNextUpdate,
                    targetBand
                  ),
            quoteTokenDelta: selectedQuoteAmount,
            explanation:
              lookaheadUpdates > 1
                ? `simulation-backed add-quote threshold improves the ${lookaheadUpdates}-update path from ${baselinePath.firstOutcome} to ${selectedEvaluation.predictedOutcome}`
                : `simulation-backed add-quote threshold changes the next eligible Ajna move from ${baselinePath.firstOutcome} to ${selectedEvaluation.predictedOutcome}`
          };
          if (lookaheadUpdates > 1) {
            candidate.planningRateBps = selectedEvaluation.terminalRateBps;
            candidate.planningLookaheadUpdates = lookaheadUpdates;
          }
          const finalizedCandidate = finalizeCandidate(candidate);

          if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
            bestCandidate = finalizedCandidate;
          }
        }

        return {
          ...(bestCandidate ? { candidate: bestCandidate } : {}),
          ...(lookaheadUpdates > 1
            ? {
                baselinePlanningRateBps: baselinePath.terminalRateBps,
                planningLookaheadUpdates: lookaheadUpdates
              }
            : {})
        };
      } finally {
        if (preparedSimulationContext) {
          const { testClient } = await getSimulationContext();
          await testClient.stopImpersonatingAccount({
            address: simulationSenderAddress
          });
        }
      }
    }
  );
}

function resolveSimulationBorrowerAddress(
  config: KeeperConfig,
  simulationSenderAddress: HexAddress
): HexAddress {
  return config.borrowerAddress ?? simulationSenderAddress;
}

export function synthesizeAjnaBorrowCandidate(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    baselinePrediction?: AjnaRatePrediction;
  }
): PlanCandidate | undefined {
  const limitIndexes = resolveDrawDebtLimitIndexes(config);
  if (limitIndexes.length === 0) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? forecastAjnaNextEligibleRate(state);
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
  if (baselineDistance === 0) {
    return undefined;
  }
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const maxAmount = config.maxBorrowExposure;
  const collateralAmounts = resolveDrawDebtCollateralAmounts(config);

  if (minimumAmount > maxAmount) {
    return undefined;
  }
  let bestCandidate: PlanCandidate | undefined;

  for (const limitIndex of limitIndexes) {
    for (const collateralAmount of collateralAmounts) {
      function evaluate(drawDebtAmount: bigint): {
        prediction: AjnaRatePrediction;
        improvesConvergence: boolean;
      } {
        const prediction = forecastAjnaNextEligibleRate(
          drawDebtIntoRateState(state, drawDebtAmount, collateralAmount)
        );
        const predictedDistance = distanceToTargetBand(
          prediction.predictedNextRateBps,
          targetBand
        );

        return {
          prediction,
          improvesConvergence:
            predictionChanged(baselinePrediction, prediction) &&
            predictedDistance < baselineDistance
        };
      }

      let lowerBound = minimumAmount - 1n;
      let upperBound = minimumAmount;
      let upperEvaluation = evaluate(upperBound);

      while (!upperEvaluation.improvesConvergence) {
        lowerBound = upperBound;
        if (upperBound === maxAmount) {
          upperEvaluation = undefined as never;
          break;
        }

        upperBound = upperBound * 2n;
        if (upperBound > maxAmount) {
          upperBound = maxAmount;
        }
        upperEvaluation = evaluate(upperBound);
      }

      if (!upperEvaluation?.improvesConvergence) {
        continue;
      }

      while (upperBound - lowerBound > 1n) {
        const middle = lowerBound + (upperBound - lowerBound) / 2n;
        const middleEvaluation = evaluate(middle);
        if (middleEvaluation.improvesConvergence) {
          upperBound = middle;
          upperEvaluation = middleEvaluation;
        } else {
          lowerBound = middle;
        }
      }

      const candidate: PlanCandidate = {
        id: `auto-borrow:${limitIndex}:${collateralAmount.toString()}:draw-debt:${upperBound.toString()}`,
        intent: "BORROW",
        minimumExecutionSteps: [
          {
            type: "DRAW_DEBT",
            amount: upperBound,
            limitIndex,
            collateralAmount,
            note: "auto-synthesized draw-debt threshold"
          }
        ],
        predictedOutcome: upperEvaluation.prediction.predictedOutcome,
        predictedRateBpsAfterNextUpdate: upperEvaluation.prediction.predictedNextRateBps,
        resultingDistanceToTargetBps: distanceToTargetBand(
          upperEvaluation.prediction.predictedNextRateBps,
          targetBand
        ),
        quoteTokenDelta: upperBound,
        explanation: `auto draw-debt threshold changes the next eligible Ajna move from ${baselinePrediction.predictedOutcome} to ${upperEvaluation.prediction.predictedOutcome}`
      };
      const finalizedCandidate = finalizeCandidate(candidate);

      if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
        bestCandidate = finalizedCandidate;
      }
    }
  }

  return bestCandidate;
}

function findPureBorrowImprovementThresholdForCollateral(
  state: AjnaRateState,
  targetBand: ReturnType<typeof buildTargetBand>,
  baselinePrediction: AjnaRatePrediction,
  minimumAmount: bigint,
  maximumAmount: bigint,
  collateralAmount: bigint
): bigint | undefined {
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );

  function evaluate(drawDebtAmount: bigint): {
    prediction: AjnaRatePrediction;
    improvesConvergence: boolean;
  } {
    const prediction = forecastAjnaNextEligibleRate(
      drawDebtIntoRateState(state, drawDebtAmount, collateralAmount)
    );
    const predictedDistance = distanceToTargetBand(
      prediction.predictedNextRateBps,
      targetBand
    );

    return {
      prediction,
      improvesConvergence:
        predictionChanged(baselinePrediction, prediction) &&
        predictedDistance < baselineDistance
    };
  }

  let lowerBound = minimumAmount - 1n;
  let upperBound = minimumAmount;
  let upperEvaluation = evaluate(upperBound);

  while (!upperEvaluation.improvesConvergence) {
    lowerBound = upperBound;
    if (upperBound === maximumAmount) {
      return undefined;
    }

    upperBound = upperBound * 2n;
    if (upperBound > maximumAmount) {
      upperBound = maximumAmount;
    }
    upperEvaluation = evaluate(upperBound);
  }

  while (upperBound - lowerBound > 1n) {
    const middle = lowerBound + (upperBound - lowerBound) / 2n;
    const middleEvaluation = evaluate(middle);
    if (middleEvaluation.improvesConvergence) {
      upperBound = middle;
      upperEvaluation = middleEvaluation;
    } else {
      lowerBound = middle;
    }
  }

  return upperBound;
}

export function synthesizeAjnaLendAndBorrowCandidate(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    quoteTokenScale: bigint;
    nowTimestamp: number;
    baselinePrediction?: AjnaRatePrediction;
    anchorBorrowCandidate?: PlanCandidate;
  }
): PlanCandidate | undefined {
  const addQuoteBucketIndexes = resolveAddQuoteBucketIndexes(config);
  if (addQuoteBucketIndexes.length === 0 || options.quoteTokenScale <= 0n) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? forecastAjnaNextEligibleRate(state);
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
  if (baselineDistance === 0) {
    return undefined;
  }
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const maxQuoteAmount = config.maxQuoteTokenExposure;
  const maxBorrowAmount = config.maxBorrowExposure;

  if (minimumAmount > maxQuoteAmount || minimumAmount > maxBorrowAmount) {
    return undefined;
  }

  const anchorBorrowCandidate =
    options.anchorBorrowCandidate ??
    synthesizeAjnaBorrowCandidate(state, config, { baselinePrediction });
  const anchorDrawDebtStep = extractDrawDebtStep(anchorBorrowCandidate);
  if (!anchorDrawDebtStep) {
    return undefined;
  }

  const collateralAmount = anchorDrawDebtStep.collateralAmount ?? 0n;

  function evaluateBorrowOnly(drawDebtAmount: bigint): {
    prediction: AjnaRatePrediction;
    distance: number;
  } {
    const prediction = forecastAjnaNextEligibleRate(
      drawDebtIntoRateState(state, drawDebtAmount, collateralAmount)
    );
    return {
      prediction,
      distance: distanceToTargetBand(prediction.predictedNextRateBps, targetBand)
    };
  }

  function evaluateCombined(
    drawDebtAmount: bigint,
    quoteTokenAmount: bigint
  ): {
    prediction: AjnaRatePrediction;
    distance: number;
    improvesConvergence: boolean;
  } {
    const prediction = forecastAjnaNextEligibleRate(
      addQuoteToRateState(
        drawDebtIntoRateState(state, drawDebtAmount, collateralAmount),
        quoteTokenAmount,
        options.quoteTokenScale
      )
    );
    const distance = distanceToTargetBand(prediction.predictedNextRateBps, targetBand);

    return {
      prediction,
      distance,
      improvesConvergence:
        predictionChanged(baselinePrediction, prediction) && distance < baselineDistance
    };
  }

  let overshootBorrowAmount =
    anchorDrawDebtStep.amount >= minimumAmount ? anchorDrawDebtStep.amount : minimumAmount;
  let overshootBorrowEvaluation = evaluateBorrowOnly(overshootBorrowAmount);

  if (overshootBorrowEvaluation.prediction.predictedNextRateBps <= targetBand.maxRateBps) {
    let lowerBorrowAmount = overshootBorrowAmount;
    let upperBorrowAmount = overshootBorrowAmount;
    let upperBorrowEvaluation = overshootBorrowEvaluation;

    while (upperBorrowEvaluation.prediction.predictedNextRateBps <= targetBand.maxRateBps) {
      lowerBorrowAmount = upperBorrowAmount;
      if (upperBorrowAmount === maxBorrowAmount) {
        return undefined;
      }

      upperBorrowAmount = upperBorrowAmount * 2n;
      if (upperBorrowAmount > maxBorrowAmount) {
        upperBorrowAmount = maxBorrowAmount;
      }
      upperBorrowEvaluation = evaluateBorrowOnly(upperBorrowAmount);
    }

    while (upperBorrowAmount - lowerBorrowAmount > 1n) {
      const middleBorrowAmount =
        lowerBorrowAmount + (upperBorrowAmount - lowerBorrowAmount) / 2n;
      const middleBorrowEvaluation = evaluateBorrowOnly(middleBorrowAmount);
      if (middleBorrowEvaluation.prediction.predictedNextRateBps > targetBand.maxRateBps) {
        upperBorrowAmount = middleBorrowAmount;
        upperBorrowEvaluation = middleBorrowEvaluation;
      } else {
        lowerBorrowAmount = middleBorrowAmount;
      }
    }

    overshootBorrowAmount = upperBorrowAmount;
    overshootBorrowEvaluation = upperBorrowEvaluation;
  }

  if (overshootBorrowEvaluation.distance === 0) {
    return undefined;
  }

  function dualCandidateCondition(evaluation: {
    prediction: AjnaRatePrediction;
    distance: number;
    improvesConvergence: boolean;
  }): boolean {
    return (
      evaluation.improvesConvergence &&
      evaluation.distance < overshootBorrowEvaluation.distance &&
      evaluation.prediction.predictedNextRateBps <= targetBand.maxRateBps
    );
  }

  let lowerQuoteAmount = minimumAmount - 1n;
  let upperQuoteAmount = minimumAmount;
  let upperQuoteEvaluation = evaluateCombined(overshootBorrowAmount, upperQuoteAmount);

  while (!dualCandidateCondition(upperQuoteEvaluation)) {
    lowerQuoteAmount = upperQuoteAmount;
    if (upperQuoteAmount === maxQuoteAmount) {
      return undefined;
    }

    upperQuoteAmount = upperQuoteAmount * 2n;
    if (upperQuoteAmount > maxQuoteAmount) {
      upperQuoteAmount = maxQuoteAmount;
    }
    upperQuoteEvaluation = evaluateCombined(overshootBorrowAmount, upperQuoteAmount);
  }

  while (upperQuoteAmount - lowerQuoteAmount > 1n) {
    const middleQuoteAmount =
      lowerQuoteAmount + (upperQuoteAmount - lowerQuoteAmount) / 2n;
    const middleQuoteEvaluation = evaluateCombined(overshootBorrowAmount, middleQuoteAmount);
    if (dualCandidateCondition(middleQuoteEvaluation)) {
      upperQuoteAmount = middleQuoteAmount;
      upperQuoteEvaluation = middleQuoteEvaluation;
    } else {
      lowerQuoteAmount = middleQuoteAmount;
    }
  }

  const expiry =
    options.nowTimestamp + (config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS);
  let bestCandidate: PlanCandidate | undefined;

  for (const addQuoteBucketIndex of addQuoteBucketIndexes) {
    const candidate: PlanCandidate = {
      id: `auto-dual:${addQuoteBucketIndex}:${anchorDrawDebtStep.limitIndex}:${collateralAmount.toString()}:add-quote:${upperQuoteAmount.toString()}:draw-debt:${overshootBorrowAmount.toString()}`,
      intent: "LEND_AND_BORROW",
      minimumExecutionSteps: [
        {
          type: "ADD_QUOTE",
          amount: upperQuoteAmount,
          bucketIndex: addQuoteBucketIndex,
          expiry,
          note: "auto-synthesized add-quote threshold for dual-side steering"
        },
        {
          type: "DRAW_DEBT",
          amount: overshootBorrowAmount,
          limitIndex: anchorDrawDebtStep.limitIndex,
          collateralAmount,
          note: "auto-synthesized draw-debt threshold for dual-side steering"
        }
      ],
      predictedOutcome: upperQuoteEvaluation.prediction.predictedOutcome,
      predictedRateBpsAfterNextUpdate: upperQuoteEvaluation.prediction.predictedNextRateBps,
      resultingDistanceToTargetBps: upperQuoteEvaluation.distance,
      quoteTokenDelta: upperQuoteAmount + overshootBorrowAmount,
      explanation: `auto add-quote + draw-debt path tempers a borrow overshoot from ${overshootBorrowEvaluation.prediction.predictedOutcome} to ${upperQuoteEvaluation.prediction.predictedOutcome}`
    };
    const finalizedCandidate = finalizeCandidate(candidate);

    if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
      bestCandidate = finalizedCandidate;
    }
  }

  return bestCandidate;
}

export function synthesizeAjnaHeuristicCandidates(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    quoteTokenScale: bigint;
    nowTimestamp: number;
    baselinePrediction?: AjnaRatePrediction;
    allowPreWindowLend?: boolean;
  }
): PlanCandidate[] {
  const candidates: PlanCandidate[] = [];
  const allowPreWindowLend = options.allowPreWindowLend ?? true;
  const heuristicBorrowCandidate = config.enableHeuristicBorrowSynthesis
    ? synthesizeAjnaBorrowCandidate(state, config, {
        ...(options.baselinePrediction === undefined
          ? {}
          : { baselinePrediction: options.baselinePrediction })
      })
    : undefined;

  if (heuristicBorrowCandidate) {
    candidates.push(heuristicBorrowCandidate);
  }

  if (config.enableHeuristicLendSynthesis && allowPreWindowLend) {
    const lendCandidate = synthesizeAjnaLendCandidate(state, config, {
      quoteTokenScale: options.quoteTokenScale,
      nowTimestamp: options.nowTimestamp,
      ...(options.baselinePrediction === undefined
          ? {}
        : { baselinePrediction: options.baselinePrediction })
    });
    if (lendCandidate) {
      candidates.push(lendCandidate);
    }

    const dualCandidate = synthesizeAjnaLendAndBorrowCandidate(
      state,
      config,
      {
        quoteTokenScale: options.quoteTokenScale,
        nowTimestamp: options.nowTimestamp,
        ...(options.baselinePrediction === undefined
          ? {}
          : { baselinePrediction: options.baselinePrediction }),
        ...(heuristicBorrowCandidate === undefined
          ? {}
          : { anchorBorrowCandidate: heuristicBorrowCandidate })
      }
    );
    if (dualCandidate) {
      candidates.push(dualCandidate);
    }
  }

  return candidates;
}

async function synthesizeAjnaBorrowCandidateViaSimulation(
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    poolAddress: HexAddress;
    rpcUrl: string;
    baselinePrediction?: AjnaRatePrediction;
    accountState?: SimulationAccountState;
  }
): Promise<BorrowSimulationSynthesisResult | undefined> {
  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? readState.prediction;
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const maxAmount = config.maxBorrowExposure;
  if (minimumAmount > maxAmount) {
    return undefined;
  }

  const simulationSenderAddress =
    options.accountState?.simulationSenderAddress ?? resolveSimulationSenderAddress(config);
  const borrowerAddress =
    options.accountState?.borrowerAddress ??
    resolveSimulationBorrowerAddress(config, simulationSenderAddress);
  const lookaheadUpdates = resolveBorrowSimulationLookaheadUpdates(config);
  const heuristicBorrowAnchor =
    lookaheadUpdates === 1
      ? synthesizeAjnaBorrowCandidate(readState.rateState, config, {
          baselinePrediction
        })
      : undefined;
  const heuristicDrawDebtStep = extractDrawDebtStep(heuristicBorrowAnchor);
  const initialLastInterestRateUpdateTimestamp =
    readState.rateState.lastInterestRateUpdateTimestamp;
  const snapshotFingerprint = buildSnapshotFingerprint(
    options.poolAddress,
    readState.blockNumber,
    readState.rateState
  );
  if (
    lookaheadUpdates === 1 &&
    distanceToTargetBand(baselinePrediction.predictedNextRateBps, targetBand) === 0
  ) {
    return undefined;
  }
  if (lookaheadUpdates === 1 && !heuristicDrawDebtStep) {
    return undefined;
  }

  return withLazyTemporaryAnvilFork(
    {
      rpcUrl: options.rpcUrl,
      chainId: config.chainId,
      blockNumber: readState.blockNumber
    },
    async (getSimulationContext) => {
      let preparedSimulationContext = false;
      async function getPreparedSimulationContext() {
        const context = await getSimulationContext();
        if (!preparedSimulationContext) {
          await context.testClient.impersonateAccount({
            address: simulationSenderAddress
          });
          await context.testClient.setBalance({
            address: simulationSenderAddress,
            value: 10n ** 24n
          });
          preparedSimulationContext = true;
        }

        return context;
      }

      try {
        const { publicClient } = await getPreparedSimulationContext();
        const effectiveAccountState =
          options.accountState ??
          (await (async (): Promise<SimulationAccountState> => {
            const [collateralBalance, collateralAllowance] = await Promise.all([
              publicClient.readContract({
                address: readState.collateralAddress,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [simulationSenderAddress]
              }),
              publicClient.readContract({
                address: readState.collateralAddress,
                abi: erc20Abi,
                functionName: "allowance",
                args: [simulationSenderAddress, options.poolAddress]
              })
            ]);

            return {
              simulationSenderAddress,
              borrowerAddress,
              collateralBalance,
              collateralAllowance
            };
          })());
        const maxAvailableCollateral = smallestBigInt(
          effectiveAccountState.collateralBalance ?? 0n,
          effectiveAccountState.collateralAllowance ?? 0n
        );
        const candidateCollateralAmounts =
          lookaheadUpdates === 1 && heuristicDrawDebtStep
            ? [heuristicDrawDebtStep.collateralAmount ?? 0n].filter(
                (collateralAmount) => collateralAmount <= maxAvailableCollateral
              )
            : resolveSimulationBorrowCollateralAmounts(
                config,
                maxAvailableCollateral,
                {
                  borrowerHasExistingPosition:
                    (readState.borrowerState?.t0Debt ?? 0n) > 0n ||
                    (readState.borrowerState?.collateral ?? 0n) > 0n
                }
              );
        if (candidateCollateralAmounts.length === 0) {
          return undefined;
        }
        const allLimitIndexes = await resolvePoolAwareBorrowLimitIndexes(
          publicClient,
          options.poolAddress,
          readState.blockNumber,
          config
        );
        const limitIndexes =
          lookaheadUpdates === 1 && heuristicDrawDebtStep
            ? allLimitIndexes.filter(
                (limitIndex) => limitIndex === heuristicDrawDebtStep.limitIndex
              )
            : allLimitIndexes;
        if (limitIndexes.length === 0) {
          return undefined;
        }
        const exactBorrowSearchInputs = candidateCollateralAmounts
          .map((collateralAmount) => ({
            collateralAmount,
            pureThresholdAmount:
              lookaheadUpdates === 1
                ? (() => {
                    const heuristicCollateralAmount =
                      heuristicDrawDebtStep?.collateralAmount ?? 0n;
                    const heuristicThresholdAmount =
                      heuristicDrawDebtStep?.amount !== undefined &&
                      heuristicCollateralAmount === collateralAmount
                        ? heuristicDrawDebtStep.amount
                        : undefined;
                    return (
                      findPureBorrowImprovementThresholdForCollateral(
                        readState.rateState,
                        targetBand,
                        baselinePrediction,
                        minimumAmount,
                        maxAmount,
                        collateralAmount
                      ) ?? heuristicThresholdAmount
                    );
                  })()
                : undefined
          }))
          .filter(
            (entry) => lookaheadUpdates > 1 || entry.pureThresholdAmount !== undefined
          );
        if (exactBorrowSearchInputs.length === 0) {
          return undefined;
        }

        async function simulateBorrowPath(
          drawDebt: {
            amount: bigint;
            limitIndex: number;
            collateralAmount: bigint;
          } | null
        ): Promise<BorrowSimulationPathResult> {
          const cacheKey = buildSimulationCacheKey([
            "borrow",
            snapshotFingerprint,
            simulationSenderAddress,
            borrowerAddress,
            lookaheadUpdates,
            drawDebt?.limitIndex,
            drawDebt?.collateralAmount ?? 0n,
            drawDebt?.amount ?? 0n
          ]);
          const cachedPath = borrowSimulationPathCache.get(cacheKey);
          if (cachedPath !== undefined) {
            if (cachedPath === null) {
              throw new Error("cached borrow simulation reverted");
            }
            return cachedPath;
          }

          const { publicClient, testClient, walletClient } = await getPreparedSimulationContext();
          const snapshotId = await testClient.snapshot();

          try {
            let firstRateWadAfterNextUpdate = readState.rateState.currentRateWad;
            let firstOutcome: RateMoveOutcome = "NO_CHANGE";
            let terminalRateWad = readState.rateState.currentRateWad;
            let completedLookaheadUpdates = 0;

            const maybeCaptureObservedUpdate = (stateAfterAction: AjnaPoolStateRead): void => {
              terminalRateWad = stateAfterAction.rateState.currentRateWad;
              if (
                completedLookaheadUpdates > 0 ||
                stateAfterAction.rateState.lastInterestRateUpdateTimestamp ===
                  initialLastInterestRateUpdateTimestamp
              ) {
                return;
              }

              completedLookaheadUpdates = 1;
              firstRateWadAfterNextUpdate = stateAfterAction.rateState.currentRateWad;
              firstOutcome = deriveRateMoveOutcome(
                readState.rateState.currentRateWad,
                firstRateWadAfterNextUpdate
              );
            };

            if (drawDebt) {
              const drawDebtHash = await walletClient.writeContract({
                account: simulationSenderAddress,
                chain: undefined,
                address: options.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "drawDebt",
                args: [
                  borrowerAddress,
                  drawDebt.amount,
                  BigInt(drawDebt.limitIndex),
                  drawDebt.collateralAmount
                ]
              });
              const drawDebtReceipt = await publicClient.waitForTransactionReceipt({
                hash: drawDebtHash
              });
              if (drawDebtReceipt.status !== "success") {
                throw new Error("drawDebt simulation reverted");
              }

              const postDrawDebtReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              maybeCaptureObservedUpdate(postDrawDebtReadState);
            }

            for (; completedLookaheadUpdates < lookaheadUpdates; completedLookaheadUpdates += 1) {
              let simulatedReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              if (simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate > 0) {
                await testClient.increaseTime({
                  seconds: simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate
                });
                await testClient.mine({
                  blocks: 1
                });
                simulatedReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              }

              const updateHash = await walletClient.writeContract({
                account: simulationSenderAddress,
                chain: undefined,
                address: options.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "updateInterest",
                args: []
              });
              const updateReceipt = await publicClient.waitForTransactionReceipt({
                hash: updateHash
              });
              if (updateReceipt.status !== "success") {
                throw new Error("updateInterest simulation reverted");
              }

              const postUpdateReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              terminalRateWad = postUpdateReadState.rateState.currentRateWad;

              if (completedLookaheadUpdates === 0) {
                firstRateWadAfterNextUpdate = terminalRateWad;
                firstOutcome = deriveRateMoveOutcome(
                  readState.rateState.currentRateWad,
                  terminalRateWad
                );
              }
            }

            const firstRateBpsAfterNextUpdate = toRateBps(firstRateWadAfterNextUpdate);
            const terminalRateBps = toRateBps(terminalRateWad);

            const simulationResult: BorrowSimulationPathResult = {
              firstRateWadAfterNextUpdate,
              firstRateBpsAfterNextUpdate,
              firstOutcome,
              terminalRateBps,
              terminalDistanceToTargetBps: distanceToTargetBand(terminalRateBps, targetBand)
            };
            setBoundedCacheEntry(
              borrowSimulationPathCache,
              cacheKey,
              simulationResult,
              MAX_EXACT_SIMULATION_PATH_CACHE_ENTRIES
            );
            return simulationResult;
          } catch (error) {
            setBoundedCacheEntry(
              borrowSimulationPathCache,
              cacheKey,
              null,
              MAX_EXACT_SIMULATION_PATH_CACHE_ENTRIES
            );
            throw error;
          } finally {
            await testClient.revert({ id: snapshotId });
          }
        }

        const baselinePath = await simulateBorrowPath(null);
        const baselineNextDistance = distanceToTargetBand(
          baselinePath.firstRateBpsAfterNextUpdate,
          targetBand
        );
        const baselineTerminalDistance = baselinePath.terminalDistanceToTargetBps;

        let bestCandidate: PlanCandidate | undefined;

        for (const limitIndex of limitIndexes) {
          for (const {
            collateralAmount,
            pureThresholdAmount
          } of exactBorrowSearchInputs) {
            const evaluate = async (
              drawDebtAmount: bigint
            ): Promise<{
              predictedOutcome: RateMoveOutcome;
              predictedRateBpsAfterNextUpdate: number;
              terminalRateBps: number;
              terminalDistanceToTargetBps: number;
              improvesConvergence: boolean;
            }> => {
              try {
                const candidatePath = await simulateBorrowPath({
                  amount: drawDebtAmount,
                  limitIndex,
                  collateralAmount
                });
                const nextDistance = distanceToTargetBand(
                  candidatePath.firstRateBpsAfterNextUpdate,
                  targetBand
                );
                return {
                  predictedOutcome: candidatePath.firstOutcome,
                  predictedRateBpsAfterNextUpdate: candidatePath.firstRateBpsAfterNextUpdate,
                  terminalRateBps: candidatePath.terminalRateBps,
                  terminalDistanceToTargetBps: candidatePath.terminalDistanceToTargetBps,
                  improvesConvergence:
                    nextDistance <= baselineNextDistance &&
                    candidatePath.terminalDistanceToTargetBps < baselineTerminalDistance
                };
              } catch {
                return {
                  predictedOutcome: baselinePrediction.predictedOutcome,
                  predictedRateBpsAfterNextUpdate: baselinePrediction.predictedNextRateBps,
                  terminalRateBps: baselinePath.terminalRateBps,
                  terminalDistanceToTargetBps: baselineTerminalDistance,
                  improvesConvergence: false
                };
              }
            };

            const initialUpperBound =
              pureThresholdAmount !== undefined && pureThresholdAmount >= minimumAmount
                ? pureThresholdAmount
                : minimumAmount;
            let lowerBound =
              pureThresholdAmount !== undefined && pureThresholdAmount > minimumAmount
                ? minimumAmount - 1n
                : minimumAmount - 1n;
            let upperBound = initialUpperBound;
            let upperEvaluation = await evaluate(upperBound);

            while (!upperEvaluation.improvesConvergence) {
              lowerBound = upperBound;
              if (upperBound === maxAmount) {
                upperEvaluation = undefined as never;
                break;
              }

              upperBound = upperBound * 2n;
              if (upperBound > maxAmount) {
                upperBound = maxAmount;
              }
              upperEvaluation = await evaluate(upperBound);
            }

            if (!upperEvaluation?.improvesConvergence) {
              continue;
            }

            while (upperBound - lowerBound > 1n) {
              const middle = lowerBound + (upperBound - lowerBound) / 2n;
              const middleEvaluation = await evaluate(middle);
              if (middleEvaluation.improvesConvergence) {
                upperBound = middle;
                upperEvaluation = middleEvaluation;
              } else {
                lowerBound = middle;
              }
            }

            const candidate: PlanCandidate = {
              id: `sim-borrow:${limitIndex}:${collateralAmount.toString()}:draw-debt:${upperBound.toString()}`,
              intent: "BORROW",
              minimumExecutionSteps: [
                {
                  type: "DRAW_DEBT",
                  amount: upperBound,
                  limitIndex,
                  collateralAmount,
                  note: "simulation-backed draw-debt threshold"
                }
              ],
              predictedOutcome: upperEvaluation.predictedOutcome,
              predictedRateBpsAfterNextUpdate: upperEvaluation.predictedRateBpsAfterNextUpdate,
              resultingDistanceToTargetBps: upperEvaluation.terminalDistanceToTargetBps,
              quoteTokenDelta: upperBound,
              explanation:
                lookaheadUpdates > 1
                  ? `simulation-backed draw-debt threshold improves the ${lookaheadUpdates}-update path from ${baselinePrediction.predictedOutcome} to ${upperEvaluation.predictedOutcome}`
                  : `simulation-backed draw-debt threshold changes the next eligible Ajna move from ${baselinePrediction.predictedOutcome} to ${upperEvaluation.predictedOutcome}`
            };
            if (lookaheadUpdates > 1) {
              candidate.planningRateBps = upperEvaluation.terminalRateBps;
              candidate.planningLookaheadUpdates = lookaheadUpdates;
            }
            const finalizedCandidate = finalizeCandidate(candidate);

            if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
              bestCandidate = finalizedCandidate;
            }
          }
        }

        return {
          ...(bestCandidate ? { candidate: bestCandidate } : {}),
          ...(lookaheadUpdates > 1
            ? {
                baselinePlanningRateBps: baselinePath.terminalRateBps,
                planningLookaheadUpdates: lookaheadUpdates
              }
            : {})
        };
      } finally {
        if (preparedSimulationContext) {
          const { testClient } = await getSimulationContext();
          await testClient.stopImpersonatingAccount({
            address: simulationSenderAddress
          });
        }
      }
    }
  );
}

async function synthesizeAjnaLendAndBorrowCandidateViaSimulation(
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    poolAddress: HexAddress;
    rpcUrl: string;
    baselinePrediction?: AjnaRatePrediction;
    anchorBorrowCandidate?: PlanCandidate;
    singleActionCandidates?: PlanCandidate[];
    accountState?: SimulationAccountState;
  }
): Promise<PlanCandidate | undefined> {
  const addQuoteBucketIndexes = resolveAddQuoteBucketIndexes(config);
  if (addQuoteBucketIndexes.length === 0) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? readState.prediction;
  if (distanceToTargetBand(baselinePrediction.predictedNextRateBps, targetBand) === 0) {
    return undefined;
  }
  const simulationSenderAddress =
    options.accountState?.simulationSenderAddress ?? resolveSimulationSenderAddress(config);
  const borrowerAddress =
    options.accountState?.borrowerAddress ??
    resolveSimulationBorrowerAddress(config, simulationSenderAddress);
  const heuristicDualCandidate = synthesizeAjnaLendAndBorrowCandidate(
    readState.rateState,
    config,
    {
      quoteTokenScale: readState.quoteTokenScale,
      nowTimestamp: readState.rateState.nowTimestamp,
      baselinePrediction,
      ...(options.anchorBorrowCandidate === undefined
        ? {}
        : { anchorBorrowCandidate: options.anchorBorrowCandidate })
    }
  );
  const heuristicAnchorBorrowCandidate =
    options.anchorBorrowCandidate ??
    synthesizeAjnaBorrowCandidate(readState.rateState, config, {
      baselinePrediction
    });
  const singleActionAddQuoteSteps = (options.singleActionCandidates ?? [])
    .map((candidate) => extractAddQuoteStep(candidate))
    .filter((step): step is AddQuoteStep => step !== undefined);
  const singleActionDrawDebtSteps = (options.singleActionCandidates ?? [])
    .map((candidate) => extractDrawDebtStep(candidate))
    .filter((step): step is DrawDebtStep => step !== undefined);
  const anchorDrawDebtStep = extractDrawDebtStep(heuristicAnchorBorrowCandidate);
  const anchorDualDrawDebtStep = extractDrawDebtStep(heuristicDualCandidate);
  const anchorDualAddQuoteStep = extractAddQuoteStep(heuristicDualCandidate);
  const exactDualBucketIndexes = Array.from(
    new Set(
      [
        anchorDualAddQuoteStep?.bucketIndex,
        ...singleActionAddQuoteSteps.map((step) => step.bucketIndex),
        ...addQuoteBucketIndexes
      ].filter((bucketIndex): bucketIndex is number => bucketIndex !== undefined)
    )
  ).slice(0, EXACT_DUAL_MAX_BUCKETS);
  const lookaheadUpdates =
    heuristicAnchorBorrowCandidate?.planningLookaheadUpdates ??
    resolveBorrowSimulationLookaheadUpdates(config);
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const maxBorrowAmount = config.maxBorrowExposure;
  const initialLastInterestRateUpdateTimestamp =
    readState.rateState.lastInterestRateUpdateTimestamp;
  if (minimumAmount > maxBorrowAmount) {
    return undefined;
  }

  return withTemporaryAnvilFork(
    {
      rpcUrl: options.rpcUrl,
      chainId: config.chainId,
      blockNumber: readState.blockNumber
    },
    async ({ publicClient, testClient, walletClient }) => {
      await testClient.impersonateAccount({
        address: simulationSenderAddress
      });
      await testClient.setBalance({
        address: simulationSenderAddress,
        value: 10n ** 24n
      });

      try {
        const effectiveAccountState =
          options.accountState ??
          (await (async (): Promise<SimulationAccountState> => {
            const [
              quoteTokenBalance,
              quoteTokenAllowance,
              collateralBalance,
              collateralAllowance
            ] = await Promise.all([
              publicClient.readContract({
                address: readState.quoteTokenAddress,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [simulationSenderAddress]
              }),
              publicClient.readContract({
                address: readState.quoteTokenAddress,
                abi: erc20Abi,
                functionName: "allowance",
                args: [simulationSenderAddress, options.poolAddress]
              }),
              publicClient.readContract({
                address: readState.collateralAddress,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [simulationSenderAddress]
              }),
              publicClient.readContract({
                address: readState.collateralAddress,
                abi: erc20Abi,
                functionName: "allowance",
                args: [simulationSenderAddress, options.poolAddress]
              })
            ]);

            return {
              simulationSenderAddress,
              borrowerAddress,
              quoteTokenBalance,
              quoteTokenAllowance,
              collateralBalance,
              collateralAllowance
            };
          })());

        const maxAvailableQuote = smallestBigInt(
          config.maxQuoteTokenExposure,
          effectiveAccountState.quoteTokenBalance ?? 0n,
          effectiveAccountState.quoteTokenAllowance ?? 0n
        );
        if (minimumAmount > maxAvailableQuote) {
          return undefined;
        }
        const maxAvailableCollateral = smallestBigInt(
          effectiveAccountState.collateralBalance ?? 0n,
          effectiveAccountState.collateralAllowance ?? 0n
        );
        const candidateCollateralAmounts = resolveDrawDebtCollateralAmounts(config).filter(
          (collateralAmount) => collateralAmount <= maxAvailableCollateral
        );
        if (candidateCollateralAmounts.length === 0) {
          return undefined;
        }

        async function simulatePath(
          actions:
            | {
                addQuoteAmount?: bigint;
                addQuoteBucketIndex?: number;
                drawDebtAmount?: bigint;
                limitIndex?: number;
                collateralAmount?: bigint;
                expiry?: number;
              }
            | null
        ): Promise<DualSimulationPathResult> {
          const snapshotId = await testClient.snapshot();

          try {
            let firstRateWadAfterNextUpdate = readState.rateState.currentRateWad;
            let firstOutcome: RateMoveOutcome = "NO_CHANGE";
            let terminalRateWad = readState.rateState.currentRateWad;
            let completedLookaheadUpdates = 0;

            const maybeCaptureObservedUpdate = (stateAfterAction: AjnaPoolStateRead): void => {
              terminalRateWad = stateAfterAction.rateState.currentRateWad;
              if (
                completedLookaheadUpdates > 0 ||
                stateAfterAction.rateState.lastInterestRateUpdateTimestamp ===
                  initialLastInterestRateUpdateTimestamp
              ) {
                return;
              }

              completedLookaheadUpdates = 1;
              firstRateWadAfterNextUpdate = stateAfterAction.rateState.currentRateWad;
              firstOutcome = deriveRateMoveOutcome(
                readState.rateState.currentRateWad,
                firstRateWadAfterNextUpdate
              );
            };

            if (actions?.addQuoteAmount !== undefined && actions.addQuoteAmount > 0n) {
              if (actions.addQuoteBucketIndex === undefined) {
                throw new Error("dual-side simulation requires an addQuote bucket index");
              }
              const addQuoteHash = await walletClient.writeContract({
                account: simulationSenderAddress,
                chain: undefined,
                address: options.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "addQuoteToken",
                args: [
                  actions.addQuoteAmount,
                  BigInt(actions.addQuoteBucketIndex),
                  BigInt(actions.expiry ?? readState.rateState.nowTimestamp)
                ]
              });
              const addQuoteReceipt = await publicClient.waitForTransactionReceipt({
                hash: addQuoteHash
              });
              if (addQuoteReceipt.status !== "success") {
                throw new Error("addQuoteToken simulation reverted");
              }

              const postAddQuoteReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              maybeCaptureObservedUpdate(postAddQuoteReadState);
            }

            if (actions?.drawDebtAmount !== undefined && actions.drawDebtAmount > 0n) {
              if (actions.limitIndex === undefined) {
                throw new Error("dual-side simulation requires a drawDebt limit index");
              }
              const drawDebtHash = await walletClient.writeContract({
                account: simulationSenderAddress,
                chain: undefined,
                address: options.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "drawDebt",
                args: [
                  borrowerAddress,
                  actions.drawDebtAmount,
                  BigInt(actions.limitIndex),
                  actions.collateralAmount ?? 0n
                ]
              });
              const drawDebtReceipt = await publicClient.waitForTransactionReceipt({
                hash: drawDebtHash
              });
              if (drawDebtReceipt.status !== "success") {
                throw new Error("drawDebt simulation reverted");
              }

              const postDrawDebtReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              maybeCaptureObservedUpdate(postDrawDebtReadState);
            }

            for (; completedLookaheadUpdates < lookaheadUpdates; completedLookaheadUpdates += 1) {
              let simulatedReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              if (simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate > 0) {
                await testClient.increaseTime({
                  seconds: simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate
                });
                await testClient.mine({
                  blocks: 1
                });
                simulatedReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              }

              const updateHash = await walletClient.writeContract({
                account: simulationSenderAddress,
                chain: undefined,
                address: options.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "updateInterest",
                args: []
              });
              const updateReceipt = await publicClient.waitForTransactionReceipt({
                hash: updateHash
              });
              if (updateReceipt.status !== "success") {
                throw new Error("updateInterest simulation reverted");
              }

              const postUpdateReadState = await readAjnaPoolState(publicClient, options.poolAddress);
              terminalRateWad = postUpdateReadState.rateState.currentRateWad;

              if (completedLookaheadUpdates === 0) {
                firstRateWadAfterNextUpdate = terminalRateWad;
                firstOutcome = deriveRateMoveOutcome(
                  readState.rateState.currentRateWad,
                  terminalRateWad
                );
              }
            }

            const firstRateBpsAfterNextUpdate = toRateBps(firstRateWadAfterNextUpdate);
            const terminalRateBps = toRateBps(terminalRateWad);

            return {
              firstRateWadAfterNextUpdate,
              firstRateBpsAfterNextUpdate,
              firstOutcome,
              terminalRateBps,
              terminalDistanceToTargetBps: distanceToTargetBand(terminalRateBps, targetBand)
            };
          } finally {
            await testClient.revert({ id: snapshotId });
          }
        }

        const baselinePath = await simulatePath(null);
        const baselineNextDistance = distanceToTargetBand(
          baselinePath.firstRateBpsAfterNextUpdate,
          targetBand
        );
        const singleActionCandidates = options.singleActionCandidates ?? [];
        const bestSingleActionNextDistance = singleActionCandidates.reduce(
          (bestDistance, candidate) =>
            Math.min(
              bestDistance,
              distanceToTargetBand(candidate.predictedRateBpsAfterNextUpdate, targetBand)
            ),
          Number.POSITIVE_INFINITY
        );
        const bestSingleActionTerminalDistance = singleActionCandidates.reduce(
          (bestDistance, candidate) => Math.min(bestDistance, candidate.resultingDistanceToTargetBps),
          Number.POSITIVE_INFINITY
        );
        const comparisonNextDistance = Math.min(
          baselineNextDistance,
          bestSingleActionNextDistance
        );
        const comparisonTerminalDistance = Math.min(
          baselinePath.terminalDistanceToTargetBps,
          bestSingleActionTerminalDistance
        );
        const expiry =
          readState.rateState.nowTimestamp +
          (config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS);

        let bestCandidate: PlanCandidate | undefined;
        interface DualSimulationEvaluation {
          candidatePath: {
            firstRateWadAfterNextUpdate: bigint;
            firstRateBpsAfterNextUpdate: number;
            firstOutcome: RateMoveOutcome;
            terminalRateBps: number;
            terminalDistanceToTargetBps: number;
          };
          nextDistance: number;
        }

        for (const addQuoteBucketIndex of exactDualBucketIndexes) {
          for (const limitIndex of resolveDrawDebtLimitIndexes(config)) {
            for (const collateralAmount of candidateCollateralAmounts) {
              const dualSearchMatch = await searchCoarseToFineDualSpace<DualSimulationEvaluation>({
                minimumQuoteAmount: minimumAmount,
                maximumQuoteAmount: maxAvailableQuote,
                minimumBorrowAmount: minimumAmount,
                maximumBorrowAmount: maxBorrowAmount,
                quoteAnchorAmounts: [
                  anchorDualAddQuoteStep?.bucketIndex === addQuoteBucketIndex
                    ? anchorDualAddQuoteStep.amount
                    : undefined,
                  ...singleActionAddQuoteSteps
                    .filter((step) => step.bucketIndex === addQuoteBucketIndex)
                    .map((step) => step.amount)
                ],
                borrowAnchorAmounts: [
                  anchorDualDrawDebtStep &&
                  anchorDualDrawDebtStep.limitIndex === limitIndex &&
                  (anchorDualDrawDebtStep.collateralAmount ?? 0n) === collateralAmount
                    ? anchorDualDrawDebtStep.amount
                    : undefined,
                  anchorDrawDebtStep &&
                  anchorDrawDebtStep.limitIndex === limitIndex &&
                  (anchorDrawDebtStep.collateralAmount ?? 0n) === collateralAmount
                    ? anchorDrawDebtStep.amount
                    : undefined,
                  ...singleActionDrawDebtSteps
                    .filter(
                      (step) =>
                        step.limitIndex === limitIndex &&
                        (step.collateralAmount ?? 0n) === collateralAmount
                    )
                    .map((step) => step.amount)
                ],
                evaluate: async ({ quoteAmount, drawDebtAmount }) => {
                  try {
                    const candidatePath = await simulatePath({
                      addQuoteAmount: quoteAmount,
                      addQuoteBucketIndex,
                      drawDebtAmount,
                      limitIndex,
                      collateralAmount,
                      expiry
                    });
                    const nextDistance = distanceToTargetBand(
                      candidatePath.firstRateBpsAfterNextUpdate,
                      targetBand
                    );
                    const candidatePrediction: AjnaRatePrediction = {
                      predictedOutcome: candidatePath.firstOutcome,
                      predictedNextRateWad: candidatePath.firstRateWadAfterNextUpdate,
                      predictedNextRateBps: candidatePath.firstRateBpsAfterNextUpdate,
                      secondsUntilNextRateUpdate: 0
                    };

                    const improvesConvergence =
                      ((nextDistance < comparisonNextDistance &&
                        candidatePath.terminalDistanceToTargetBps <=
                          comparisonTerminalDistance) ||
                        (candidatePath.terminalDistanceToTargetBps <
                          comparisonTerminalDistance &&
                          nextDistance <= comparisonNextDistance)) &&
                      (lookaheadUpdates > 1 ||
                        nextDistance < comparisonNextDistance ||
                        predictionChanged(baselinePrediction, candidatePrediction));

                    if (!improvesConvergence) {
                      return undefined;
                    }

                    return {
                      candidatePath,
                      nextDistance
                    };
                  } catch {
                    return undefined;
                  }
                },
                isImprovement: () => true,
                maxQuoteSamples: EXACT_DUAL_MAX_QUOTE_SAMPLES,
                maxBorrowSamples: EXACT_DUAL_MAX_BORROW_SAMPLES,
                maxPromisingBasins: EXACT_DUAL_MAX_PROMISING_BASINS,
                compareMatches: (left, right) => {
                  const leftCandidate: PlanCandidate = {
                    id: `compare-dual:${addQuoteBucketIndex}:${limitIndex}:${collateralAmount.toString()}:add-quote:${left.quoteAmount.toString()}:draw-debt:${left.drawDebtAmount.toString()}`,
                    intent: "LEND_AND_BORROW",
                    minimumExecutionSteps: [
                      {
                        type: "ADD_QUOTE",
                        amount: left.quoteAmount,
                        bucketIndex: addQuoteBucketIndex,
                        expiry
                      },
                      {
                        type: "DRAW_DEBT",
                        amount: left.drawDebtAmount,
                        limitIndex,
                        collateralAmount
                      }
                    ],
                    predictedOutcome: left.evaluation.candidatePath.firstOutcome,
                    predictedRateBpsAfterNextUpdate:
                      left.evaluation.candidatePath.firstRateBpsAfterNextUpdate,
                    resultingDistanceToTargetBps:
                      left.evaluation.candidatePath.terminalDistanceToTargetBps,
                    quoteTokenDelta: left.quoteAmount + left.drawDebtAmount,
                    explanation: ""
                  };
                  const rightCandidate: PlanCandidate = {
                    id: `compare-dual:${addQuoteBucketIndex}:${limitIndex}:${collateralAmount.toString()}:add-quote:${right.quoteAmount.toString()}:draw-debt:${right.drawDebtAmount.toString()}`,
                    intent: "LEND_AND_BORROW",
                    minimumExecutionSteps: [
                      {
                        type: "ADD_QUOTE",
                        amount: right.quoteAmount,
                        bucketIndex: addQuoteBucketIndex,
                        expiry
                      },
                      {
                        type: "DRAW_DEBT",
                        amount: right.drawDebtAmount,
                        limitIndex,
                        collateralAmount
                      }
                    ],
                    predictedOutcome: right.evaluation.candidatePath.firstOutcome,
                    predictedRateBpsAfterNextUpdate:
                      right.evaluation.candidatePath.firstRateBpsAfterNextUpdate,
                    resultingDistanceToTargetBps:
                      right.evaluation.candidatePath.terminalDistanceToTargetBps,
                    quoteTokenDelta: right.quoteAmount + right.drawDebtAmount,
                    explanation: ""
                  };

                  return compareCandidatePreference(
                    finalizeCandidate(leftCandidate),
                    finalizeCandidate(rightCandidate)
                  );
                }
              });

              if (!dualSearchMatch) {
                continue;
              }

              const candidate: PlanCandidate = {
                id: `sim-dual:${addQuoteBucketIndex}:${limitIndex}:${collateralAmount.toString()}:add-quote:${dualSearchMatch.quoteAmount.toString()}:draw-debt:${dualSearchMatch.drawDebtAmount.toString()}`,
                intent: "LEND_AND_BORROW",
                minimumExecutionSteps: [
                  {
                    type: "ADD_QUOTE",
                    amount: dualSearchMatch.quoteAmount,
                    bucketIndex: addQuoteBucketIndex,
                    expiry,
                    note: "simulation-backed add-quote threshold for dual-side steering"
                  },
                  {
                    type: "DRAW_DEBT",
                    amount: dualSearchMatch.drawDebtAmount,
                    limitIndex,
                    collateralAmount,
                    note: "simulation-backed draw-debt threshold for dual-side steering"
                  }
                ],
                predictedOutcome: dualSearchMatch.evaluation.candidatePath.firstOutcome,
                predictedRateBpsAfterNextUpdate:
                  dualSearchMatch.evaluation.candidatePath.firstRateBpsAfterNextUpdate,
                resultingDistanceToTargetBps:
                  dualSearchMatch.evaluation.candidatePath.terminalDistanceToTargetBps,
                quoteTokenDelta:
                  dualSearchMatch.quoteAmount + dualSearchMatch.drawDebtAmount,
                explanation:
                  lookaheadUpdates > 1
                    ? `simulation-backed add-quote + draw-debt path improves the ${lookaheadUpdates}-update path beyond the best single-action path`
                    : `simulation-backed add-quote + draw-debt path improves the next eligible move beyond the best single-action path`
              };

              if (lookaheadUpdates > 1) {
                candidate.planningRateBps =
                  dualSearchMatch.evaluation.candidatePath.terminalRateBps;
                candidate.planningLookaheadUpdates = lookaheadUpdates;
              }
              const finalizedCandidate = finalizeCandidate(candidate);

              if (!bestCandidate || compareCandidatePreference(finalizedCandidate, bestCandidate) < 0) {
                bestCandidate = finalizedCandidate;
              }
            }
          }
        }

        return bestCandidate;
      } finally {
        await testClient.stopImpersonatingAccount({
          address: simulationSenderAddress
        });
      }
    }
  );
}

export interface AjnaSnapshotSourceDependencies {
  publicClient?: PublicClient;
  now?: () => number;
}

function assertLiveReadConfig(config: KeeperConfig): {
  poolAddress: `0x${string}`;
  rpcUrl: string;
} {
  if (!config.poolAddress) {
    throw new Error("live Ajna snapshot source requires config.poolAddress");
  }

  if (!config.rpcUrl) {
    throw new Error("live Ajna snapshot source requires config.rpcUrl");
  }

  return {
    poolAddress: config.poolAddress,
    rpcUrl: config.rpcUrl
  };
}

export class AjnaRpcSnapshotSource implements SnapshotSource {
  private readonly poolAddress: `0x${string}`;
  private readonly publicClient: PublicClient;
  private readonly now: () => number;

  constructor(
    private readonly config: KeeperConfig,
    dependencies: AjnaSnapshotSourceDependencies = {}
  ) {
    const runtime = assertLiveReadConfig(config);

    this.poolAddress = runtime.poolAddress;
    this.publicClient =
      dependencies.publicClient ??
      createPublicClient({
        transport: http(runtime.rpcUrl)
      });
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async getSnapshot(): Promise<PoolSnapshot> {
    const synthesisPolicy = resolveAjnaSynthesisPolicy(this.config);
    const baseSynthesisConfig: KeeperConfig = {
      ...this.config,
      enableSimulationBackedLendSynthesis: synthesisPolicy.simulationLend,
      enableSimulationBackedBorrowSynthesis: synthesisPolicy.simulationBorrow,
      enableHeuristicLendSynthesis: synthesisPolicy.heuristicLend,
      enableHeuristicBorrowSynthesis: synthesisPolicy.heuristicBorrow
    };
    const readState = await readAjnaPoolState(
      this.publicClient,
      this.poolAddress,
      this.now(),
      undefined,
      baseSynthesisConfig.borrowerAddress
    );
    const derivedPreWindowBucketIndexes = resolvePreWindowLendBucketIndexes(
      readState,
      baseSynthesisConfig
    );
    const synthesisConfig: KeeperConfig =
      derivedPreWindowBucketIndexes.length === 0
        ? baseSynthesisConfig
        : {
            ...baseSynthesisConfig,
            addQuoteBucketIndexes: derivedPreWindowBucketIndexes
          };
    const snapshotFingerprint = buildSnapshotFingerprint(
      this.poolAddress,
      readState.blockNumber,
      readState.rateState
    );

    const autoCandidates: PlanCandidate[] = [];
    let autoCandidateSource: "simulation" | "heuristic" | undefined;
    let planningRateBps: number | undefined;
    let planningLookaheadUpdates: number | undefined;

    if (
      synthesisPolicy.simulationLend ||
      synthesisPolicy.simulationBorrow
    ) {
      const rpcUrl = assertLiveReadConfig(synthesisConfig).rpcUrl;
      const simulationAccountState = await readSimulationAccountState(
        this.publicClient,
        this.poolAddress,
        readState,
        synthesisConfig,
        {
          needsQuoteState: synthesisPolicy.simulationLend,
          needsCollateralState: synthesisPolicy.simulationBorrow
        }
      );
      const simulationCacheKey = buildSimulationCandidateCacheKey(
        snapshotFingerprint,
        synthesisConfig,
        simulationAccountState
      );

      if (!simulationCandidateCache.has(simulationCacheKey)) {
        const synthesizedCandidates: PlanCandidate[] = [];
        let lendCandidate: PlanCandidate | undefined;
        let borrowCandidate: PlanCandidate | undefined;

        if (synthesisPolicy.simulationLend) {
          const lendResult = await synthesizeAjnaLendCandidateViaSimulation(
            readState,
            synthesisConfig,
            {
              poolAddress: this.poolAddress,
              rpcUrl,
              baselinePrediction: readState.prediction,
              accountState: simulationAccountState
            }
          );
          lendCandidate = lendResult?.candidate;
          if (lendCandidate) {
            synthesizedCandidates.push(lendCandidate);
          }
          if (lendResult?.baselinePlanningRateBps !== undefined && planningRateBps === undefined) {
            planningRateBps = lendResult.baselinePlanningRateBps;
            planningLookaheadUpdates = lendResult.planningLookaheadUpdates;
          }
        }

        if (synthesisPolicy.simulationBorrow) {
          let borrowResult: BorrowSimulationSynthesisResult | undefined;
          for (const lookaheadUpdates of resolveBorrowSimulationLookaheadAttempts(
            synthesisConfig
          )) {
            const borrowConfig =
              synthesisConfig.borrowSimulationLookaheadUpdates === lookaheadUpdates
                ? synthesisConfig
                : {
                    ...synthesisConfig,
                    borrowSimulationLookaheadUpdates: lookaheadUpdates
                  };
            borrowResult = await synthesizeAjnaBorrowCandidateViaSimulation(
              readState,
              borrowConfig,
              {
                poolAddress: this.poolAddress,
                rpcUrl,
                baselinePrediction: readState.prediction,
                accountState: simulationAccountState
              }
            );
            if (borrowResult?.candidate) {
              break;
            }
          }

          borrowCandidate = borrowResult?.candidate;
          if (borrowCandidate) {
            synthesizedCandidates.push(borrowCandidate);
          }
          if (borrowResult?.baselinePlanningRateBps !== undefined) {
            planningRateBps = borrowResult.baselinePlanningRateBps;
            planningLookaheadUpdates = borrowResult.planningLookaheadUpdates;
          }

          if (
            synthesisPolicy.simulationLend &&
            (borrowResult?.planningLookaheadUpdates === undefined ||
              borrowResult.planningLookaheadUpdates <= 1)
          ) {
            const dualCandidate = await synthesizeAjnaLendAndBorrowCandidateViaSimulation(
              readState,
              synthesisConfig,
              {
                poolAddress: this.poolAddress,
                rpcUrl,
                baselinePrediction: readState.prediction,
                accountState: simulationAccountState,
                ...(borrowCandidate === undefined
                  ? {}
                  : { anchorBorrowCandidate: borrowCandidate }),
                singleActionCandidates: [lendCandidate, borrowCandidate].filter(
                  (candidate): candidate is PlanCandidate => candidate !== undefined
                )
              }
            );
            if (dualCandidate) {
              synthesizedCandidates.push(dualCandidate);
            }
          }
        }

        setBoundedCacheEntry(simulationCandidateCache, simulationCacheKey, {
          candidates: synthesizedCandidates,
          ...(planningRateBps === undefined ? {} : { planningRateBps }),
          ...(planningLookaheadUpdates === undefined
            ? {}
            : { planningLookaheadUpdates })
        }, MAX_SIMULATION_CANDIDATE_CACHE_ENTRIES);
      }

      const cachedSimulation = simulationCandidateCache.get(simulationCacheKey);
      if (cachedSimulation?.planningRateBps !== undefined) {
        planningRateBps = cachedSimulation.planningRateBps;
      }
      if (cachedSimulation?.planningLookaheadUpdates !== undefined) {
        planningLookaheadUpdates = cachedSimulation.planningLookaheadUpdates;
      }

      const cachedCandidates = cachedSimulation?.candidates ?? [];
      if (cachedCandidates.length > 0) {
        autoCandidates.push(...cachedCandidates);
        autoCandidateSource = "simulation";
      }
    }

    if (
      autoCandidates.length === 0 &&
      (synthesisPolicy.heuristicLend || synthesisPolicy.heuristicBorrow)
    ) {
      const heuristicCandidates = synthesizeAjnaHeuristicCandidates(
        readState.rateState,
        synthesisConfig,
        {
          quoteTokenScale: readState.quoteTokenScale,
          nowTimestamp: readState.rateState.nowTimestamp,
          baselinePrediction: readState.prediction,
          allowPreWindowLend: readState.immediatePrediction.secondsUntilNextRateUpdate <= 0
        }
      );
      if (heuristicCandidates.length > 0) {
        autoCandidates.push(...heuristicCandidates);
        autoCandidateSource = "heuristic";
      }
    }

    const manualCandidates = await enrichManualCandidatesForSnapshot(
      this.publicClient,
      this.poolAddress,
      readState,
      synthesisConfig.manualCandidates ?? []
    );

    return buildPoolSnapshot(
      synthesisConfig.poolId,
      synthesisConfig.chainId,
      this.poolAddress,
      readState,
      autoCandidates,
      manualCandidates,
      autoCandidateSource,
      {
        ...(planningRateBps === undefined ? {} : { rateBps: planningRateBps }),
        ...(planningLookaheadUpdates === undefined
          ? {}
          : { lookaheadUpdates: planningLookaheadUpdates })
      }
    );
  }
}

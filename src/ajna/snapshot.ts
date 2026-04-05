import {
  createPublicClient,
  http,
  keccak256,
  stringToHex,
  type Hex,
  type PublicClient
} from "viem";

import { ajnaPoolAbi, erc20Abi } from "./abi.js";
import { withLazyTemporaryAnvilFork, withTemporaryAnvilFork } from "./anvil-fork.js";
import {
  type AjnaRatePrediction,
  type AjnaRateState,
  RESET_RATE_WAD,
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate,
  toRateBps,
} from "./rate-state.js";
import { resolveAjnaSignerAddress } from "./runtime.js";
import {
  type ScalarSearchMatch,
  buildAnchoredSearchAmounts,
  buildExposureFractionAnchorAmounts,
  buildMultiCycleLendSearchAmounts,
  buildPreWindowBorrowSearchAmounts,
  buildSameCycleBorrowSearchAmounts,
  buildTokenScaleAnchorAmounts,
  compareCandidatePreference,
  compressCapitalAwareSearchAmounts,
  deriveMeaningfulDepositThresholdFenwickIndex,
  resolveAddQuoteBucketIndexes,
  resolveDrawDebtCollateralAmounts,
  resolveDrawDebtLimitIndexes,
  resolvePoolAwareBorrowLimitIndexes,
  resolvePreWindowLendBucketIndexes,
  resolveSimulationBorrowCollateralAmounts,
  resolveTimedBorrowSimulationLookaheadAttempts,
  searchCoarseToFineDualSpace
} from "./search-space.js";
import { withPlanCandidateCapitalMetrics } from "../candidate-metrics.js";
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

export {
  type AjnaRatePrediction,
  type AjnaRateState,
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate,
  hasUninitializedAjnaEmaState
} from "./rate-state.js";
export {
  resolveSimulationBorrowCollateralAmounts,
  resolveSimulationBorrowLimitIndexes,
  resolveBorrowSimulationLookaheadAttempts,
  resolveTimedBorrowSimulationLookaheadAttempts,
  searchCoarseToFineDualSpace
} from "./search-space.js";

const DEFAULT_ADD_QUOTE_EXPIRY_SECONDS = 60 * 60;
const EXACT_DUAL_MAX_BUCKETS = 3;
const EXACT_DUAL_MAX_QUOTE_SAMPLES = 6;
const EXACT_DUAL_MAX_BORROW_SAMPLES = 6;
const EXACT_DUAL_MAX_PROMISING_BASINS = 3;
const MAX_SIMULATION_ACCOUNT_STATE_CACHE_ENTRIES = 256;
const MAX_EXACT_SIMULATION_PATH_CACHE_ENTRIES = 20_000;
const MAX_SIMULATION_CANDIDATE_CACHE_ENTRIES = 2_048;
const EXACT_MULTI_CYCLE_LEND_MAX_QUOTE_SAMPLES = 12;
const EXACT_MULTI_CYCLE_LEND_LOW_END_QUOTE_SAMPLES = 8;
const EXACT_SAME_CYCLE_BORROW_MAX_LIMIT_INDEXES = 2;
const EXACT_SAME_CYCLE_BORROW_MAX_COLLATERAL_SAMPLES = 4;
const EXACT_PREWINDOW_BORROW_MAX_LIMIT_INDEXES = 6;
const EXACT_PREWINDOW_BORROW_MAX_COLLATERAL_SAMPLES = 8;

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

type BorrowSimulationPathResult = LendSimulationPathResult;

type DualSimulationPathResult = BorrowSimulationPathResult;

interface CachedSimulationCandidates {
  candidates: PlanCandidate[];
  planningRateBps?: number;
  planningLookaheadUpdates?: number;
}

interface SimulationExecutionCompatibility {
  simulationSenderAddress?: HexAddress;
  liveSignerAddress?: HexAddress;
  executionCompatible?: boolean;
  reason?: string;
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
    config.minExecutableQuoteTokenAmount,
    config.minExecutableBorrowAmount,
    config.minExecutableCollateralAmount,
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

function resolveMinimumQuoteActionAmount(config: KeeperConfig): bigint {
  return config.minExecutableQuoteTokenAmount > 0n ? config.minExecutableQuoteTokenAmount : 1n;
}

function resolveMinimumBorrowActionAmount(config: KeeperConfig): bigint {
  return config.minExecutableBorrowAmount > 0n ? config.minExecutableBorrowAmount : 1n;
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

  return resolveAjnaSignerAddress(env) !== undefined;
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

export function resolveSimulationExecutionCompatibility(
  config: KeeperConfig,
  env: NodeJS.ProcessEnv = process.env
): SimulationExecutionCompatibility {
  const simulationSenderAddress =
    config.simulationSenderAddress ?? resolveAjnaSignerAddress(env);
  const liveSignerAddress = resolveAjnaSignerAddress(env);

  if (!simulationSenderAddress || !liveSignerAddress) {
    return {
      ...(simulationSenderAddress === undefined ? {} : { simulationSenderAddress }),
      ...(liveSignerAddress === undefined ? {} : { liveSignerAddress })
    };
  }

  if (simulationSenderAddress.toLowerCase() !== liveSignerAddress.toLowerCase()) {
    return {
      simulationSenderAddress,
      liveSignerAddress,
      executionCompatible: false,
      reason:
        "simulation-backed synthesis used a different sender than the live execution signer"
    };
  }

  return {
    simulationSenderAddress,
    liveSignerAddress,
    executionCompatible: true
  };
}

function smallestBigInt(...values: bigint[]): bigint {
  if (values.length === 0) {
    throw new Error("smallestBigInt requires at least one value");
  }

  return values.reduce((smallest, value) => (value < smallest ? value : smallest));
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

function finalizeCandidate(candidate: PlanCandidate): PlanCandidate {
  return withPlanCandidateCapitalMetrics(candidate);
}

function withCandidateExecutionMetadata(
  candidate: PlanCandidate,
  fallbackSource?: "simulation" | "heuristic" | "manual"
): PlanCandidate {
  const candidateSource = candidate.candidateSource ?? fallbackSource;
  const executionMode =
    candidate.executionMode ?? (candidateSource === "heuristic" ? "advisory" : "supported");

  return {
    ...candidate,
    ...(candidateSource === undefined ? {} : { candidateSource }),
    executionMode
  };
}

function resolveBorrowSimulationLookaheadUpdates(config: KeeperConfig): number {
  return config.borrowSimulationLookaheadUpdates ?? 1;
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
  },
  diagnostics?: {
    simulationBackedSynthesisEnabled?: boolean;
    simulationPrerequisitesAvailable?: boolean;
    simulationExecutionCompatible?: boolean;
    simulationExecutionCompatibilityReason?: string;
    simulationSenderAddress?: HexAddress;
    liveSignerAddress?: HexAddress;
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
      ...autoCandidates.map((candidate) =>
        structuredClone(
          finalizeCandidate(withCandidateExecutionMetadata(candidate, autoCandidateSource))
        )
      ),
      ...manualCandidates.map((candidate) =>
        structuredClone(finalizeCandidate(withCandidateExecutionMetadata(candidate, "manual")))
      )
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
        : { planningLookaheadUpdates: planning.lookaheadUpdates }),
      ...(diagnostics?.simulationBackedSynthesisEnabled === undefined
        ? {}
        : { simulationBackedSynthesisEnabled: diagnostics.simulationBackedSynthesisEnabled }),
      ...(diagnostics?.simulationPrerequisitesAvailable === undefined
        ? {}
        : { simulationPrerequisitesAvailable: diagnostics.simulationPrerequisitesAvailable }),
      ...(diagnostics?.simulationExecutionCompatible === undefined
        ? {}
        : { simulationExecutionCompatible: diagnostics.simulationExecutionCompatible }),
      ...(diagnostics?.simulationExecutionCompatibilityReason === undefined
        ? {}
        : {
            simulationExecutionCompatibilityReason:
              diagnostics.simulationExecutionCompatibilityReason
          }),
      ...(diagnostics?.simulationSenderAddress === undefined
        ? {}
        : { simulationSenderAddress: diagnostics.simulationSenderAddress }),
      ...(diagnostics?.liveSignerAddress === undefined
        ? {}
        : { liveSignerAddress: diagnostics.liveSignerAddress })
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
  const minimumAmount = resolveMinimumQuoteActionAmount(config);
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

function resolveSimulationSenderAddress(config: KeeperConfig): HexAddress {
  if (config.simulationSenderAddress) {
    return config.simulationSenderAddress;
  }

  const signerAddress = resolveAjnaSignerAddress();
  if (!signerAddress) {
    throw new Error(
      "simulation-backed synthesis requires simulationSenderAddress or AJNA_KEEPER_PRIVATE_KEY/PRIVATE_KEY"
    );
  }

  return signerAddress;
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
  const minimumAmount = resolveMinimumQuoteActionAmount(config);
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
              const fallbackSearchAmounts = Array.from(
                new Set(
                  buildExposureFractionAnchorAmounts(maxAmount, minimumAmount)
                )
              ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

              for (const quoteTokenAmount of fallbackSearchAmounts) {
                if (searchAmounts.includes(quoteTokenAmount)) {
                  continue;
                }

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
  const minimumAmount = resolveMinimumBorrowActionAmount(config);
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
  const minimumQuoteAmount = resolveMinimumQuoteActionAmount(config);
  const minimumBorrowAmount = resolveMinimumBorrowActionAmount(config);
  const maxQuoteAmount = config.maxQuoteTokenExposure;
  const maxBorrowAmount = config.maxBorrowExposure;

  if (minimumQuoteAmount > maxQuoteAmount || minimumBorrowAmount > maxBorrowAmount) {
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
    anchorDrawDebtStep.amount >= minimumBorrowAmount
      ? anchorDrawDebtStep.amount
      : minimumBorrowAmount;
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

  let lowerQuoteAmount = minimumQuoteAmount - 1n;
  let upperQuoteAmount = minimumQuoteAmount;
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
  const minimumAmount = resolveMinimumBorrowActionAmount(config);
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
  const isPreWindowBorrowSearch =
    lookaheadUpdates === 1 && readState.immediatePrediction.secondsUntilNextRateUpdate > 0;
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
        const candidateCollateralAmounts = Array.from(
          new Set(
            [
              ...resolveSimulationBorrowCollateralAmounts(
                config,
                maxAvailableCollateral,
                {
                  borrowerHasExistingPosition:
                    (readState.borrowerState?.t0Debt ?? 0n) > 0n ||
                    (readState.borrowerState?.collateral ?? 0n) > 0n
                }
              ),
              ...(heuristicDrawDebtStep?.collateralAmount === undefined
                ? []
                : [heuristicDrawDebtStep.collateralAmount])
            ].filter((collateralAmount) => collateralAmount <= maxAvailableCollateral)
          )
        ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
        const prioritizedCollateralAmounts =
          lookaheadUpdates === 1
            ? Array.from(
                new Set([
                  ...(heuristicDrawDebtStep?.collateralAmount === undefined
                    ? []
                    : [heuristicDrawDebtStep.collateralAmount]),
                  ...resolveDrawDebtCollateralAmounts(config).filter(
                    (collateralAmount) => collateralAmount <= maxAvailableCollateral
                  ),
                  ...candidateCollateralAmounts.slice(
                    0,
                    isPreWindowBorrowSearch
                      ? EXACT_PREWINDOW_BORROW_MAX_COLLATERAL_SAMPLES
                      : EXACT_SAME_CYCLE_BORROW_MAX_COLLATERAL_SAMPLES
                  )
                ])
              ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
            : candidateCollateralAmounts;
        if (prioritizedCollateralAmounts.length === 0) {
          return undefined;
        }
        const allLimitIndexes = await resolvePoolAwareBorrowLimitIndexes(
          publicClient,
          options.poolAddress,
          readState.blockNumber,
          config
        );
        const prioritizedOneUpdateLimitIndexes = Array.from(
          new Set([
            ...(heuristicDrawDebtStep === undefined ? [] : [heuristicDrawDebtStep.limitIndex]),
            ...resolveDrawDebtLimitIndexes(config),
            ...allLimitIndexes
          ])
        );
        const limitIndexes =
          lookaheadUpdates === 1
            ? prioritizedOneUpdateLimitIndexes.slice(
                0,
                isPreWindowBorrowSearch
                  ? EXACT_PREWINDOW_BORROW_MAX_LIMIT_INDEXES
                  : EXACT_SAME_CYCLE_BORROW_MAX_LIMIT_INDEXES
              )
            : allLimitIndexes;
        if (limitIndexes.length === 0) {
          return undefined;
        }
        const exactBorrowSearchInputs = prioritizedCollateralAmounts.map((collateralAmount) => {
          const heuristicCollateralAmount = heuristicDrawDebtStep?.collateralAmount ?? 0n;
          const heuristicThresholdAmount =
            heuristicDrawDebtStep?.amount !== undefined &&
            heuristicCollateralAmount === collateralAmount
              ? heuristicDrawDebtStep.amount
              : undefined;

          return {
            collateralAmount,
            pureThresholdAmount:
              lookaheadUpdates === 1
                ? findPureBorrowImprovementThresholdForCollateral(
                    readState.rateState,
                    targetBand,
                    baselinePrediction,
                    minimumAmount,
                    maxAmount,
                    collateralAmount
                  )
                : undefined,
            heuristicThresholdAmount
          };
        });
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
            pureThresholdAmount,
            heuristicThresholdAmount
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

            const searchAmounts =
              lookaheadUpdates === 1
                ? isPreWindowBorrowSearch
                  ? buildPreWindowBorrowSearchAmounts(
                      minimumAmount,
                      maxAmount,
                      readState.quoteTokenScale,
                      [pureThresholdAmount, heuristicThresholdAmount]
                    )
                  : buildSameCycleBorrowSearchAmounts(
                      minimumAmount,
                      maxAmount,
                      readState.quoteTokenScale,
                      [pureThresholdAmount, heuristicThresholdAmount]
                    )
                : buildAnchoredSearchAmounts(
                    minimumAmount,
                    maxAmount,
                    [pureThresholdAmount, heuristicThresholdAmount]
                  );

            let lowerBound = minimumAmount - 1n;
            let upperBound: bigint | undefined;
            let upperEvaluation:
              | {
                  predictedOutcome: RateMoveOutcome;
                  predictedRateBpsAfterNextUpdate: number;
                  terminalRateBps: number;
                  terminalDistanceToTargetBps: number;
                  improvesConvergence: boolean;
                }
              | undefined;

            for (const drawDebtAmount of searchAmounts) {
              const evaluation = await evaluate(drawDebtAmount);
              if (evaluation.improvesConvergence) {
                upperBound = drawDebtAmount;
                upperEvaluation = evaluation;
                break;
              }

              lowerBound = drawDebtAmount;
            }

            if (upperBound === undefined || !upperEvaluation?.improvesConvergence) {
              continue;
            }

            let refinedUpperBound = upperBound;
            let refinedUpperEvaluation = upperEvaluation;

            while (refinedUpperBound - lowerBound > 1n) {
              const middle = lowerBound + (refinedUpperBound - lowerBound) / 2n;
              const middleEvaluation = await evaluate(middle);
              if (middleEvaluation.improvesConvergence) {
                refinedUpperBound = middle;
                refinedUpperEvaluation = middleEvaluation;
              } else {
                lowerBound = middle;
              }
            }

            const candidate: PlanCandidate = {
              id: `sim-borrow:${limitIndex}:${collateralAmount.toString()}:draw-debt:${refinedUpperBound.toString()}`,
              intent: "BORROW",
              minimumExecutionSteps: [
                {
                  type: "DRAW_DEBT",
                  amount: refinedUpperBound,
                  limitIndex,
                  collateralAmount,
                  note: isPreWindowBorrowSearch
                    ? "simulation-backed pre-window draw-debt threshold"
                    : "simulation-backed draw-debt threshold"
                }
              ],
              predictedOutcome: refinedUpperEvaluation.predictedOutcome,
              predictedRateBpsAfterNextUpdate:
                refinedUpperEvaluation.predictedRateBpsAfterNextUpdate,
              resultingDistanceToTargetBps:
                refinedUpperEvaluation.terminalDistanceToTargetBps,
              quoteTokenDelta: refinedUpperBound,
              explanation:
                lookaheadUpdates > 1
                  ? `simulation-backed draw-debt threshold improves the ${lookaheadUpdates}-update path from ${baselinePrediction.predictedOutcome} to ${refinedUpperEvaluation.predictedOutcome}`
                  : isPreWindowBorrowSearch
                    ? `simulation-backed pre-window draw-debt threshold improves the next eligible Ajna move from ${baselinePrediction.predictedOutcome} to ${refinedUpperEvaluation.predictedOutcome}`
                    : `simulation-backed draw-debt threshold changes the next eligible Ajna move from ${baselinePrediction.predictedOutcome} to ${refinedUpperEvaluation.predictedOutcome}`
            };
            if (lookaheadUpdates > 1) {
              candidate.planningRateBps = refinedUpperEvaluation.terminalRateBps;
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
  const minimumQuoteAmount = resolveMinimumQuoteActionAmount(config);
  const minimumBorrowAmount = resolveMinimumBorrowActionAmount(config);
  const maxBorrowAmount = config.maxBorrowExposure;
  const initialLastInterestRateUpdateTimestamp =
    readState.rateState.lastInterestRateUpdateTimestamp;
  if (minimumBorrowAmount > maxBorrowAmount) {
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
          if (minimumQuoteAmount > maxAvailableQuote) {
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
                minimumQuoteAmount,
                maximumQuoteAmount: maxAvailableQuote,
                minimumBorrowAmount,
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
    const simulationExecutionCompatibility = resolveSimulationExecutionCompatibility(
      this.config
    );
    const simulationPrerequisitesAvailable = hasResolvableSimulationSenderAddress(this.config);
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
          for (const lookaheadUpdates of resolveTimedBorrowSimulationLookaheadAttempts(
            synthesisConfig,
            readState.immediatePrediction.secondsUntilNextRateUpdate,
            readState.rateState
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
        autoCandidates.push(
          ...cachedCandidates.map((candidate) =>
            simulationExecutionCompatibility.executionCompatible === false
              ? {
                  ...candidate,
                  executionMode: "unsupported" as const
                }
              : candidate
          )
        );
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
      },
      {
        simulationBackedSynthesisEnabled:
          synthesisPolicy.simulationLend || synthesisPolicy.simulationBorrow,
        simulationPrerequisitesAvailable,
        ...(simulationExecutionCompatibility.executionCompatible === undefined
          ? {}
          : {
              simulationExecutionCompatible:
                simulationExecutionCompatibility.executionCompatible
            }),
        ...(simulationExecutionCompatibility.reason === undefined
          ? {}
          : {
              simulationExecutionCompatibilityReason:
                simulationExecutionCompatibility.reason
            }),
        ...(simulationExecutionCompatibility.simulationSenderAddress === undefined
          ? {}
          : {
              simulationSenderAddress:
                simulationExecutionCompatibility.simulationSenderAddress
            }),
        ...(simulationExecutionCompatibility.liveSignerAddress === undefined
          ? {}
          : { liveSignerAddress: simulationExecutionCompatibility.liveSignerAddress })
      }
    );
  }
}

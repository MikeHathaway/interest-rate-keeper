import {
  createPublicClient,
  http,
  keccak256,
  stringToHex,
  type PublicClient
} from "viem";

import { ajnaPoolAbi } from "./abi.js";
import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import { type SnapshotSource } from "../snapshot.js";
import {
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

export function classifyAjnaNextRate(state: AjnaRateState): AjnaRatePrediction {
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

  if (secondsUntilNextRateUpdate > 0) {
    return {
      predictedOutcome: "NO_CHANGE",
      predictedNextRateWad: state.currentRateWad,
      predictedNextRateBps: toRateBps(state.currentRateWad),
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

  if (
    4n * (tu - mau102) <
    squareWithProtocolScaling(tu + mau102 - WAD) - WAD
  ) {
    nextRateWad = clampRate(wmul(state.currentRateWad, INCREASE_COEFFICIENT_WAD));
  } else if (
    4n * (tu - mau) >
    WAD - squareWithProtocolScaling(tu + mau - WAD)
  ) {
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

export function synthesizeAjnaLendCandidate(
  state: AjnaRateState,
  config: KeeperConfig,
  options: {
    quoteTokenScale: bigint;
    nowTimestamp: number;
    baselinePrediction?: AjnaRatePrediction;
  }
): PlanCandidate | undefined {
  if (config.addQuoteBucketIndex === undefined || options.quoteTokenScale <= 0n) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const currentRateBps = toRateBps(state.currentRateWad);
  if (currentRateBps <= targetBand.maxRateBps) {
    return undefined;
  }

  const baselinePrediction = options.baselinePrediction ?? classifyAjnaNextRate(state);
  const currentDistance = distanceToTargetBand(currentRateBps, targetBand);
  const minimumAmount = config.minExecutableActionQuoteToken > 0n
    ? config.minExecutableActionQuoteToken
    : 1n;
  const maxAmount = config.maxQuoteTokenExposure;

  if (minimumAmount > maxAmount) {
    return undefined;
  }

  function evaluate(quoteTokenAmount: bigint): {
    prediction: AjnaRatePrediction;
    improvesConvergence: boolean;
  } {
    const prediction = classifyAjnaNextRate(
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
        predictedDistance < currentDistance
    };
  }

  let lowerBound = minimumAmount - 1n;
  let upperBound = minimumAmount;
  let upperEvaluation = evaluate(upperBound);

  while (!upperEvaluation.improvesConvergence) {
    lowerBound = upperBound;
    if (upperBound === maxAmount) {
      return undefined;
    }

    upperBound = upperBound * 2n;
    if (upperBound > maxAmount) {
      upperBound = maxAmount;
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

  const expiry =
    options.nowTimestamp + (config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS);

  return {
    id: `auto-lend:add-quote:${upperBound.toString()}`,
    intent: "LEND",
    minimumExecutionSteps: [
      {
        type: "ADD_QUOTE",
        amount: upperBound,
        bucketIndex: config.addQuoteBucketIndex,
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
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    const nowSeconds = this.now();
    const blockTimestamp = Number(block.timestamp);

    const [
      [currentRateWad, interestRateUpdateTimestamp],
      [currentDebtWad],
      [debtColEmaWad, lupt0DebtEmaWad, debtEmaWad, depositEmaWad],
      quoteTokenAddress,
      collateralAddress,
      quoteTokenScale,
      poolType
    ] = await Promise.all([
      this.publicClient.readContract({
        address: this.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "interestRateInfo",
        blockNumber: block.number
      }),
      this.publicClient.readContract({
        address: this.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "debtInfo",
        blockNumber: block.number
      }),
      this.publicClient.readContract({
        address: this.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "emasInfo",
        blockNumber: block.number
      }),
      this.publicClient.readContract({
        address: this.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "quoteTokenAddress",
        blockNumber: block.number
      }),
      this.publicClient.readContract({
        address: this.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "collateralAddress",
        blockNumber: block.number
      }),
      this.publicClient.readContract({
        address: this.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "quoteTokenScale",
        blockNumber: block.number
      }),
      this.publicClient.readContract({
        address: this.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "poolType",
        blockNumber: block.number
      })
    ]);

    const prediction = classifyAjnaNextRate({
      currentRateWad,
      currentDebtWad,
      debtEmaWad,
      depositEmaWad,
      debtColEmaWad,
      lupt0DebtEmaWad,
      lastInterestRateUpdateTimestamp: Number(interestRateUpdateTimestamp),
      nowTimestamp: nowSeconds
    });
    const rateState: AjnaRateState = {
      currentRateWad,
      currentDebtWad,
      debtEmaWad,
      depositEmaWad,
      debtColEmaWad,
      lupt0DebtEmaWad,
      lastInterestRateUpdateTimestamp: Number(interestRateUpdateTimestamp),
      nowTimestamp: nowSeconds
    };
    const autoCandidates: PlanCandidate[] = [];
    if (this.config.enableHeuristicLendSynthesis) {
      const lendCandidate = synthesizeAjnaLendCandidate(rateState, this.config, {
        quoteTokenScale,
        nowTimestamp: nowSeconds,
        baselinePrediction: prediction
      });
      if (lendCandidate) {
        autoCandidates.push(lendCandidate);
      }
    }

    const snapshotFingerprint = keccak256(
      stringToHex(
        [
          this.poolAddress,
          block.number.toString(),
          currentRateWad.toString(),
          currentDebtWad.toString(),
          debtEmaWad.toString(),
          depositEmaWad.toString(),
          debtColEmaWad.toString(),
          lupt0DebtEmaWad.toString()
        ].join(":")
      )
    );

    return {
      snapshotFingerprint,
      poolId: this.config.poolId,
      chainId: this.config.chainId,
      blockNumber: block.number,
      blockTimestamp,
      snapshotAgeSeconds: Math.max(0, nowSeconds - blockTimestamp),
      secondsUntilNextRateUpdate: prediction.secondsUntilNextRateUpdate,
      currentRateBps: toRateBps(currentRateWad),
      predictedNextOutcome: prediction.predictedOutcome,
      predictedNextRateBps: prediction.predictedNextRateBps,
      candidates: [
        ...autoCandidates,
        ...structuredClone(this.config.manualCandidates ?? [])
      ],
      metadata: {
        poolAddress: this.poolAddress,
        quoteTokenAddress,
        collateralAddress,
        quoteTokenScale: quoteTokenScale.toString(),
        poolType,
        currentRateWad: currentRateWad.toString(),
        predictedNextRateWad: prediction.predictedNextRateWad.toString(),
        lastInterestRateUpdateTimestamp: Number(interestRateUpdateTimestamp),
        currentDebtWad: currentDebtWad.toString(),
        debtEmaWad: debtEmaWad.toString(),
        depositEmaWad: depositEmaWad.toString(),
        debtColEmaWad: debtColEmaWad.toString(),
        lupt0DebtEmaWad: lupt0DebtEmaWad.toString(),
        autoCandidateCount: autoCandidates.length
      }
    };
  }
}

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
import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import { type SnapshotSource } from "../snapshot.js";
import {
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
  quoteTokenAddress: HexAddress;
  collateralAddress: HexAddress;
  quoteTokenScale: bigint;
  poolType: number;
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

function compareCandidatePreference(left: PlanCandidate, right: PlanCandidate): number {
  const leftInBand = left.resultingDistanceToTargetBps === 0 ? 0 : 1;
  const rightInBand = right.resultingDistanceToTargetBps === 0 ? 0 : 1;
  if (leftInBand !== rightInBand) {
    return leftInBand - rightInBand;
  }

  if (left.resultingDistanceToTargetBps !== right.resultingDistanceToTargetBps) {
    return left.resultingDistanceToTargetBps - right.resultingDistanceToTargetBps;
  }

  if (left.quoteTokenDelta !== right.quoteTokenDelta) {
    return left.quoteTokenDelta < right.quoteTokenDelta ? -1 : 1;
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
        state.lupt0DebtEmaWad.toString()
      ].join(":")
    )
  );
}

async function readAjnaPoolState(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  nowSeconds?: number,
  blockNumber?: bigint
): Promise<AjnaPoolStateRead> {
  const block = await publicClient.getBlock(
    blockNumber === undefined ? { blockTag: "latest" } : { blockNumber }
  );
  const effectiveBlockNumber = block.number;
  const effectiveNowSeconds = nowSeconds ?? Number(block.timestamp);

  const [
    [currentRateWad, interestRateUpdateTimestamp],
    [currentDebtWad],
    [debtColEmaWad, lupt0DebtEmaWad, debtEmaWad, depositEmaWad],
    quoteTokenAddress,
    collateralAddress,
    quoteTokenScale,
    poolType
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

  return {
    blockNumber: effectiveBlockNumber,
    blockTimestamp: Number(block.timestamp),
    rateState,
    prediction: forecastAjnaNextEligibleRate(rateState),
    immediatePrediction: classifyAjnaNextRate(rateState),
    quoteTokenAddress,
    collateralAddress,
    quoteTokenScale,
    poolType
  };
}

function buildPoolSnapshot(
  config: KeeperConfig,
  poolAddress: HexAddress,
  readState: AjnaPoolStateRead,
  autoCandidates: PlanCandidate[],
  autoCandidateSource?: "simulation" | "heuristic"
): PoolSnapshot {
  return {
    snapshotFingerprint: buildSnapshotFingerprint(
      poolAddress,
      readState.blockNumber,
      readState.rateState
    ),
    poolId: config.poolId,
    chainId: config.chainId,
    blockNumber: readState.blockNumber,
    blockTimestamp: readState.blockTimestamp,
    snapshotAgeSeconds: Math.max(0, readState.rateState.nowTimestamp - readState.blockTimestamp),
    secondsUntilNextRateUpdate: readState.prediction.secondsUntilNextRateUpdate,
    currentRateBps: toRateBps(readState.rateState.currentRateWad),
    predictedNextOutcome: readState.prediction.predictedOutcome,
    predictedNextRateBps: readState.prediction.predictedNextRateBps,
    candidates: [
      ...autoCandidates.map((candidate) => structuredClone(candidate)),
      ...structuredClone(config.manualCandidates ?? [])
    ],
    metadata: {
      poolAddress,
      quoteTokenAddress: readState.quoteTokenAddress,
      collateralAddress: readState.collateralAddress,
      quoteTokenScale: readState.quoteTokenScale.toString(),
      poolType: readState.poolType,
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
      autoCandidateSource
    }
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

  const addQuoteBucketIndex = config.addQuoteBucketIndex;
  const targetBand = buildTargetBand(config);
  const currentRateBps = toRateBps(state.currentRateWad);
  if (currentRateBps <= targetBand.maxRateBps) {
    return undefined;
  }

  const baselinePrediction = options.baselinePrediction ?? classifyAjnaNextRate(state);
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const maxAmount = config.maxQuoteTokenExposure;

  if (minimumAmount > maxAmount) {
    return undefined;
  }

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

    return await work({
      publicClient,
      testClient,
      walletClient
    });
  } catch (error) {
    if (stderrBuffer.trim().length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${stderrBuffer.trim()}`
      );
    }

    throw error;
  } finally {
    await stopChildProcess(anvil);
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
  }
): Promise<PlanCandidate | undefined> {
  if (config.addQuoteBucketIndex === undefined) {
    return undefined;
  }

  const addQuoteBucketIndex = config.addQuoteBucketIndex;
  const targetBand = buildTargetBand(config);
  const currentRateBps = toRateBps(readState.rateState.currentRateWad);
  if (currentRateBps <= targetBand.maxRateBps) {
    return undefined;
  }

  const baselinePrediction = options.baselinePrediction ?? readState.prediction;
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const simulationSenderAddress = resolveSimulationSenderAddress(config);

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

        const maxAmount = smallestBigInt(
          config.maxQuoteTokenExposure,
          quoteTokenBalance,
          quoteTokenAllowance
        );
        if (minimumAmount > maxAmount) {
          return undefined;
        }

        const expiryOffset = BigInt(
          config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS
        );

        const evaluate = async (
          quoteTokenAmount: bigint
        ): Promise<{
          predictedOutcome: RateMoveOutcome;
          predictedRateWadAfterNextUpdate: bigint;
          predictedRateBpsAfterNextUpdate: number;
          improvesConvergence: boolean;
        }> => {
          const snapshotId = await testClient.snapshot();

          try {
            const simulationBlock = await publicClient.getBlock({ blockTag: "latest" });
            const hash = await walletClient.writeContract({
              account: simulationSenderAddress,
              chain: undefined,
              address: options.poolAddress,
              abi: ajnaPoolAbi,
              functionName: "addQuoteToken",
              args: [
                quoteTokenAmount,
                BigInt(addQuoteBucketIndex),
                simulationBlock.timestamp + expiryOffset
              ]
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== "success") {
              return {
                predictedOutcome: baselinePrediction.predictedOutcome,
                predictedRateWadAfterNextUpdate: baselinePrediction.predictedNextRateWad,
                predictedRateBpsAfterNextUpdate: baselinePrediction.predictedNextRateBps,
                improvesConvergence: false
              };
            }

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
              return {
                predictedOutcome: baselinePrediction.predictedOutcome,
                predictedRateWadAfterNextUpdate: baselinePrediction.predictedNextRateWad,
                predictedRateBpsAfterNextUpdate: baselinePrediction.predictedNextRateBps,
                improvesConvergence: false
              };
            }

            const postUpdateReadState = await readAjnaPoolState(publicClient, options.poolAddress);
            const predictedRateWadAfterNextUpdate =
              postUpdateReadState.rateState.currentRateWad;
            const predictedRateBpsAfterNextUpdate = toRateBps(
              predictedRateWadAfterNextUpdate
            );
            const predictedDistance = distanceToTargetBand(
              predictedRateBpsAfterNextUpdate,
              targetBand
            );
            const predictedOutcome = deriveRateMoveOutcome(
              readState.rateState.currentRateWad,
              predictedRateWadAfterNextUpdate
            );

            return {
              predictedOutcome,
              predictedRateWadAfterNextUpdate,
              predictedRateBpsAfterNextUpdate,
              improvesConvergence:
                predictionChanged(baselinePrediction, {
                  predictedOutcome,
                  predictedNextRateWad: predictedRateWadAfterNextUpdate,
                  predictedNextRateBps: predictedRateBpsAfterNextUpdate,
                  secondsUntilNextRateUpdate: 0
                }) &&
                predictedDistance < baselineDistance
            };
          } catch {
            return {
              predictedOutcome: baselinePrediction.predictedOutcome,
              predictedRateWadAfterNextUpdate: baselinePrediction.predictedNextRateWad,
              predictedRateBpsAfterNextUpdate: baselinePrediction.predictedNextRateBps,
              improvesConvergence: false
            };
          } finally {
            await testClient.revert({ id: snapshotId });
          }
        };

        let lowerBound = minimumAmount - 1n;
        let upperBound = minimumAmount;
        let upperEvaluation = await evaluate(upperBound);

        while (!upperEvaluation.improvesConvergence) {
          lowerBound = upperBound;
          if (upperBound === maxAmount) {
            return undefined;
          }

          upperBound = upperBound * 2n;
          if (upperBound > maxAmount) {
            upperBound = maxAmount;
          }
          upperEvaluation = await evaluate(upperBound);
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

        const expiry =
          readState.rateState.nowTimestamp +
          (config.addQuoteExpirySeconds ?? DEFAULT_ADD_QUOTE_EXPIRY_SECONDS);

        return {
          id: `sim-lend:add-quote:${upperBound.toString()}`,
          intent: "LEND",
          minimumExecutionSteps: [
            {
              type: "ADD_QUOTE",
              amount: upperBound,
              bucketIndex: addQuoteBucketIndex,
              expiry,
              note: "simulation-backed add-quote threshold"
            }
          ],
          predictedOutcome: upperEvaluation.predictedOutcome,
          predictedRateBpsAfterNextUpdate: upperEvaluation.predictedRateBpsAfterNextUpdate,
          resultingDistanceToTargetBps: distanceToTargetBand(
            upperEvaluation.predictedRateBpsAfterNextUpdate,
            targetBand
          ),
          quoteTokenDelta: upperBound,
          explanation: `simulation-backed add-quote threshold changes the next eligible Ajna move from ${baselinePrediction.predictedOutcome} to ${upperEvaluation.predictedOutcome}`
        };
      } finally {
        await testClient.stopImpersonatingAccount({
          address: simulationSenderAddress
        });
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
  const currentRateBps = toRateBps(state.currentRateWad);
  if (currentRateBps >= targetBand.minRateBps) {
    return undefined;
  }

  const baselinePrediction = options.baselinePrediction ?? forecastAjnaNextEligibleRate(state);
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
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

      if (!bestCandidate || compareCandidatePreference(candidate, bestCandidate) < 0) {
        bestCandidate = candidate;
      }
    }
  }

  return bestCandidate;
}

async function synthesizeAjnaBorrowCandidateViaSimulation(
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    poolAddress: HexAddress;
    rpcUrl: string;
    baselinePrediction?: AjnaRatePrediction;
  }
): Promise<PlanCandidate | undefined> {
  const limitIndexes = resolveDrawDebtLimitIndexes(config);
  if (limitIndexes.length === 0) {
    return undefined;
  }

  const targetBand = buildTargetBand(config);
  const currentRateBps = toRateBps(readState.rateState.currentRateWad);
  if (currentRateBps >= targetBand.minRateBps) {
    return undefined;
  }

  const baselinePrediction = options.baselinePrediction ?? readState.prediction;
  const baselineDistance = distanceToTargetBand(
    baselinePrediction.predictedNextRateBps,
    targetBand
  );
  const minimumAmount =
    config.minExecutableActionQuoteToken > 0n ? config.minExecutableActionQuoteToken : 1n;
  const maxAmount = config.maxBorrowExposure;
  if (minimumAmount > maxAmount) {
    return undefined;
  }

  const simulationSenderAddress = resolveSimulationSenderAddress(config);
  const borrowerAddress = resolveSimulationBorrowerAddress(config, simulationSenderAddress);
  const collateralAmounts = resolveDrawDebtCollateralAmounts(config);
  const lookaheadUpdates = resolveBorrowSimulationLookaheadUpdates(config);

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
        const maxAvailableCollateral = smallestBigInt(collateralBalance, collateralAllowance);
        const candidateCollateralAmounts = collateralAmounts.filter(
          (collateralAmount) => collateralAmount <= maxAvailableCollateral
        );
        if (candidateCollateralAmounts.length === 0) {
          return undefined;
        }

        async function simulateBorrowPath(
          drawDebt: {
            amount: bigint;
            limitIndex: number;
            collateralAmount: bigint;
          } | null
        ): Promise<{
          firstRateWadAfterNextUpdate: bigint;
          firstRateBpsAfterNextUpdate: number;
          firstOutcome: RateMoveOutcome;
          terminalRateBps: number;
          terminalDistanceToTargetBps: number;
        }> {
          const snapshotId = await testClient.snapshot();

          try {
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
            }

            let firstRateWadAfterNextUpdate = readState.rateState.currentRateWad;
            let firstOutcome: RateMoveOutcome = "NO_CHANGE";
            let terminalRateWad = readState.rateState.currentRateWad;

            for (let updateIndex = 0; updateIndex < lookaheadUpdates; updateIndex += 1) {
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

              if (updateIndex === 0) {
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

        const baselinePath = await simulateBorrowPath(null);
        const baselineNextDistance = distanceToTargetBand(
          baselinePath.firstRateBpsAfterNextUpdate,
          targetBand
        );
        const baselineTerminalDistance = baselinePath.terminalDistanceToTargetBps;

        let bestCandidate: PlanCandidate | undefined;

        for (const limitIndex of limitIndexes) {
          for (const collateralAmount of candidateCollateralAmounts) {
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

          let lowerBound = minimumAmount - 1n;
          let upperBound = minimumAmount;
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

          if (!bestCandidate || compareCandidatePreference(candidate, bestCandidate) < 0) {
            bestCandidate = candidate;
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
  private readonly simulationCandidateCache = new Map<string, PlanCandidate[]>();

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
    const readState = await readAjnaPoolState(
      this.publicClient,
      this.poolAddress,
      this.now()
    );
    const snapshotFingerprint = buildSnapshotFingerprint(
      this.poolAddress,
      readState.blockNumber,
      readState.rateState
    );

    const autoCandidates: PlanCandidate[] = [];
    let autoCandidateSource: "simulation" | "heuristic" | undefined;

    if (
      this.config.enableSimulationBackedLendSynthesis ||
      this.config.enableSimulationBackedBorrowSynthesis
    ) {
      if (!this.simulationCandidateCache.has(snapshotFingerprint)) {
        const synthesizedCandidates: PlanCandidate[] = [];
        const rpcUrl = assertLiveReadConfig(this.config).rpcUrl;

        if (this.config.enableSimulationBackedLendSynthesis) {
          const lendCandidate = await synthesizeAjnaLendCandidateViaSimulation(
            readState,
            this.config,
            {
              poolAddress: this.poolAddress,
              rpcUrl,
              baselinePrediction: readState.prediction
            }
          );
          if (lendCandidate) {
            synthesizedCandidates.push(lendCandidate);
          }
        }

        if (this.config.enableSimulationBackedBorrowSynthesis) {
          const borrowCandidate = await synthesizeAjnaBorrowCandidateViaSimulation(
            readState,
            this.config,
            {
              poolAddress: this.poolAddress,
              rpcUrl,
              baselinePrediction: readState.prediction
            }
          );
          if (borrowCandidate) {
            synthesizedCandidates.push(borrowCandidate);
          }
        }

        this.simulationCandidateCache.set(snapshotFingerprint, synthesizedCandidates);
      }

      const cachedCandidates = this.simulationCandidateCache.get(snapshotFingerprint) ?? [];
      if (cachedCandidates.length > 0) {
        autoCandidates.push(...cachedCandidates);
        autoCandidateSource = "simulation";
      }
    }

    if (autoCandidates.length === 0 && this.config.enableHeuristicLendSynthesis) {
      const lendCandidate = synthesizeAjnaLendCandidate(readState.rateState, this.config, {
        quoteTokenScale: readState.quoteTokenScale,
        nowTimestamp: readState.rateState.nowTimestamp,
        baselinePrediction: readState.prediction
      });
      if (lendCandidate) {
        autoCandidates.push(lendCandidate);
        autoCandidateSource = "heuristic";
      }
    }

    return buildPoolSnapshot(
      this.config,
      this.poolAddress,
      readState,
      autoCandidates,
      autoCandidateSource
    );
  }
}

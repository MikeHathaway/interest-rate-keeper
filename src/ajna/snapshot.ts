import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

import {
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
  const currentDistance = distanceToTargetBand(currentRateBps, targetBand);
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
    const publicClient = createPublicClient({
      transport: http(rpcUrl)
    });
    const testClient = createTestClient({
      mode: "anvil",
      transport: http(rpcUrl)
    });
    const walletClient = createWalletClient({
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
      "simulation-backed lend synthesis requires simulationSenderAddress or AJNA_KEEPER_PRIVATE_KEY/PRIVATE_KEY"
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
  const currentDistance = distanceToTargetBand(currentRateBps, targetBand);
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
                predictedDistance < currentDistance
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
  private readonly simulationCandidateCache = new Map<string, PlanCandidate | null>();

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

    if (this.config.enableSimulationBackedLendSynthesis) {
      if (!this.simulationCandidateCache.has(snapshotFingerprint)) {
        const synthesizedCandidate = await synthesizeAjnaLendCandidateViaSimulation(
          readState,
          this.config,
          {
            poolAddress: this.poolAddress,
            rpcUrl: assertLiveReadConfig(this.config).rpcUrl,
            baselinePrediction: readState.prediction
          }
        );
        this.simulationCandidateCache.set(snapshotFingerprint, synthesizedCandidate ?? null);
      }

      const cachedCandidate = this.simulationCandidateCache.get(snapshotFingerprint);
      if (cachedCandidate) {
        autoCandidates.push(cachedCandidate);
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

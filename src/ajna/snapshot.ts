import {
  createPublicClient,
  http,
  keccak256,
  stringToHex,
  type Hex,
  type PublicClient
} from "viem";

import { ajnaPoolAbi } from "./abi.js";
import {
  type AjnaPoolStateRead,
  type BorrowSimulationSynthesisResult,
  DEFAULT_ADD_QUOTE_EXPIRY_SECONDS,
  type SimulationAccountState,
  buildSnapshotFingerprint,
  finalizeCandidate,
  serializeExecutionStepForValidation
} from "./snapshot-internal.js";
import { synthesizeAjnaHeuristicCandidates } from "./snapshot-dual.js";
import { synthesizeAjnaLendCandidateViaSimulation } from "./snapshot-lend-sim.js";
import { synthesizeAjnaBorrowCandidateViaSimulation } from "./snapshot-borrow-sim.js";
import { synthesizeAjnaLendAndBorrowCandidateViaSimulation } from "./snapshot-dual-sim.js";
import { hasUninitializedAjnaEmaState, toRateBps } from "./rate-state.js";
import { resolveAjnaSignerAddress } from "./runtime.js";
import {
  resolveAddQuoteBucketIndexes,
  resolveDrawDebtCollateralAmounts,
  resolveDrawDebtLimitIndexes,
  resolvePreWindowLendBucketIndexes,
  resolveProtocolShapedPreWindowDualBucketIndexes,
  resolveTimedBorrowSimulationLookaheadAttempts
} from "./search-space.js";
import { buildSimulationCacheKey, setBoundedCacheEntry } from "./snapshot-cache.js";
import { readAjnaPoolState, readSimulationAccountState } from "./snapshot-read.js";
import { type SnapshotSource } from "../snapshot.js";
import {
  type HexAddress,
  type KeeperConfig,
  type PlanCandidate,
  type PoolSnapshot
} from "../types.js";

export {
  type AjnaRatePrediction,
  type AjnaRateState,
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate,
  hasUninitializedAjnaEmaState
} from "./rate-state.js";
export {
  synthesizeAjnaHeuristicCandidates,
  synthesizeAjnaLendAndBorrowCandidate
} from "./snapshot-dual.js";
export { synthesizeAjnaBorrowCandidate } from "./snapshot-borrow.js";
export { synthesizeAjnaLendCandidate } from "./snapshot-lend.js";
export {
  resolveSimulationBorrowCollateralAmounts,
  resolveSimulationBorrowLimitIndexes,
  resolveBorrowSimulationLookaheadAttempts,
  resolveProtocolApproximationBucketIndexes,
  resolveTimedBorrowSimulationLookaheadAttempts,
  resolveProtocolShapedPreWindowDualBucketIndexes,
  searchCoarseToFineDualSpace
} from "./search-space.js";
export { rankProtocolShapedDualBranches } from "./snapshot-dual-prefilter.js";

const MAX_SIMULATION_CANDIDATE_CACHE_ENTRIES = 2_048;

export interface AjnaSynthesisPolicy {
  simulationLend: boolean;
  simulationBorrow: boolean;
  heuristicLend: boolean;
  heuristicBorrow: boolean;
}

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

const simulationCandidateCache = new Map<string, CachedSimulationCandidates>();

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
    accountState.collateralAllowance,
    accountState.lenderBucketStateSignature ?? "-"
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
          bucketState.map((value: unknown) => String(value)).join(":")
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
          needsCollateralState: synthesisPolicy.simulationBorrow,
          ...(synthesisPolicy.simulationLend
            ? {
                lenderQuoteBucketIndexes: resolveProtocolShapedPreWindowDualBucketIndexes(
                  readState,
                  synthesisConfig
                )
              }
            : {})
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
          const borrowLookaheadAttempts = resolveTimedBorrowSimulationLookaheadAttempts(
            synthesisConfig,
            readState.immediatePrediction.secondsUntilNextRateUpdate,
            readState.rateState
          );
          for (const lookaheadUpdates of borrowLookaheadAttempts) {
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

          const allowMultiCycleDualSearch =
            (readState.loansState?.noOfLoans ?? 0n) > 1n &&
            !hasUninitializedAjnaEmaState(readState.rateState);

          if (
            synthesisPolicy.simulationLend &&
            ((borrowResult?.planningLookaheadUpdates === undefined ||
              borrowResult.planningLookaheadUpdates <= 1) ||
              allowMultiCycleDualSearch)
          ) {
            const dualLookaheadUpdates =
              borrowResult?.planningLookaheadUpdates ??
              borrowLookaheadAttempts[borrowLookaheadAttempts.length - 1];
            const dualConfig =
              dualLookaheadUpdates === undefined ||
              synthesisConfig.borrowSimulationLookaheadUpdates === dualLookaheadUpdates
                ? synthesisConfig
                : {
                    ...synthesisConfig,
                    borrowSimulationLookaheadUpdates: dualLookaheadUpdates
                  };
            const horizonAlignedSingleActionCandidates = [lendCandidate, borrowCandidate].filter(
              (candidate): candidate is PlanCandidate =>
                candidate !== undefined &&
                (candidate.planningLookaheadUpdates ?? 1) === (dualLookaheadUpdates ?? 1)
            );
            const dualCandidate = await synthesizeAjnaLendAndBorrowCandidateViaSimulation(
              readState,
              dualConfig,
              {
                poolAddress: this.poolAddress,
                rpcUrl,
                baselinePrediction: readState.prediction,
                accountState: simulationAccountState,
                ...(borrowCandidate === undefined ||
                (borrowCandidate.planningLookaheadUpdates ?? 1) !== (dualLookaheadUpdates ?? 1)
                  ? {}
                  : { anchorBorrowCandidate: borrowCandidate }),
                singleActionCandidates: horizonAlignedSingleActionCandidates
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

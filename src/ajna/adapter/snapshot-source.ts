import {
  createPublicClient,
  http,
  keccak256,
  stringToHex,
  type Hex,
  type PublicClient
} from "viem";

import { ajnaPoolAbi } from "./abi.js";
import { deriveManagedInventoryDiagnostics } from "./managed-diagnostics.js";
import { hasUninitializedAjnaEmaState, toRateBps } from "../math/rate-state.js";
import { synthesizeAjnaHeuristicCandidates } from "../synthesize/dual/heuristic.js";
import { synthesizeAjnaLendAndBorrowCandidateViaSimulation } from "../synthesize/dual/exact.js";
import { synthesizeAjnaBorrowCandidateViaSimulation } from "../synthesize/borrow/exact.js";
import {
  buildSimulationCacheKey,
  registerAjnaCacheClearable,
  setBoundedCacheEntry
} from "../read/cache.js";
import {
  hasResolvableSimulationSenderAddress,
  resolveAjnaSynthesisPolicy,
  resolveSimulationExecutionCompatibility
} from "./synthesis-policy.js";
import {
  type AjnaPoolStateRead,
  type BorrowSimulationSynthesisResult,
  DEFAULT_ADD_QUOTE_EXPIRY_SECONDS,
  type SimulationAccountState,
  buildSnapshotFingerprint,
  finalizeCandidate,
  serializeExecutionStepForValidation
} from "../domain.js";
import { synthesizeAjnaLendCandidateViaSimulation } from "../synthesize/lend/exact.js";
import {
  readAjnaPoolState,
  readSimulationAccountState
} from "../read/pool-state.js";
import {
  resolveAddQuoteBucketIndexes,
  resolveDrawDebtCollateralAmounts,
  resolveDrawDebtLimitIndexes,
  resolveManagedInventoryBucketIndexes,
  resolvePreWindowLendBucketIndexes,
  resolveProtocolShapedPreWindowDualBucketIndexes,
  resolveRemoveQuoteBucketIndexes,
  resolveTimedBorrowSimulationLookaheadAttempts
} from "../search/index.js";
import { resolveViemChain } from "./viem-chain.js";
import { type SnapshotSource } from "../../core/snapshot/file.js";
import {
  type HexAddress,
  type KeeperConfig,
  type PlanCandidate,
  type PoolSnapshot,
  type PoolSnapshotMetadata
} from "../../core/types.js";

const MAX_SIMULATION_CANDIDATE_CACHE_ENTRIES = 2_048;

interface CachedSimulationCandidates {
  candidates: PlanCandidate[];
  planningRateBps?: number;
  planningLookaheadUpdates?: number;
}

const simulationCandidateCache = new Map<string, CachedSimulationCandidates>();
registerAjnaCacheClearable(() => simulationCandidateCache.clear());

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
    resolveRemoveQuoteBucketIndexes(config).join(","),
    resolveDrawDebtLimitIndexes(config).join(","),
    resolveDrawDebtCollateralAmounts(config)
      .map((value) => value.toString())
      .join(","),
    config.borrowSimulationLookaheadUpdates ?? 1,
    config.enableManagedInventoryUpwardControl ? "managed-upward" : "no-managed-upward",
    config.enableManagedDualUpwardControl ? "managed-dual" : "no-managed-dual",
    config.minimumManagedImprovementBps ?? 0,
    config.maxManagedInventoryReleaseBps ?? 0,
    config.minimumManagedSensitivityBpsPer10PctRelease ?? 0,
    accountState.simulationSenderAddress,
    accountState.borrowerAddress,
    accountState.quoteTokenBalance,
    accountState.quoteTokenAllowance,
    accountState.collateralBalance,
    accountState.collateralAllowance,
    accountState.lenderBucketStateSignature ?? "-"
  ]);
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

function candidateHasStep(candidate: PlanCandidate, stepType: string): boolean {
  return candidate.minimumExecutionSteps.some((step) => step.type === stepType);
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
  if (bucketIndexes.length === 0) {
    return signatures;
  }

  const multicallResults = await publicClient.multicall({
    allowFailure: true,
    contracts: bucketIndexes.map((bucketIndex) => ({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "bucketInfo",
      args: [BigInt(bucketIndex)]
    })),
    blockNumber
  });

  multicallResults.forEach((result, index) => {
    const bucketIndex = bucketIndexes[index]!;
    if (result.status !== "success") {
      signatures.set(bucketIndex, "bucket-read-failed");
      return;
    }
    const bucketState = result.result as readonly unknown[];
    signatures.set(
      bucketIndex,
      bucketState.map((value) => String(value)).join(":")
    );
  });

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
    managedInventoryUpwardControlEnabled?: boolean;
    managedDualUpwardControlEnabled?: boolean;
    managedUpwardControlNeeded?: boolean;
    managedInventoryUpwardEligible?: boolean;
    managedInventoryIneligibilityReason?: string;
    managedDualUpwardEligible?: boolean;
    managedDualIneligibilityReason?: string;
    managedInventoryBucketCount?: number;
    managedConfiguredBucketCount?: number;
    managedMaxWithdrawableQuoteAmount?: string;
    managedTotalWithdrawableQuoteAmount?: string;
    managedPerBucketWithdrawableQuoteAmount?: string;
    managedRemoveQuoteCandidateCount?: number;
    managedDualCandidateCount?: number;
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
      ...(readState.loansState?.maxBorrower === undefined
        ? {}
        : { maxBorrower: readState.loansState.maxBorrower }),
      ...(readState.loansState?.maxT0DebtToCollateral === undefined
        ? {}
        : {
            maxT0DebtToCollateral: readState.loansState.maxT0DebtToCollateral.toString()
          }),
      ...(readState.loansState?.noOfLoans === undefined
        ? {}
        : { noOfLoans: readState.loansState.noOfLoans.toString() }),
      ...(readState.borrowerState?.borrowerAddress === undefined
        ? {}
        : { borrowerAddress: readState.borrowerState.borrowerAddress }),
      ...(readState.borrowerState?.t0Debt === undefined
        ? {}
        : { borrowerT0Debt: readState.borrowerState.t0Debt.toString() }),
      ...(readState.borrowerState?.collateral === undefined
        ? {}
        : { borrowerCollateral: readState.borrowerState.collateral.toString() }),
      ...(readState.borrowerState?.npTpRatio === undefined
        ? {}
        : { borrowerNpTpRatio: readState.borrowerState.npTpRatio.toString() }),
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
      ...(autoCandidateSource === undefined ? {} : { autoCandidateSource }),
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
        : { liveSignerAddress: diagnostics.liveSignerAddress }),
      ...(diagnostics?.managedInventoryUpwardControlEnabled === undefined
        ? {}
        : {
            managedInventoryUpwardControlEnabled:
              diagnostics.managedInventoryUpwardControlEnabled
          }),
      ...(diagnostics?.managedDualUpwardControlEnabled === undefined
        ? {}
        : {
            managedDualUpwardControlEnabled: diagnostics.managedDualUpwardControlEnabled
          }),
      ...(diagnostics?.managedUpwardControlNeeded === undefined
        ? {}
        : { managedUpwardControlNeeded: diagnostics.managedUpwardControlNeeded }),
      ...(diagnostics?.managedInventoryUpwardEligible === undefined
        ? {}
        : {
            managedInventoryUpwardEligible: diagnostics.managedInventoryUpwardEligible
          }),
      ...(diagnostics?.managedInventoryIneligibilityReason === undefined
        ? {}
        : {
            managedInventoryIneligibilityReason:
              diagnostics.managedInventoryIneligibilityReason
          }),
      ...(diagnostics?.managedDualUpwardEligible === undefined
        ? {}
        : { managedDualUpwardEligible: diagnostics.managedDualUpwardEligible }),
      ...(diagnostics?.managedDualIneligibilityReason === undefined
        ? {}
        : { managedDualIneligibilityReason: diagnostics.managedDualIneligibilityReason }),
      ...(diagnostics?.managedInventoryBucketCount === undefined
        ? {}
        : { managedInventoryBucketCount: diagnostics.managedInventoryBucketCount }),
      ...(diagnostics?.managedConfiguredBucketCount === undefined
        ? {}
        : { managedConfiguredBucketCount: diagnostics.managedConfiguredBucketCount }),
      ...(diagnostics?.managedMaxWithdrawableQuoteAmount === undefined
        ? {}
        : {
            managedMaxWithdrawableQuoteAmount:
              diagnostics.managedMaxWithdrawableQuoteAmount
          }),
      ...(diagnostics?.managedTotalWithdrawableQuoteAmount === undefined
        ? {}
        : {
            managedTotalWithdrawableQuoteAmount:
              diagnostics.managedTotalWithdrawableQuoteAmount
          }),
      ...(diagnostics?.managedPerBucketWithdrawableQuoteAmount === undefined
        ? {}
        : {
            managedPerBucketWithdrawableQuoteAmount:
              diagnostics.managedPerBucketWithdrawableQuoteAmount
          }),
      ...(diagnostics?.managedRemoveQuoteCandidateCount === undefined
        ? {}
        : {
            managedRemoveQuoteCandidateCount:
              diagnostics.managedRemoveQuoteCandidateCount
          }),
      ...(diagnostics?.managedDualCandidateCount === undefined
        ? {}
        : { managedDualCandidateCount: diagnostics.managedDualCandidateCount })
    } satisfies PoolSnapshotMetadata
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
        chain: resolveViemChain(config.chainId, runtime.rpcUrl),
        transport: http(runtime.rpcUrl, { batch: true })
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
    const derivedManagedInventoryBucketIndexes = resolveManagedInventoryBucketIndexes(
      readState,
      baseSynthesisConfig
    );
    const synthesisConfig: KeeperConfig =
      derivedPreWindowBucketIndexes.length === 0 &&
      derivedManagedInventoryBucketIndexes.length === 0
        ? baseSynthesisConfig
        : {
            ...baseSynthesisConfig,
            ...(derivedPreWindowBucketIndexes.length === 0
              ? {}
              : {
                  addQuoteBucketIndexes: Array.from(
                    new Set([
                      ...resolveAddQuoteBucketIndexes(baseSynthesisConfig),
                      ...derivedPreWindowBucketIndexes
                    ])
                  )
                }),
            ...(derivedManagedInventoryBucketIndexes.length === 0
              ? {}
              : {
                  removeQuoteBucketIndexes: Array.from(
                    new Set([
                      ...resolveRemoveQuoteBucketIndexes(baseSynthesisConfig),
                      ...derivedManagedInventoryBucketIndexes
                    ])
                  )
                })
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
    let managedDiagnostics = deriveManagedInventoryDiagnostics(
      readState,
      synthesisConfig,
      simulationPrerequisitesAvailable
    );

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
                lenderQuoteBucketIndexes: Array.from(
                  new Set([
                    ...resolveAddQuoteBucketIndexes(synthesisConfig),
                    ...resolveRemoveQuoteBucketIndexes(synthesisConfig),
                    ...resolveProtocolShapedPreWindowDualBucketIndexes(
                      readState,
                      synthesisConfig
                    )
                  ])
                )
              }
            : {})
        }
      );
      managedDiagnostics = deriveManagedInventoryDiagnostics(
        readState,
        synthesisConfig,
        simulationPrerequisitesAvailable,
        simulationAccountState
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
    const managedRemoveQuoteCandidateCount = autoCandidates.filter(
      (candidate) =>
        candidateHasStep(candidate, "REMOVE_QUOTE") &&
        !candidateHasStep(candidate, "DRAW_DEBT")
    ).length;
    const managedDualCandidateCount = autoCandidates.filter(
      (candidate) =>
        candidateHasStep(candidate, "REMOVE_QUOTE") &&
        candidateHasStep(candidate, "DRAW_DEBT")
    ).length;

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
          : { liveSignerAddress: simulationExecutionCompatibility.liveSignerAddress }),
        ...managedDiagnostics,
        managedRemoveQuoteCandidateCount,
        managedDualCandidateCount
      }
    );
  }
}

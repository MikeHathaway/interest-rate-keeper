import { ajnaPoolAbi } from "./abi.js";
import { synthesizeAjnaBorrowCandidate, findPureBorrowImprovementThresholdForCollateral } from "./snapshot-borrow.js";
import { buildSimulationCacheKey, setBoundedCacheEntry } from "./snapshot-cache.js";
import {
  type AjnaPoolStateRead,
  type BorrowSimulationPathResult,
  type BorrowSimulationSynthesisResult,
  type SimulationAccountState,
  buildSnapshotFingerprint,
  extractDrawDebtStep,
  finalizeCandidate,
  resolveBorrowSimulationLookaheadUpdates,
  resolveMinimumBorrowActionAmount,
  resolveSimulationBorrowerAddress,
  resolveSimulationSenderAddress,
  smallestBigInt
} from "./snapshot-internal.js";
import { readAjnaPoolState, readSimulationAccountState } from "./snapshot-read.js";
import {
  replayAjnaSimulationPath,
  withPreparedLazySimulationFork
} from "./snapshot-sim-helpers.js";
import { type AjnaRatePrediction } from "./rate-state.js";
import {
  buildAnchoredSearchAmounts,
  buildPreWindowBorrowSearchAmounts,
  buildSameCycleBorrowSearchAmounts,
  compareCandidatePreference,
  resolveDrawDebtCollateralAmounts,
  resolveDrawDebtLimitIndexes,
  resolvePoolAwareBorrowLimitIndexes,
  resolveSimulationBorrowCollateralAmounts
} from "./search-space.js";
import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import {
  type HexAddress,
  type KeeperConfig,
  type PlanCandidate,
  type RateMoveOutcome
} from "../types.js";

const MAX_EXACT_SIMULATION_PATH_CACHE_ENTRIES = 20_000;
const EXACT_SAME_CYCLE_BORROW_MAX_LIMIT_INDEXES = 2;
const EXACT_SAME_CYCLE_BORROW_MAX_COLLATERAL_SAMPLES = 4;
const EXACT_PREWINDOW_BORROW_MAX_LIMIT_INDEXES = 6;
const EXACT_PREWINDOW_BORROW_MAX_COLLATERAL_SAMPLES = 8;

const borrowSimulationPathCache = new Map<string, BorrowSimulationPathResult | null>();

export async function synthesizeAjnaBorrowCandidateViaSimulation(
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

  return withPreparedLazySimulationFork(
    {
      rpcUrl: options.rpcUrl,
      chainId: config.chainId,
      blockNumber: readState.blockNumber
    },
    simulationSenderAddress,
    async (getPreparedSimulationContext) => {
      const { publicClient } = await getPreparedSimulationContext();
      const effectiveAccountState =
        options.accountState ??
        (await readSimulationAccountState(
          publicClient,
          options.poolAddress,
          readState,
          config,
          {
            needsQuoteState: false,
            needsCollateralState: true
          }
        ));
      const maxAvailableCollateral = smallestBigInt(
        effectiveAccountState.collateralBalance ?? 0n,
        effectiveAccountState.collateralAllowance ?? 0n
      );
      const candidateCollateralAmounts = Array.from(
        new Set(
          [
            ...resolveSimulationBorrowCollateralAmounts(config, maxAvailableCollateral, {
              borrowerHasExistingPosition:
                (readState.borrowerState?.t0Debt ?? 0n) > 0n ||
                (readState.borrowerState?.collateral ?? 0n) > 0n
            }),
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

        try {
          const simulationResult = await replayAjnaSimulationPath(
            { publicClient, testClient, walletClient },
            {
              poolAddress: options.poolAddress,
              simulationSenderAddress,
              initialReadState: readState,
              lookaheadUpdates,
              terminalDistanceFromRateBps: (rateBps) =>
                distanceToTargetBand(rateBps, targetBand),
              readPoolState: () => readAjnaPoolState(publicClient, options.poolAddress),
              applyActions: async ({
                walletClient,
                publicClient,
                readPoolState,
                observeState
              }) => {
                if (!drawDebt) {
                  return;
                }

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

                observeState(await readPoolState());
              }
            }
          );
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
              : buildAnchoredSearchAmounts(minimumAmount, maxAmount, [
                  pureThresholdAmount,
                  heuristicThresholdAmount
                ]);

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
            resultingDistanceToTargetBps: refinedUpperEvaluation.terminalDistanceToTargetBps,
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
    }
  );
}

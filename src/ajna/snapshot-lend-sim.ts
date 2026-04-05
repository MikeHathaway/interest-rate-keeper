import { ajnaPoolAbi } from "./abi.js";
import { buildSimulationCacheKey, setBoundedCacheEntry } from "./snapshot-cache.js";
import {
  type AjnaPoolStateRead,
  type LendSimulationPathResult,
  type LendSimulationSynthesisResult,
  type SimulationAccountState,
  DEFAULT_ADD_QUOTE_EXPIRY_SECONDS,
  buildSnapshotFingerprint,
  finalizeCandidate,
  predictionChanged,
  resolveMinimumQuoteActionAmount,
  resolveSimulationSenderAddress,
  smallestBigInt
} from "./snapshot-internal.js";
import { synthesizeAjnaLendCandidate } from "./snapshot-lend.js";
import { readAjnaPoolState, readSimulationAccountState } from "./snapshot-read.js";
import {
  replayAjnaSimulationPath,
  withPreparedLazySimulationFork
} from "./snapshot-sim-helpers.js";
import { type AjnaRatePrediction } from "./rate-state.js";
import {
  type ScalarSearchMatch,
  buildExposureFractionAnchorAmounts,
  buildMultiCycleLendSearchAmounts,
  buildTokenScaleAnchorAmounts,
  compareCandidatePreference,
  compressCapitalAwareSearchAmounts,
  resolveAddQuoteBucketIndexes
} from "./search-space.js";
import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import {
  type HexAddress,
  type KeeperConfig,
  type PlanCandidate,
  type RateMoveOutcome
} from "../types.js";

const MAX_EXACT_SIMULATION_PATH_CACHE_ENTRIES = 20_000;
const EXACT_MULTI_CYCLE_LEND_MAX_QUOTE_SAMPLES = 12;
const EXACT_MULTI_CYCLE_LEND_LOW_END_QUOTE_SAMPLES = 8;

const lendSimulationPathCache = new Map<string, LendSimulationPathResult | null>();

export async function synthesizeAjnaLendCandidateViaSimulation(
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

  return withPreparedLazySimulationFork(
    {
      rpcUrl: options.rpcUrl,
      chainId: config.chainId,
      blockNumber: readState.blockNumber
    },
    simulationSenderAddress,
    async (getPreparedSimulationContext) => {
      const effectiveAccountState =
        options.accountState ??
        (await readSimulationAccountState(
          (await getPreparedSimulationContext()).publicClient,
          options.poolAddress,
          readState,
          config,
          {
            needsQuoteState: true,
            needsCollateralState: false
          }
        ));

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
                publicClient,
                walletClient,
                readPoolState,
                observeState
              }) => {
                if (!addQuote) {
                  return;
                }

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

                observeState(await readPoolState());
              }
            }
          );
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
            ...buildTokenScaleAnchorAmounts(readState.quoteTokenScale, minimumAmount, maxAmount)
          ];
          const searchAmounts = compressCapitalAwareSearchAmounts(
            buildMultiCycleLendSearchAmounts(minimumAmount, maxAmount, anchorAmounts),
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
              new Set(buildExposureFractionAnchorAmounts(maxAmount, minimumAmount))
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

            upperBound *= 2n;
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
    }
  );
}

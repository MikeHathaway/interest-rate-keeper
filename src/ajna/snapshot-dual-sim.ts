import { ajnaPoolAbi } from "./abi.js";
import {
  type AjnaPoolStateRead,
  type DualSimulationPathResult,
  type SimulationAccountState,
  DEFAULT_ADD_QUOTE_EXPIRY_SECONDS,
  extractAddQuoteStep,
  extractDrawDebtStep,
  finalizeCandidate,
  predictionChanged,
  resolveBorrowSimulationLookaheadUpdates,
  resolveMinimumBorrowActionAmount,
  resolveMinimumQuoteActionAmount,
  resolveSimulationBorrowerAddress,
  resolveSimulationSenderAddress,
  smallestBigInt
} from "./snapshot-internal.js";
import { synthesizeAjnaBorrowCandidate } from "./snapshot-borrow.js";
import { synthesizeAjnaLendAndBorrowCandidate } from "./snapshot-dual.js";
import { readAjnaPoolState, readSimulationAccountState } from "./snapshot-read.js";
import {
  replayAjnaSimulationPath,
  withPreparedSimulationFork
} from "./snapshot-sim-helpers.js";
import { type AjnaRatePrediction } from "./rate-state.js";
import {
  compareCandidatePreference,
  resolveAddQuoteBucketIndexes,
  resolveDrawDebtCollateralAmounts,
  resolveDrawDebtLimitIndexes,
  searchCoarseToFineDualSpace
} from "./search-space.js";
import { buildTargetBand, distanceToTargetBand } from "../planner.js";
import {
  type AddQuoteStep,
  type DrawDebtStep,
  type HexAddress,
  type KeeperConfig,
  type PlanCandidate,
  type RateMoveOutcome
} from "../types.js";

const EXACT_DUAL_MAX_BUCKETS = 3;
const EXACT_DUAL_MAX_QUOTE_SAMPLES = 6;
const EXACT_DUAL_MAX_BORROW_SAMPLES = 6;
const EXACT_DUAL_MAX_PROMISING_BASINS = 3;

export async function synthesizeAjnaLendAndBorrowCandidateViaSimulation(
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
  if (minimumBorrowAmount > maxBorrowAmount) {
    return undefined;
  }

  return withPreparedSimulationFork(
    {
      rpcUrl: options.rpcUrl,
      chainId: config.chainId,
      blockNumber: readState.blockNumber
    },
    simulationSenderAddress,
    async ({ publicClient, testClient, walletClient }) => {
      const effectiveAccountState =
        options.accountState ??
        (await readSimulationAccountState(
          publicClient,
          options.poolAddress,
          readState,
          config,
          {
            needsQuoteState: true,
            needsCollateralState: true
          }
        ));

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
        return replayAjnaSimulationPath(
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

                observeState(await readPoolState());
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

                observeState(await readPoolState());
              }
            }
          }
        );
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
        (bestDistance, candidate) =>
          Math.min(bestDistance, candidate.resultingDistanceToTargetBps),
        Number.POSITIVE_INFINITY
      );
      const comparisonNextDistance = Math.min(baselineNextDistance, bestSingleActionNextDistance);
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
              quoteTokenDelta: dualSearchMatch.quoteAmount + dualSearchMatch.drawDebtAmount,
              explanation:
                lookaheadUpdates > 1
                  ? `simulation-backed add-quote + draw-debt path improves the ${lookaheadUpdates}-update path beyond the best single-action path`
                  : `simulation-backed add-quote + draw-debt path improves the next eligible move beyond the best single-action path`
            };

            if (lookaheadUpdates > 1) {
              candidate.planningRateBps = dualSearchMatch.evaluation.candidatePath.terminalRateBps;
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
    }
  );
}

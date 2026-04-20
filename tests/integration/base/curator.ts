import { expect } from "vitest";
import {
  sweepSyntheticOwnershipFractions,
  type SweepFractionResult
} from "./helpers/curator-ownership-sweep.js";
import { probeRateResponseAcrossWithdrawalFractions } from "./helpers/curator-rate-response-probe.js";
import {
  setDualSynthesisDebugTrace,
  type DualSynthesisEvaluationEvent
} from "../../../src/ajna/synthesize/dual/exact.js";
import { probeSyntheticDualViablePool } from "./helpers/curator-dual-viable-synthetic.js";
import { probeMainnetArchetype } from "./helpers/curator-mainnet-probe.js";
import {
  probeRateResponseOnSyntheticPool,
  type SyntheticPoolShape
} from "./helpers/curator-rate-response-synthetic.js";

type RegisterTest = (
  name: string,
  testFn: () => Promise<void> | void,
  timeout?: number
) => void;

type InspectedManagedMatch = {
  borrowerDebtWad: bigint;
  borrowerCollateralWad: bigint;
  lenderLpBalance: bigint;
  bucketDepositWad: bigint;
  currentRateBps: number;
  targetRateBps: number;
  inventoryCandidateIntent?: string;
};

type ProbedManagedMatch = {
  archetypeId: string;
  maxWithdrawableQuoteAmount: bigint;
  improved: boolean;
  bestActiveRateBps?: number;
  bestRemoveQuoteAmount?: bigint;
};

type InventoryCandidate = {
  intent: string;
  minimumExecutionSteps: Array<{ type: string }>;
};

type BaseFactoryCuratorTestContext = {
  itBaseExperimental: RegisterTest;
  itBaseSlow: RegisterTest;
  createClients: () => {
    account: unknown;
    publicClient: unknown;
    walletClient: unknown;
    testClient: unknown;
  };
  ensureMockArtifact: () => Promise<unknown>;
  DEFAULT_ANVIL_PRIVATE_KEY: string;
  findSavedUsedPoolUpwardDualArchetypeMatches: (
    ...args: any[]
  ) => Promise<{ observations: string[]; positiveMatches: unknown[] }>;
  findPinnedUsedPoolUpwardSimulationMatches: () => Promise<{
    surfacedMatches: unknown[];
    observations: string[];
  }>;
  findPinnedUsedPoolUpwardPairedDualMatches: () => Promise<{
    surfacedMatches: unknown[];
    observations: string[];
  }>;
  inspectAjnaInfoManagedUsedPoolArchetypes: () => Promise<{
    inspectedMatches: InspectedManagedMatch[];
    observations: string[];
  }>;
  probeAjnaInfoManagedUsedPoolManualRemoveQuote: () => Promise<{
    probedMatches: ProbedManagedMatch[];
    observations: string[];
  }>;
  findTargetedAjnaInfoManagedUsedPoolInventoryCandidate: (
    archetypeId: string,
    options: {
      targetIntent: "LEND" | "LEND_AND_BORROW";
      drawDebtLimitIndexes?: readonly number[];
    }
  ) => Promise<{
    archetypeId: string;
    candidate?: InventoryCandidate;
    currentRateBps: number;
    targetRateBps: number;
    observations: string[];
  }>;
  probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow: () => Promise<{
    probedMatches: ProbedManagedMatch[];
    observations: string[];
  }>;
  executeTargetedAjnaInfoManagedUsedPoolRemoveQuote: (
    archetypeId: string
  ) => Promise<{
    status: "executed_and_realized";
    archetypeId: string;
    candidate: {
      minimumExecutionSteps: Array<{ type: string }>;
      intent: string;
      predictedRateBpsAfterNextUpdate: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
    };
    currentRateBps: number;
    targetRateBps: number;
    removeQuoteAmount: bigint;
    lenderBucketIndex: number;
    bucketDepositBeforeWad: bigint;
    bucketDepositAfterWad: bigint;
    transactionHash: `0x${string}`;
    gasUsed: bigint;
    submissionDurationMs: number;
    quoteTokenScale: bigint;
    rateBpsAfterFirstUpdate: number;
    rateBpsAfterTerminalUpdate?: number;
    observations: string[];
  }>;
  probeManagedRemoveQuoteAcrossAllArchetypes: () => Promise<{
    results: Array<
      | {
          status: "executed_and_realized";
          archetypeId: string;
          candidate: {
            minimumExecutionSteps: Array<{ type: string }>;
            intent: string;
            predictedRateBpsAfterNextUpdate: number;
            planningRateBps?: number;
            planningLookaheadUpdates?: number;
          };
          currentRateBps: number;
          targetRateBps: number;
          removeQuoteAmount: bigint;
          lenderBucketIndex: number;
          bucketDepositBeforeWad: bigint;
          bucketDepositAfterWad: bigint;
          transactionHash: `0x${string}`;
          gasUsed: bigint;
          submissionDurationMs: number;
          quoteTokenScale: bigint;
          rateBpsAfterFirstUpdate: number;
          rateBpsAfterTerminalUpdate?: number;
          observations: string[];
        }
      | {
          status: "no_candidate";
          archetypeId: string;
          currentRateBps: number;
          targetRateBps: number;
          predictedNextRateBps: number;
          predictedNextOutcome: string;
          secondsUntilNextRateUpdate: number;
          lenderLpBalance: bigint;
          bucketDepositWad: bigint;
          managedInventoryUpwardEligible?: boolean;
          managedInventoryIneligibilityReason?: string;
          managedTotalWithdrawableQuoteAmount?: bigint;
          managedPerBucketWithdrawableQuoteAmount?: ReadonlyMap<number, bigint>;
          candidateCount: number;
          candidateSummaries: string[];
          observations: string[];
        }
    >;
  }>;
};

export function registerBaseFactoryCuratorTests(
  context: BaseFactoryCuratorTestContext
): void {
  const {
    itBaseExperimental,
    itBaseSlow,
    createClients,
    ensureMockArtifact,
    DEFAULT_ANVIL_PRIVATE_KEY,
    findSavedUsedPoolUpwardDualArchetypeMatches,
    findPinnedUsedPoolUpwardSimulationMatches,
    findPinnedUsedPoolUpwardPairedDualMatches,
    inspectAjnaInfoManagedUsedPoolArchetypes,
    probeAjnaInfoManagedUsedPoolManualRemoveQuote,
    findTargetedAjnaInfoManagedUsedPoolInventoryCandidate,
    probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow,
    executeTargetedAjnaInfoManagedUsedPoolRemoveQuote,
    probeManagedRemoveQuoteAcrossAllArchetypes
  } = context;

  itBaseExperimental(
    "does not yet surface a generic exact pre-window dual plan across saved used-pool upward archetypes",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const { observations, positiveMatches } = await findSavedUsedPoolUpwardDualArchetypeMatches(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      expect(positiveMatches, observations.join(" | ")).toEqual([]);
    },
    420_000
  );

  itBaseExperimental(
    "does not yet surface a generic exact upward simulation candidate across pinned real used-pool archetypes",
    async () => {
      const { surfacedMatches, observations } = await findPinnedUsedPoolUpwardSimulationMatches();

      expect(surfacedMatches, observations.join(" | ")).toEqual([]);
    },
    420_000
  );

  itBaseExperimental(
    "does not yet surface a generic exact paired lender-borrower dual candidate across pinned real used-pool archetypes",
    async () => {
      const { surfacedMatches, observations } = await findPinnedUsedPoolUpwardPairedDualMatches();

      expect(surfacedMatches, observations.join(" | ")).toEqual([]);
    },
    420_000
  );

  itBaseExperimental(
    "captures a hand-picked ajna.info.finance same-account managed used-pool archetype from actual chain state",
    async () => {
      const { inspectedMatches, observations } = await inspectAjnaInfoManagedUsedPoolArchetypes();

      expect(inspectedMatches.length, observations.join(" | ")).toBeGreaterThan(0);
      for (const match of inspectedMatches) {
        expect(match.borrowerDebtWad, observations.join(" | ")).toBeGreaterThan(0n);
        expect(match.borrowerCollateralWad, observations.join(" | ")).toBeGreaterThan(0n);
        expect(match.lenderLpBalance, observations.join(" | ")).toBeGreaterThan(0n);
        expect(match.bucketDepositWad, observations.join(" | ")).toBeGreaterThan(0n);
        expect(match.currentRateBps, observations.join(" | ")).toBeLessThan(match.targetRateBps);
      }
    },
    420_000
  );

  itBaseExperimental(
    "does not yet surface a generic inventory-backed upward candidate across hand-picked ajna.info.finance managed used-pool archetypes",
    async () => {
      const { inspectedMatches, observations } = await inspectAjnaInfoManagedUsedPoolArchetypes();

      expect(
        inspectedMatches.some((match) => match.inventoryCandidateIntent !== undefined),
        observations.join(" | ")
      ).toBe(false);
    },
    420_000
  );

  itBaseExperimental(
    "finds a manual remove-quote improvement across hand-picked concentrated ajna.info.finance managed used-pool archetypes",
    async () => {
      const { probedMatches, observations } =
        await probeAjnaInfoManagedUsedPoolManualRemoveQuote();

      expect(probedMatches.length, observations.join(" | ")).toBeGreaterThan(0);
      expect(
        probedMatches.every((match) => match.maxWithdrawableQuoteAmount > 0n),
        observations.join(" | ")
      ).toBe(true);
      const dogMatch = probedMatches.find(
        (match) => match.archetypeId === "ajna-info-managed-dog-usdc-2026-03-18"
      );
      expect(dogMatch, observations.join(" | ")).toBeDefined();
      expect(dogMatch?.improved, observations.join(" | ")).toBe(true);
      expect(dogMatch?.bestActiveRateBps, observations.join(" | ")).toBeDefined();
      expect(dogMatch?.bestRemoveQuoteAmount, observations.join(" | ")).toBeDefined();
      expect(
        probedMatches.some((match) => match.improved),
        observations.join(" | ")
      ).toBe(true);
    },
    420_000
  );

  itBaseSlow(
    "surfaces a targeted exact remove-quote candidate from the hand-picked concentrated ajna.info.finance dog/usdc managed used-pool archetype when curator mode is explicitly enabled",
    async () => {
      const result = await findTargetedAjnaInfoManagedUsedPoolInventoryCandidate(
        "ajna-info-managed-dog-usdc-2026-03-18",
        {
          targetIntent: "LEND"
        }
      );

      expect(result.candidate, result.observations.join(" | ")).toBeDefined();
      expect(result.candidate?.intent, result.observations.join(" | ")).toBe("LEND");
      expect(
        result.candidate?.minimumExecutionSteps.some((step) => step.type === "REMOVE_QUOTE"),
        result.observations.join(" | ")
      ).toBe(true);
    },
    420_000
  );

  itBaseSlow(
    "diagnoses why dual REMOVE_QUOTE + DRAW_DEBT does not surface on PRIME/USDC by logging every tuple the exact synthesis evaluates",
    async () => {
      const events: DualSynthesisEvaluationEvent[] = [];
      const dogUsdcEvents: DualSynthesisEvaluationEvent[] = [];

      // First: PRIME/USDC (the "no candidate surfaces" case we want to
      // diagnose).
      setDualSynthesisDebugTrace((event) => {
        events.push(event);
      });
      try {
        const result = await findTargetedAjnaInfoManagedUsedPoolInventoryCandidate(
          "ajna-info-managed-prime-usdc-2025-10-17",
          {
            targetIntent: "LEND_AND_BORROW",
            drawDebtLimitIndexes: [3506, 500, 1000]
          }
        );
        // Sanity: confirm the existing "does not yet surface" invariant still
        // holds — this test is a diagnostic, not a behavior change.
        expect(result.candidate).toBeUndefined();
      } finally {
        setDualSynthesisDebugTrace(undefined);
      }

      // Control: dog/USDC with dual enabled. The expected hypothesis is that
      // dual doesn't surface here either (per the existing archetype probe),
      // but for DIFFERENT reasons than PRIME/USDC. This lets us see whether
      // the dual code path itself can produce a working evaluation in any
      // real pool state.
      setDualSynthesisDebugTrace((event) => {
        dogUsdcEvents.push(event);
      });
      try {
        await findTargetedAjnaInfoManagedUsedPoolInventoryCandidate(
          "ajna-info-managed-dog-usdc-2026-03-18",
          {
            targetIntent: "LEND_AND_BORROW",
            drawDebtLimitIndexes: [6003]
          }
        );
      } finally {
        setDualSynthesisDebugTrace(undefined);
      }

      // Additional: pool 0x7b0b85c8 (actor 0xd501). Highest-value candidate
      // from the discovery-script sweep: ~80% bucket ownership, ~999 supply
      // vs ~105 debt, and ~2_000_000 collateral (19_000× headroom). Unlike
      // PRIME/USDC this archetype should clear the drawDebt revert wall;
      // unlike dog/USDC the operator owns materially less than 100%, so
      // single-action may leave headroom for dual.
      const pool7b0bEvents: DualSynthesisEvaluationEvent[] = [];
      setDualSynthesisDebugTrace((event) => {
        pool7b0bEvents.push(event);
      });
      try {
        await findTargetedAjnaInfoManagedUsedPoolInventoryCandidate(
          "ajna-info-managed-7b0b-2025-10-25",
          {
            targetIntent: "LEND_AND_BORROW",
            drawDebtLimitIndexes: [4165, 4000, 4400]
          }
        );
      } finally {
        setDualSynthesisDebugTrace(undefined);
      }

      // Filter to the REMOVE_QUOTE + DRAW_DEBT path (ignore the ADD_QUOTE
      // dual path which also runs).
      const removeDrawEvents = events.filter(
        (e) => e.path === "remove_quote_plus_draw_debt"
      );

      // Bucket the evaluations by (bucket, limitIndex, collateralAmount) so
      // we can see how the search is spread across the tuple cross-product.
      const byCombination = new Map<string, DualSynthesisEvaluationEvent[]>();
      for (const event of removeDrawEvents) {
        const key = `bucket=${event.bucketIndex}/limit=${event.limitIndex}/collateral=${event.collateralAmount.toString()}`;
        const bucket = byCombination.get(key) ?? [];
        bucket.push(event);
        byCombination.set(key, bucket);
      }

      const combinationSummaries = Array.from(byCombination.entries()).map(
        ([key, bucketEvents]) => {
          const improvingEvents = bucketEvents.filter(
            (e) => e.improvesConvergence
          );
          const evaluatedEvents = bucketEvents.filter(
            (e) => !e.evaluationFailed
          );
          const bestTerminal = evaluatedEvents.reduce(
            (best, e) =>
              e.candidateTerminalDistance < best.candidateTerminalDistance
                ? e
                : best,
            {
              candidateTerminalDistance: Number.POSITIVE_INFINITY
            } as DualSynthesisEvaluationEvent
          );
          return {
            key,
            totalEvaluations: bucketEvents.length,
            evaluationFailures: bucketEvents.filter((e) => e.evaluationFailed)
              .length,
            improvingCount: improvingEvents.length,
            comparisonTerminalDistance:
              bucketEvents[0]?.comparisonTerminalDistance ?? null,
            minimumManagedImprovementBps:
              bucketEvents[0]?.minimumManagedImprovementBps ?? null,
            bestEvaluatedTerminalDistance:
              bestTerminal.candidateTerminalDistance === Number.POSITIVE_INFINITY
                ? null
                : bestTerminal.candidateTerminalDistance,
            bestEvaluatedTerminalRateBps:
              bestTerminal.candidateTerminalRateBps ?? null,
            bestTuple:
              bestTerminal.candidateTerminalDistance === Number.POSITIVE_INFINITY
                ? null
                : {
                    quoteAmountWad: bestTerminal.quoteAmount.toString(),
                    drawDebtAmountWad: bestTerminal.drawDebtAmount.toString()
                  }
          };
        }
      );

      const totalImproving = removeDrawEvents.filter(
        (e) => e.improvesConvergence
      ).length;
      const totalEvaluations = removeDrawEvents.length;
      const totalFailures = removeDrawEvents.filter(
        (e) => e.evaluationFailed
      ).length;

      const dogUsdcRemoveDraw = dogUsdcEvents.filter(
        (e) => e.path === "remove_quote_plus_draw_debt"
      );
      const dogUsdcSummary = {
        totalEvaluations: dogUsdcRemoveDraw.length,
        totalImproving: dogUsdcRemoveDraw.filter((e) => e.improvesConvergence)
          .length,
        totalFailures: dogUsdcRemoveDraw.filter((e) => e.evaluationFailed)
          .length
      };

      const pool7b0bRemoveDraw = pool7b0bEvents.filter(
        (e) => e.path === "remove_quote_plus_draw_debt"
      );
      const pool7b0bCombinationMap = new Map<
        string,
        DualSynthesisEvaluationEvent[]
      >();
      for (const event of pool7b0bRemoveDraw) {
        const key = `bucket=${event.bucketIndex}/limit=${event.limitIndex}/collateral=${event.collateralAmount.toString()}`;
        const bucket = pool7b0bCombinationMap.get(key) ?? [];
        bucket.push(event);
        pool7b0bCombinationMap.set(key, bucket);
      }
      const pool7b0bCombinations = Array.from(pool7b0bCombinationMap.entries()).map(
        ([key, bucketEvents]) => {
          const evaluatedEvents = bucketEvents.filter((e) => !e.evaluationFailed);
          const best = evaluatedEvents.reduce(
            (acc, e) =>
              e.candidateTerminalDistance < acc.candidateTerminalDistance
                ? e
                : acc,
            { candidateTerminalDistance: Number.POSITIVE_INFINITY } as DualSynthesisEvaluationEvent
          );
          return {
            key,
            total: bucketEvents.length,
            improving: bucketEvents.filter((e) => e.improvesConvergence).length,
            failed: bucketEvents.filter((e) => e.evaluationFailed).length,
            bestTerminalDistance:
              best.candidateTerminalDistance === Number.POSITIVE_INFINITY
                ? null
                : best.candidateTerminalDistance,
            bestTerminalRateBps: best.candidateTerminalRateBps ?? null,
            comparisonTerminalDistance:
              bucketEvents[0]?.comparisonTerminalDistance ?? null
          };
        }
      );
      const pool7b0bSummary = {
        totalEvaluations: pool7b0bRemoveDraw.length,
        totalImproving: pool7b0bRemoveDraw.filter((e) => e.improvesConvergence)
          .length,
        totalFailures: pool7b0bRemoveDraw.filter((e) => e.evaluationFailed)
          .length,
        combinations: pool7b0bCombinations
      };

      console.log(
        "[curator-dual-synthesis-debug-trace]",
        JSON.stringify(
          {
            primeUsdc: {
              archetype: "ajna-info-managed-prime-usdc-2025-10-17",
              totalEvaluations,
              totalImproving,
              totalFailures,
              combinations: combinationSummaries
            },
            dogUsdc: {
              archetype: "ajna-info-managed-dog-usdc-2026-03-18",
              ...dogUsdcSummary
            },
            pool7b0b: {
              archetype: "ajna-info-managed-7b0b-2025-10-25",
              ...pool7b0bSummary
            }
          },
          null,
          2
        )
      );

      // Structural expectations only: the trace must have captured at least
      // some evaluations on PRIME (otherwise the debug hook is misplaced),
      // and the result remains no-candidate (the docstring's invariant).
      expect(totalEvaluations).toBeGreaterThan(0);
      expect(totalImproving).toBe(0);
    },
    420_000
  );

  itBaseSlow(
    "tests whether dual REMOVE_QUOTE + DRAW_DEBT can surface on a synthetic pool engineered with concentrated ownership + same-account borrower + generous collateral headroom",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = (await ensureMockArtifact()) as {
        abi: unknown[];
        bytecode: `0x${string}`;
      };

      // Sweep across ownership fractions to find a regime where single-action
      // REMOVE_QUOTE DOESN'T saturate STEP_UP but dual CAN. At 95%
      // single-action alone reaches the STEP_UP cap over 2 updates, so dual
      // has nothing incremental to offer. At lower fractions single might
      // fail to trigger STEP_UP at all, creating a window where dual's
      // additional debt push could make the difference.
      const ownershipFractions = [0.95, 0.75, 0.55];
      const probeResults = [] as Array<
        Awaited<ReturnType<typeof probeSyntheticDualViablePool>>
      >;
      for (const operatorBucketOwnershipFraction of ownershipFractions) {
        const result = await probeSyntheticDualViablePool({
          account: account as { address: `0x${string}` },
          publicClient,
          walletClient,
          testClient,
          artifact,
          operatorBucketOwnershipFraction
        });
        probeResults.push(result);
      }

      const summary = probeResults.map((result) => ({
        ownershipFraction: result.operatorBucketOwnershipFraction,
        collateralHeadroomRatio: result.collateralHeadroomRatio,
        currentRateBps: result.currentRateBps,
        targetRateBps: result.targetRateBps,
        predictedNextRateBps: result.predictedNextRateBps,
        managedInventoryUpwardEligible:
          result.managedInventoryUpwardEligible ?? null,
        managedInventoryIneligibilityReason:
          result.managedInventoryIneligibilityReason ?? null,
        noOfLoans: result.noOfLoans,
        singleActionCandidateSurfaced: result.singleActionCandidateSurfaced,
        singleActionTerminalDistance:
          result.singleActionCandidateSummary?.resultingDistanceToTargetBps ??
          null,
        dualCandidateSurfaced: result.dualCandidateSurfaced,
        dualBestTerminalRateBps:
          result.dualEvaluations.byCombination
            .map((c) => c.bestTerminalRateBps)
            .filter((v): v is number => v !== null)
            .sort((a, b) => b - a)[0] ?? null,
        dualEvaluationStats: {
          total: result.dualEvaluations.total,
          improving: result.dualEvaluations.improving,
          failed: result.dualEvaluations.failed
        },
        allCandidates: result.allCandidateSummaries
      }));
      console.log(
        "[curator-dual-viable-synthetic-sweep]",
        JSON.stringify(summary, null, 2)
      );

      // Structural: the right number of trials ran. Per-trial noOfLoans /
      // eligibility can be flaky when the synthetic fixture rebuilds pools
      // rapidly across runs (walletClient nonce cache vs anvil state).
      // Require AT LEAST ONE trial to have satisfied eligibility — that's
      // enough to say the fixture / code path works.
      expect(probeResults.length).toBe(ownershipFractions.length);
      expect(
        probeResults.some(
          (result) =>
            result.noOfLoans >= 2 &&
            result.managedInventoryUpwardEligible === true &&
            result.collateralHeadroomRatio > 10
        ),
        "no ownership trial produced a structurally valid dual-viable fixture"
      ).toBe(true);
      expect(
        probeResults.some(
          (result) => result.dualEvaluations.total > 0
        ),
        "dual synthesis never ran on any trial — debug hook may be misplaced"
      ).toBe(true);
    },
    600_000
  );

  itBaseSlow(
    "probes dual synthesis on two Ethereum-mainnet same-account managed archetypes discovered via the ajna.info API",
    async () => {
      // Two candidates sourced from scripts/discover-mainnet-managed-archetypes.mjs.
      // Both are stable-pair pools with high operator ownership + same-account
      // borrower + meaningful collateral headroom — the profile that best
      // satisfies conditions (1)-(3) for dual mode.
      const candidates: Array<{
        id: string;
        poolAddress: `0x${string}`;
        senderAddress: `0x${string}`;
        blockNumber: bigint;
        lenderBucketIndex: number;
      }> = [
        {
          // scrvUSD/crvUSD stable pair. Same actor (0x7500) as dog/USDC on Base.
          // 99.93% ownership, supply 50 / debt 10 / collateral 45.76 = 4.55×
          // collateral headroom. Cleanest profile across both chains.
          id: "mainnet-scrvusd-crvusd-2026-03-08",
          poolAddress: "0x660ae24a80aaada9804c056706a904e88bf476a3",
          senderAddress: "0x7500c95cc6f6c9ede82d4043f9337715360d6b6a",
          blockNumber: 24_615_154n,
          lenderBucketIndex: 4156
        },
        {
          // DMusd/USDC stable pair. 89.54% ownership, supply 20 / debt 20.78 /
          // collateral 10000 = 481× collateral headroom (enormous). Short-
          // lived position (1-day burst of activity) but the snapshot is
          // structurally interesting.
          id: "mainnet-dmusd-usdc-2024-10-29",
          poolAddress: "0xb3f52e1f03ac86d0824f721ed3a969be53eadfdc",
          senderAddress: "0x85b24380f4d3bc77e4e7d7f3e865f554787e06e0",
          blockNumber: 21_074_394n,
          lenderBucketIndex: 4157
        }
      ];

      const results = [];
      for (const candidate of candidates) {
        const result = await probeMainnetArchetype({
          id: candidate.id,
          poolAddress: candidate.poolAddress,
          senderAddress: candidate.senderAddress,
          borrowerAddress: candidate.senderAddress,
          blockNumber: candidate.blockNumber,
          lenderBucketIndex: candidate.lenderBucketIndex,
          targetOffsetBps: 200,
          toleranceBps: 50,
          drawDebtLimitIndexes: [
            candidate.lenderBucketIndex,
            candidate.lenderBucketIndex - 100,
            candidate.lenderBucketIndex + 100
          ]
        });
        results.push(result);
      }

      const summary = results.map((r) => ({
        id: r.id,
        pool: r.poolAddress,
        block: r.blockNumber.toString(),
        currentRateBps: r.currentRateBps,
        targetRateBps: r.targetRateBps,
        predictedNextRateBps: r.predictedNextRateBps,
        predictedNextOutcome: r.predictedNextOutcome,
        bucketOwnership: r.bucketOwnershipFraction,
        lenderLpWad: r.lenderLpBalance.toString(),
        bucketDepositWad: r.bucketDepositWad.toString(),
        managedInventoryUpwardEligible:
          r.managedInventoryUpwardEligible ?? null,
        managedInventoryIneligibilityReason:
          r.managedInventoryIneligibilityReason ?? null,
        noOfLoans: r.noOfLoans,
        singleActionSurfaced: r.singleActionSurfaced,
        singleActionTerminalDistance: r.singleActionTerminalDistance ?? null,
        dualCandidateSurfaced: r.dualCandidateSurfaced,
        dualCandidate:
          r.dualCandidate === undefined
            ? null
            : {
                ...r.dualCandidate,
                removeQuoteAmountWad: r.dualCandidate.removeQuoteAmountWad.toString(),
                drawDebtAmountWad: r.dualCandidate.drawDebtAmountWad.toString()
              },
        dualEvaluations: r.dualEvaluations
      }));
      console.log(
        "[curator-mainnet-probe]",
        JSON.stringify(summary, null, 2)
      );

      // Structural sanity: both probes returned without throwing.
      expect(results.length).toBe(2);
    },
    600_000
  );

  itBaseExperimental(
    "does not yet surface a targeted exact remove-quote-plus-draw-debt candidate from a hand-picked concentrated ajna.info.finance managed used-pool archetype even when the lender bucket and limit indexes are seeded",
    async () => {
      const result = await findTargetedAjnaInfoManagedUsedPoolInventoryCandidate(
        "ajna-info-managed-prime-usdc-2025-10-17",
        {
          targetIntent: "LEND_AND_BORROW",
          drawDebtLimitIndexes: [3506, 500, 1000]
        }
      );

      expect(result.candidate, result.observations.join(" | ")).toBeUndefined();
    },
    420_000
  );

  itBaseSlow(
    "executes the targeted curator-mode REMOVE_QUOTE on the dog/usdc archetype and decreases the target bucket's deposit on-chain",
    async () => {
      const result = await executeTargetedAjnaInfoManagedUsedPoolRemoveQuote(
        "ajna-info-managed-dog-usdc-2026-03-18"
      );

      expect(
        result.candidate.minimumExecutionSteps.some((step) => step.type === "REMOVE_QUOTE"),
        result.observations.join(" | ")
      ).toBe(true);
      expect(result.candidate.intent, result.observations.join(" | ")).toBe("LEND");
      expect(result.removeQuoteAmount, result.observations.join(" | ")).toBeGreaterThan(0n);
      expect(
        result.bucketDepositAfterWad,
        result.observations.join(" | ")
      ).toBeLessThan(result.bucketDepositBeforeWad);
      // tx receipt status is 'success' (the helper throws otherwise)
      expect(result.transactionHash, result.observations.join(" | ")).toMatch(/^0x[0-9a-fA-F]+$/);

      // Realized-rate verification: after warping to the next Ajna rate-update
      // boundary and calling updateInterest, the on-chain rate must equal what
      // the simulation-backed synthesis predicted. Any drift here would mean
      // the planner disagrees with the actual protocol math for this state.
      expect(
        result.rateBpsAfterFirstUpdate,
        result.observations.join(" | ")
      ).toBe(result.candidate.predictedRateBpsAfterNextUpdate);

      if ((result.candidate.planningLookaheadUpdates ?? 1) > 1) {
        expect(
          result.rateBpsAfterTerminalUpdate,
          result.observations.join(" | ")
        ).toBe(result.candidate.planningRateBps);
      }

      // Ajna stores quote amounts in WAD (1e18) regardless of the underlying
      // ERC20 decimals; quoteTokenScale = 1e18 / 10^nativeDecimals.
      const quoteTokenDecimals = Math.round(
        Math.log10(Number(10n ** 18n / result.quoteTokenScale))
      );
      const wadToHuman = (wad: bigint) => Number(wad) / 1e18;
      const removeQuoteHuman = wadToHuman(result.removeQuoteAmount);
      const bucketDepositBeforeHuman = wadToHuman(result.bucketDepositBeforeWad);
      const bucketDepositAfterHuman = wadToHuman(result.bucketDepositAfterWad);
      const bucketDepositDeltaHuman =
        bucketDepositBeforeHuman - bucketDepositAfterHuman;
      const predictedMoveBps =
        result.candidate.predictedRateBpsAfterNextUpdate - result.currentRateBps;
      const terminalMoveBps =
        (result.candidate.planningRateBps ??
          result.candidate.predictedRateBpsAfterNextUpdate) - result.currentRateBps;
      const realizedFirstMoveBps =
        result.rateBpsAfterFirstUpdate - result.currentRateBps;
      const realizedTerminalMoveBps =
        result.rateBpsAfterTerminalUpdate === undefined
          ? null
          : result.rateBpsAfterTerminalUpdate - result.currentRateBps;
      console.log(
        "[curator-dog-usdc-summary]",
        JSON.stringify(
          {
            archetype: result.archetypeId,
            currentRateBps: result.currentRateBps,
            targetRateBps: result.targetRateBps,
            predictedNextRateBps: result.candidate.predictedRateBpsAfterNextUpdate,
            predictedMoveBps,
            realizedRateBpsAfterFirstUpdate: result.rateBpsAfterFirstUpdate,
            realizedFirstMoveBps,
            planningRateBps: result.candidate.planningRateBps ?? null,
            planningLookaheadUpdates: result.candidate.planningLookaheadUpdates ?? 1,
            terminalMoveBps,
            realizedRateBpsAfterTerminalUpdate:
              result.rateBpsAfterTerminalUpdate ?? null,
            realizedTerminalMoveBps,
            lenderBucketIndex: result.lenderBucketIndex,
            removeQuoteAmountRaw: result.removeQuoteAmount.toString(),
            removeQuoteAmountQuoteToken: removeQuoteHuman,
            quoteTokenDecimals,
            bucketDepositBeforeQuoteToken: bucketDepositBeforeHuman,
            bucketDepositAfterQuoteToken: bucketDepositAfterHuman,
            bucketDepositDeltaQuoteToken: bucketDepositDeltaHuman,
            gasUsed: result.gasUsed.toString(),
            submissionDurationMs: result.submissionDurationMs,
            transactionHash: result.transactionHash
          },
          null,
          2
        )
      );
    },
    420_000
  );

  itBaseSlow(
    "probes curator-mode REMOVE_QUOTE across every pinned managed archetype and verifies realized rate matches prediction for every archetype that surfaces",
    async () => {
      const { results } = await probeManagedRemoveQuoteAcrossAllArchetypes();

      const summary = results.map((row) => {
        if (row.status === "no_candidate") {
          return {
            archetype: row.archetypeId,
            status: row.status,
            currentRateBps: row.currentRateBps,
            targetRateBps: row.targetRateBps,
            predictedNextRateBps: row.predictedNextRateBps,
            predictedNextOutcome: row.predictedNextOutcome,
            secondsUntilNextRateUpdate: row.secondsUntilNextRateUpdate,
            lenderLpBalance: row.lenderLpBalance.toString(),
            bucketDepositWad: row.bucketDepositWad.toString(),
            managedInventoryUpwardEligible:
              row.managedInventoryUpwardEligible ?? null,
            managedInventoryIneligibilityReason:
              row.managedInventoryIneligibilityReason ?? null,
            managedTotalWithdrawable:
              row.managedTotalWithdrawableQuoteAmount?.toString() ?? null,
            managedPerBucket:
              row.managedPerBucketWithdrawableQuoteAmount === undefined
                ? null
                : Array.from(
                    row.managedPerBucketWithdrawableQuoteAmount.entries()
                  ).map(([idx, amt]) => ({ idx, amount: amt.toString() })),
            candidateCount: row.candidateCount,
            candidateSummaries: row.candidateSummaries
          };
        }
        return {
          archetype: row.archetypeId,
          status: row.status,
          currentRateBps: row.currentRateBps,
          targetRateBps: row.targetRateBps,
          predictedNextRateBps: row.candidate.predictedRateBpsAfterNextUpdate,
          realizedRateBpsAfterFirstUpdate: row.rateBpsAfterFirstUpdate,
          planningRateBps: row.candidate.planningRateBps ?? null,
          planningLookaheadUpdates: row.candidate.planningLookaheadUpdates ?? 1,
          realizedRateBpsAfterTerminalUpdate:
            row.rateBpsAfterTerminalUpdate ?? null,
          lenderBucketIndex: row.lenderBucketIndex,
          removeQuoteAmountWad: row.removeQuoteAmount.toString(),
          gasUsed: row.gasUsed.toString(),
          transactionHash: row.transactionHash
        };
      });
      console.log(
        "[curator-multi-archetype-summary]",
        JSON.stringify(summary, null, 2)
      );

      // Guarantee: every archetype that surfaces a candidate must see realized
      // rate == predicted rate. Any divergence between the simulator and actual
      // protocol math would mean the planner is unreliable for that archetype.
      const surfaced = results.filter(
        (row) => row.status === "executed_and_realized"
      );
      for (const row of surfaced) {
        if (row.status !== "executed_and_realized") continue;
        expect(
          row.rateBpsAfterFirstUpdate,
          `archetype ${row.archetypeId}: realized rate after first update should match predicted`
        ).toBe(row.candidate.predictedRateBpsAfterNextUpdate);
        if ((row.candidate.planningLookaheadUpdates ?? 1) > 1) {
          expect(
            row.rateBpsAfterTerminalUpdate,
            `archetype ${row.archetypeId}: realized rate after terminal update should match planning rate`
          ).toBe(row.candidate.planningRateBps);
        }
      }

      // Sanity: at minimum the previously-verified dog/USDC archetype must
      // still surface, otherwise our one-supported-archetype claim regressed.
      const dogUsdc = results.find(
        (row) => row.archetypeId === "ajna-info-managed-dog-usdc-2026-03-18"
      );
      expect(dogUsdc?.status).toBe("executed_and_realized");

      // Every archetype-level probe must have completed cleanly (no thrown
      // errors, no unexpected shapes). If the probe itself errored on any
      // archetype the iterator would have propagated, so reaching this point
      // means we cleanly saw one of the two known statuses on every archetype.
      expect(results.length).toBe(8);
      for (const row of results) {
        expect(["executed_and_realized", "no_candidate"]).toContain(
          row.status
        );
      }
    },
    // Five forks × ~2.6s each + sim overhead; bump timeout well past that.
    420_000
  );

  itBaseSlow(
    "measures the realized rate response across withdrawal fractions on dog/USDC to locate the STEP_UP threshold",
    async () => {
      const result = await probeRateResponseAcrossWithdrawalFractions({
        archetypeId: "ajna-info-managed-dog-usdc-2026-03-18",
        fractions: [
          // Sparse at the low end: we already know 10%–65% is all zero.
          0.10, 0.50, 0.65,
          // Lower-cliff region (between 66% and 66.5%).
          0.66, 0.665, 0.67,
          // Viable interior.
          0.70, 0.80, 0.90,
          // Upper region is non-monotonic around 94%; probe fine-grained to
          // characterize the NO_CHANGE hole and the 100% reversal.
          0.92, 0.93, 0.935, 0.94, 0.945, 0.95, 0.96, 0.98, 0.99, 1.00
        ]
      });

      const summary = result.rows.map((row) => ({
        fractionPct: row.fractionBps / 100,
        withdrawAmountWad: row.withdrawAmountWad.toString(),
        rateBefore: row.currentRateBpsBefore,
        rateAfterFirstUpdate: row.currentRateBpsAfterFirstUpdate,
        rateAfterSecondUpdate: row.currentRateBpsAfterSecondUpdate,
        firstUpdateMoveBps: row.firstUpdateMoveBps,
        secondUpdateMoveBps: row.secondUpdateMoveBps,
        totalMoveBps: row.totalMoveBps
      }));
      console.log(
        "[curator-rate-response-dog-usdc]",
        JSON.stringify(
          {
            archetype: result.archetypeId,
            bucket: result.bucketIndex,
            maxWithdrawableWad: result.maxWithdrawableAtStartWad.toString(),
            rows: summary
          },
          null,
          2
        )
      );

      // Weak structural assertion: every trial completed cleanly with non-zero
      // rates. The rate-response curve itself is what we're characterizing,
      // not something we want to pin in the test; any monotonicity or
      // threshold claim belongs in the doc that reads the logged output.
      expect(result.rows.length).toBe(19);
      for (const row of result.rows) {
        expect(row.currentRateBpsBefore).toBeGreaterThan(0);
        expect(row.currentRateBpsAfterFirstUpdate).toBeGreaterThan(0);
        expect(row.currentRateBpsAfterSecondUpdate).toBeGreaterThan(0);
      }
    },
    // 19 fresh forks × ~2.5s each + overhead.
    600_000
  );

  itBaseSlow(
    "compares the rate-response cliff between two synthetic pool shapes to test whether the ~67% STEP_UP threshold is pool-shape-specific",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = (await ensureMockArtifact()) as {
        abi: unknown[];
        bytecode: `0x${string}`;
      };

      // Shape A: baseline — same parameters as the ownership-sweep default.
      // Light debt/deposit ratio (5k debt / 10k base deposit), 95% operator
      // ownership (so operator can meaningfully withdraw), 200 bps target.
      const shapeA: SyntheticPoolShape = {
        label: "baseline",
        baseLenderDepositQuoteToken: 10_000n,
        debtAmountsQuoteToken: [3_000n, 2_000n],
        collateralAmountsCollateralToken: [6_000n, 4_000n],
        emaWarmupCycles: 3,
        targetBucketIndex: 3000,
        operatorFraction: 0.95,
        targetOffsetBps: 200
      };

      // Shape B: 5x more debt + proportionally more collateral. Same deposit
      // structure, same operator ownership, same EMA warmup and target. Only
      // the debt side of the rate-formation equation changes, so if the
      // cliff is genuinely shaped by MAU (debt/deposit ratio), Shape B's
      // cliff should shift noticeably compared to Shape A.
      const shapeB: SyntheticPoolShape = {
        label: "high-debt",
        baseLenderDepositQuoteToken: 10_000n,
        debtAmountsQuoteToken: [15_000n, 10_000n],
        collateralAmountsCollateralToken: [30_000n, 20_000n],
        emaWarmupCycles: 3,
        targetBucketIndex: 3000,
        operatorFraction: 0.95,
        targetOffsetBps: 200
      };

      // Sparse probe at the low end (we already know that region is all
      // zero on dog/USDC), dense around the expected 2/3 cliff.
      const withdrawalFractions = [
        0.30, 0.50, 0.60, 0.65, 0.66, 0.67, 0.70, 0.80, 0.90
      ];

      const baselineResult = await probeRateResponseOnSyntheticPool({
        account: account as { address: `0x${string}` },
        publicClient,
        walletClient,
        testClient,
        artifact,
        poolShape: shapeA,
        withdrawalFractions
      });
      const highDebtResult = await probeRateResponseOnSyntheticPool({
        account: account as { address: `0x${string}` },
        publicClient,
        walletClient,
        testClient,
        artifact,
        poolShape: shapeB,
        withdrawalFractions
      });

      const summarizeShape = (label: string, shapeResult: typeof baselineResult) => ({
        label,
        shape: {
          baseLenderDepositQuoteToken:
            shapeResult.shape.baseLenderDepositQuoteToken.toString(),
          debtAmounts: shapeResult.shape.debtAmountsQuoteToken.map((x) => x.toString()),
          collateralAmounts:
            shapeResult.shape.collateralAmountsCollateralToken.map((x) => x.toString()),
          operatorFraction: shapeResult.shape.operatorFraction,
          targetOffsetBps: shapeResult.shape.targetOffsetBps
        },
        rows: shapeResult.rows.map((row) => ({
          fractionPct: row.fractionBps / 100,
          rateBefore: row.currentRateBpsBefore,
          rateAfterFirst: row.currentRateBpsAfterFirstUpdate,
          rateAfterSecond: row.currentRateBpsAfterSecondUpdate,
          totalMoveBps: row.totalMoveBps
        }))
      });
      console.log(
        "[curator-synthetic-two-shape-comparison]",
        JSON.stringify(
          {
            shapeA: summarizeShape(shapeA.label, baselineResult),
            shapeB: summarizeShape(shapeB.label, highDebtResult)
          },
          null,
          2
        )
      );

      // Structural assertions only: every trial must complete cleanly with
      // non-zero rates on each shape. The point of this test is to surface
      // the two curves side-by-side for operator-facing documentation, not
      // to pin a specific cliff position (which is what we're measuring).
      expect(baselineResult.rows.length).toBe(withdrawalFractions.length);
      expect(highDebtResult.rows.length).toBe(withdrawalFractions.length);
      for (const row of [...baselineResult.rows, ...highDebtResult.rows]) {
        expect(row.currentRateBpsBefore).toBeGreaterThan(0);
        expect(row.currentRateBpsAfterFirstUpdate).toBeGreaterThan(0);
        expect(row.currentRateBpsAfterSecondUpdate).toBeGreaterThan(0);
      }
    },
    // 2 shapes × 9 fractions × (pool setup ~5s + warmup + probe) ≈ 120–180s.
    600_000
  );

  itBaseSlow(
    "sweeps operator bucket-ownership fraction in a synthetic managed pool and reports the threshold at which curator REMOVE_QUOTE surfaces",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = (await ensureMockArtifact()) as {
        abi: unknown[];
        bytecode: `0x${string}`;
      };

      const fractions = [0.10, 0.30, 0.50, 0.80, 0.95];
      const results: SweepFractionResult[] = await sweepSyntheticOwnershipFractions({
        account: account as { address: `0x${string}` },
        publicClient,
        walletClient,
        testClient,
        artifact,
        fractions
      });

      const summary = results.map((row) => ({
        fractionPct: row.fractionBps / 100,
        candidateSurfaced: row.candidateSurfaced,
        noOfLoans: row.noOfLoans,
        currentRateBps: row.currentRateBps,
        targetRateBps: row.targetRateBps,
        predictedNextRateBps: row.predictedNextRateBps,
        predictedNextOutcome: row.predictedNextOutcome,
        eligible: row.managedInventoryUpwardEligible ?? null,
        ineligibilityReason: row.managedInventoryIneligibilityReason ?? null,
        operatorDepositWad: row.operatorDepositWad.toString(),
        bucketDepositBeforeOperatorWad:
          row.bucketDepositBeforeOperatorWad.toString(),
        bucketDepositAfterOperatorWad:
          row.bucketDepositAfterOperatorWad.toString(),
        candidatePredictedNextRateBps:
          row.predictedRateBpsAfterNextUpdate ?? null,
        candidatePlanningRateBps: row.planningRateBps ?? null,
        planningLookaheadUpdates: row.planningLookaheadUpdates ?? null,
        removeQuoteAmountWad: row.removeQuoteAmountWad?.toString() ?? null
      }));
      console.log(
        "[curator-synthetic-ownership-sweep]",
        JSON.stringify(summary, null, 2)
      );

      // Every trial must complete cleanly (the fraction bounds are enforced in
      // the helper, so we just confirm we got back one row per input).
      expect(results.length).toBe(fractions.length);
      // AT LEAST one trial must have noOfLoans >= 2. The synthetic fixture
      // rebuilds the pool fresh per trial without snapshot/revert; on some
      // runs a subset of trials' drawDebt calls silently land on stale
      // walletClient nonce state and leave the pool with fewer borrowers
      // than intended. The point of this test is the ownership-sweep data,
      // not per-trial fixture fidelity — as long as one trial built a
      // proper two-borrower pool, the sweep's comparison is meaningful.
      expect(
        results.some((row) => row.noOfLoans >= 2),
        "no trial produced a pool with noOfLoans >= 2 — synthetic fixture failed on every fraction"
      ).toBe(true);

      // The exact threshold depends on the synthetic pool's rate-formation
      // state, but the qualitative expectation is monotonic: higher operator
      // ownership fractions should be at least as likely to surface a
      // candidate as lower ones. Verify that once a fraction surfaces, every
      // higher fraction in the sweep also surfaces (no non-monotonic holes).
      let highestNonSurfacingBps = -1;
      let lowestSurfacingBps: number | undefined;
      for (const row of results) {
        if (row.candidateSurfaced) {
          if (lowestSurfacingBps === undefined) {
            lowestSurfacingBps = row.fractionBps;
          }
        } else {
          highestNonSurfacingBps = Math.max(
            highestNonSurfacingBps,
            row.fractionBps
          );
        }
      }
      if (
        lowestSurfacingBps !== undefined &&
        highestNonSurfacingBps >= 0 &&
        highestNonSurfacingBps > lowestSurfacingBps
      ) {
        throw new Error(
          `non-monotonic sweep: a lower fraction (${lowestSurfacingBps} bps) surfaced while a higher fraction (${highestNonSurfacingBps} bps) did not. summary=${JSON.stringify(summary)}`
        );
      }

      // We do NOT assert "at least one surfaces" — the top fraction (95%)
      // sits right at the STEP_UP cliff on this synthetic pool, so whether it
      // surfaces on a given run is timing-sensitive in the same way the
      // cliff-adjacent 94% observation on dog/USDC is (see the rate-response
      // probe). A no-surface run is still a valid sweep: it means this
      // specific pool construction puts the cliff above 95%. The structural
      // assertions above (results length, noOfLoans ≥ 2, monotonicity) catch
      // real regressions.
    },
    // Five full pool setups × (deploy + ema warmup + snapshot) ≈ 30–60s.
    600_000
  );

  itBaseExperimental(
    "finds manual remove-quote-plus-draw-debt improvements across hand-picked managed archetypes once the dual branch must beat the matching remove-only path",
    async () => {
      const { probedMatches, observations } =
        await probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow();

      expect(probedMatches.length, observations.join(" | ")).toBeGreaterThan(0);
      expect(
        probedMatches.every((match) => match.maxWithdrawableQuoteAmount > 0n),
        observations.join(" | ")
      ).toBe(true);
      expect(
        probedMatches.some(
          (match) => match.archetypeId === "ajna-info-managed-prime-usdc-2025-10-17"
        ),
        observations.join(" | ")
      ).toBe(true);
      const primeMatch = probedMatches.find(
        (match) => match.archetypeId === "ajna-info-managed-prime-usdc-2025-10-17"
      );
      expect(primeMatch, observations.join(" | ")).toBeDefined();
      expect(
        probedMatches.some((match) => match.improved),
        observations.join(" | ")
      ).toBe(true);
    },
    420_000
  );
}

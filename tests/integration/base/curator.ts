import { expect } from "vitest";

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
    executeTargetedAjnaInfoManagedUsedPoolRemoveQuote
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

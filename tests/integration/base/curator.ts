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
    probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow
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
    "surfaces a targeted exact remove-quote candidate from the hand-picked concentrated ajna.info.finance dog/usdc managed used-pool archetype when the lender bucket is seeded",
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

import { expect } from "vitest";

type RegisterTest = (
  name: string,
  testFn: () => Promise<void> | void,
  timeout?: number
) => void;

type BaseFactoryBorrowerTestContext = {
  itBaseExperimental: RegisterTest;
  createClients: () => {
    account: any;
    publicClient: any;
    walletClient: any;
    testClient: any;
  };
  createClientsForPrivateKey: (privateKey: `0x${string}`) => {
    account: any;
    publicClient: any;
    walletClient: any;
    testClient: any;
  };
  ensureMockArtifact: () => Promise<any>;
  DEFAULT_ANVIL_PRIVATE_KEY: string;
  COMPETING_ANVIL_PRIVATE_KEY: `0x${string}`;
  EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_SCENARIOS: any;
  EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_CONFIG_CANDIDATES: any;
  findExistingBorrowerPreWindowBorrowMatch: (...args: any[]) => Promise<any>;
  findComplexOngoingPreWindowBorrowMatch: (...args: any[]) => Promise<any>;
  findManualComplexOngoingPreWindowBorrowMatch: (
    ...args: any[]
  ) => Promise<{ positiveMatch: any; observations: string[] }>;
  findManualExistingBorrowerPreWindowBorrowImprovement: (
    ...args: any[]
  ) => Promise<{ positiveMatch: any; observations: string[] }>;
  findManualMultiBucketExistingBorrowerPreWindowBorrowImprovement: (
    ...args: any[]
  ) => Promise<{ positiveMatch: any }>;
  findBoundaryDerivedExistingBorrowerPreWindowBorrowImprovement: (
    ...args: any[]
  ) => Promise<{ positiveMatch: any; observations: string[] }>;
  findBoundaryDiscoveredBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement: (
    ...args: any[]
  ) => Promise<any>;
  findManualBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement: (
    ...args: any[]
  ) => Promise<any>;
  findManualBrandNewFirstUpdateSameCycleBorrowImprovement: (...args: any[]) => Promise<any>;
  findManualBrandNewSameCycleBorrowImprovement: (...args: any[]) => Promise<any>;
  findExistingBorrowerSameCycleBorrowMatch: (...args: any[]) => Promise<any>;
  findManualExistingBorrowerSameCycleBorrowImprovement: (...args: any[]) => Promise<any>;
  findBoundaryTargetedManualSameCycleBorrowMatch: (...args: any[]) => Promise<any>;
};

export function registerBaseFactoryBorrowerTests(
  context: BaseFactoryBorrowerTestContext
): void {
  const {
    itBaseExperimental,
    createClients,
    createClientsForPrivateKey,
    ensureMockArtifact,
    DEFAULT_ANVIL_PRIVATE_KEY,
    COMPETING_ANVIL_PRIVATE_KEY,
    EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_SCENARIOS,
    EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_CONFIG_CANDIDATES,
    findExistingBorrowerPreWindowBorrowMatch,
    findComplexOngoingPreWindowBorrowMatch,
    findManualComplexOngoingPreWindowBorrowMatch,
    findManualExistingBorrowerPreWindowBorrowImprovement,
    findManualMultiBucketExistingBorrowerPreWindowBorrowImprovement,
    findBoundaryDerivedExistingBorrowerPreWindowBorrowImprovement,
    findBoundaryDiscoveredBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement,
    findManualBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement,
    findManualBrandNewFirstUpdateSameCycleBorrowImprovement,
    findManualBrandNewSameCycleBorrowImprovement,
    findExistingBorrowerSameCycleBorrowMatch,
    findManualExistingBorrowerSameCycleBorrowImprovement,
    findBoundaryTargetedManualSameCycleBorrowMatch
  } = context;

  itBaseExperimental(
    "surfaces a generic exact pre-window borrow plan from a representative existing-borrower fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findExistingBorrowerPreWindowBorrowMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      expect(match).toBeDefined();
      expect(match?.borrowCandidate.intent).toBe("BORROW");
      expect(match?.plan.intent).toBe("BORROW");
      expect(match?.borrowCandidate.netQuoteBorrowed).toBeGreaterThan(0n);
    },
    420_000
  );

  itBaseExperimental(
    "does not yet surface a generic exact pre-window borrow plan from a representative complex ongoing multi-actor borrower fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const competing = createClientsForPrivateKey(COMPETING_ANVIL_PRIVATE_KEY);
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findComplexOngoingPreWindowBorrowMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        competing,
        artifact
      );

      expect(match).toBeUndefined();
    },
    420_000
  );

  itBaseExperimental(
    "does not yet find a multi-cycle manual pre-window borrow improvement across representative complex ongoing multi-actor borrower fixtures",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const competing = createClientsForPrivateKey(COMPETING_ANVIL_PRIVATE_KEY);
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const { positiveMatch } = await findManualComplexOngoingPreWindowBorrowMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        competing,
        artifact
      );

      expect(positiveMatch).toBeUndefined();
    },
    420_000
  );

  itBaseExperimental(
    "does not yet find a multi-cycle manual pre-window borrow improvement across representative existing-borrower fixtures",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const { positiveMatch } = await findManualExistingBorrowerPreWindowBorrowImprovement(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      expect(positiveMatch).toBeUndefined();
    },
    420_000
  );

  itBaseExperimental(
    "does not yet find a multi-cycle manual pre-window borrow improvement across representative multi-bucket existing-borrower fixtures",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const { positiveMatch } =
        await findManualMultiBucketExistingBorrowerPreWindowBorrowImprovement(
          account,
          publicClient,
          walletClient,
          testClient,
          artifact
        );

      expect(positiveMatch).toBeUndefined();
    },
    420_000
  );

  itBaseExperimental(
    "does not yet find a boundary-derived multi-cycle manual pre-window borrow improvement for an existing-borrower fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const { positiveMatch } =
        await findBoundaryDerivedExistingBorrowerPreWindowBorrowImprovement(
          account,
          publicClient,
          walletClient,
          testClient,
          artifact
        );

      expect(positiveMatch).toBeUndefined();
    },
    420_000
  );

  itBaseExperimental(
    "does not yet find a same-cycle borrow improvement in a brand-new multi-bucket quote-only pool at the first due window even when collateral is discovered at the execution boundary",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match =
        await findBoundaryDiscoveredBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement(
          account,
          publicClient,
          walletClient,
          testClient,
          artifact
        );

      expect(match).toBeUndefined();
    },
    240_000
  );

  itBaseExperimental(
    "does not yet find a manual same-cycle borrow improvement in a brand-new multi-bucket quote-only pool at the first due window",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findManualBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      expect(match).toBeUndefined();
    },
    180_000
  );

  itBaseExperimental(
    "does not yet find a manual same-cycle borrow improvement in a brand-new single-bucket quote-only pool at the first due window",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findManualBrandNewFirstUpdateSameCycleBorrowImprovement(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      expect(match).toBeUndefined();
    },
    180_000
  );

  itBaseExperimental(
    "brand-new quote-only pool does not yet find a manual same-cycle borrow improvement after the first passive update",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findManualBrandNewSameCycleBorrowImprovement(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      expect(match).toBeUndefined();
    },
    180_000
  );

  itBaseExperimental(
    "does not yet find an exact same-cycle borrow steering candidate across representative existing-borrower fixtures",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findExistingBorrowerSameCycleBorrowMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact,
        {
          borrowSimulationLookaheadUpdates: 1
        }
      );

      expect(match).toBeUndefined();
    },
    180_000
  );

  itBaseExperimental(
    "does not yet find an exact same-cycle borrow steering candidate across borrower-heavy existing-borrower fixtures",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findExistingBorrowerSameCycleBorrowMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact,
        {
          borrowSimulationLookaheadUpdates: 1,
          scenarios: EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_SCENARIOS,
          configCandidates: EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_CONFIG_CANDIDATES
        }
      );

      expect(match).toBeUndefined();
    },
    180_000
  );

  itBaseExperimental(
    "does not yet find a manual same-cycle borrow improvement across borrower-heavy existing-borrower fixtures",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findManualExistingBorrowerSameCycleBorrowImprovement(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact,
        {
          scenarios: EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_SCENARIOS,
          configCandidates: EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_CONFIG_CANDIDATES
        }
      );

      expect(match).toBeUndefined();
    },
    180_000
  );

  itBaseExperimental(
    "does not yet find a boundary-targeted manual same-cycle borrow improvement in a bounded existing-borrower search",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const match = await findBoundaryTargetedManualSameCycleBorrowMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      expect(match).toBeUndefined();
    },
    180_000
  );
}

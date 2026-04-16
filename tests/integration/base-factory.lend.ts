import { expect } from "vitest";
import {
  advanceAndApplyEligibleUpdates,
  extractAjnaRateState,
  findExactDualCandidateFromSnapshot,
  readDwatpThresholdFenwickIndex,
  requireSnapshotMetadataValue
} from "./base-factory.shared.js";

type RegisterTest = (
  name: string,
  testFn: () => Promise<void> | void,
  timeout?: number
) => void;

type BaseFactoryLendTestContext = {
  itBaseExperimental: RegisterTest;
  itBaseDefault: RegisterTest;
  itBaseSlow: RegisterTest;
  itBaseSmoke: RegisterTest;
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
  LOCAL_RPC_URL: string;
  FORK_TIME_SKIP_SECONDS: number;
  REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST: any;
  EXPERIMENTAL_PREWINDOW_BUCKET_OFFSETS: any;
  EXPERIMENTAL_PREWINDOW_QUOTE_AMOUNTS: any;
  EXPERIMENTAL_PREWINDOW_COMPLEX_QUOTE_AMOUNTS: any;
  EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS: any;
  EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS: any;
  ajnaPoolAbi: any;
  AjnaRpcSnapshotSource: any;
  DryRunExecutionBackend: any;
  createAjnaExecutionBackend: (config: any) => any;
  planCycle: (snapshot: any, config: any) => any;
  resolveKeeperConfig: (config: any) => any;
  runCycle: (config: any, options: any) => Promise<any>;
  forecastAjnaNextEligibleRate: (state: any) => any;
  deployMockToken: (...args: any[]) => Promise<any>;
  mintToken: (...args: any[]) => Promise<any>;
  deployPoolThroughFactory: (...args: any[]) => Promise<any>;
  approveToken: (...args: any[]) => Promise<any>;
  readCurrentRateBps: (...args: any[]) => Promise<number>;
  createQuoteOnlyBorrowFixture: (...args: any[]) => Promise<any>;
  moveToFirstBorrowLookaheadState: (...args: any[]) => Promise<any>;
  findRepresentativeBorrowedStepUpState: (...args: any[]) => Promise<any>;
  createDeterministicPreWindowLendForecastFixture: (...args: any[]) => Promise<any>;
  createComplexOngoingPreWindowLendFixture: (...args: any[]) => Promise<any>;
  findManualPreWindowLendMatch: (...args: any[]) => Promise<any>;
  findRealActiveBasePool: (...args: any[]) => Promise<any>;
};

export function registerBaseFactoryLendTests(context: BaseFactoryLendTestContext): void {
  const {
    itBaseExperimental,
    itBaseDefault,
    itBaseSlow,
    itBaseSmoke,
    createClients,
    createClientsForPrivateKey,
    ensureMockArtifact,
    DEFAULT_ANVIL_PRIVATE_KEY,
    COMPETING_ANVIL_PRIVATE_KEY,
    LOCAL_RPC_URL,
    FORK_TIME_SKIP_SECONDS,
    REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST,
    EXPERIMENTAL_PREWINDOW_BUCKET_OFFSETS,
    EXPERIMENTAL_PREWINDOW_QUOTE_AMOUNTS,
    EXPERIMENTAL_PREWINDOW_COMPLEX_QUOTE_AMOUNTS,
    EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
    EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS,
    ajnaPoolAbi,
    AjnaRpcSnapshotSource,
    DryRunExecutionBackend,
    createAjnaExecutionBackend,
    planCycle,
    resolveKeeperConfig,
    runCycle,
    forecastAjnaNextEligibleRate,
    deployMockToken,
    mintToken,
    deployPoolThroughFactory,
    approveToken,
    readCurrentRateBps,
    createQuoteOnlyBorrowFixture,
    moveToFirstBorrowLookaheadState,
    findRepresentativeBorrowedStepUpState,
    createDeterministicPreWindowLendForecastFixture,
    createComplexOngoingPreWindowLendFixture,
    findManualPreWindowLendMatch,
    findRealActiveBasePool
  } = context;

  itBaseExperimental(
    "surfaces and naturally selects an exact LEND_AND_BORROW candidate in a representative Base-fork fixture with multi-bucket quote search",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const quoteOnlyPoolAddress = await createQuoteOnlyBorrowFixture(
        account,
        publicClient,
        walletClient,
        artifact
      );
      const quoteOnlyChainNow = await moveToFirstBorrowLookaheadState(
        account,
        publicClient,
        walletClient,
        testClient,
        quoteOnlyPoolAddress
      );

      let match:
        | (NonNullable<Awaited<ReturnType<typeof findExactDualCandidateFromSnapshot>>["match"]> & {
            poolAddress: `0x${string}`;
            chainNow: number;
          })
        | undefined;
      let attemptedConfigCount = 0;

      const quoteOnlyBaselineConfig = resolveKeeperConfig({
        chainId: 8453,
        poolAddress: quoteOnlyPoolAddress,
        poolId: `8453:${quoteOnlyPoolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: 1000,
        toleranceBps: 50,
        toleranceMode: "relative",
        completionPolicy: "next_move_would_overshoot",
        executionBufferBps: 0,
        maxQuoteTokenExposure: "1000000000000000000000000",
        maxBorrowExposure: "1000000000000000000000",
        snapshotAgeMaxSeconds: 3600,
        minTimeBeforeRateWindowSeconds: 120,
        minExecutableActionQuoteToken: "1",
        recheckBeforeSubmit: true
      });
      const quoteOnlyBaselineSnapshot = await new AjnaRpcSnapshotSource(quoteOnlyBaselineConfig, {
        publicClient,
        now: () => quoteOnlyChainNow
      }).getSnapshot();
      const quoteOnlyMatch = await findExactDualCandidateFromSnapshot(
        publicClient,
        account,
        quoteOnlyPoolAddress,
        quoteOnlyChainNow,
        quoteOnlyBaselineSnapshot,
        {
          maxValidationsWithPureMatch: 4,
          maxValidationsWithoutPureMatch: 4
        }
      );
      attemptedConfigCount += quoteOnlyMatch.attemptedConfigCount;
      if (quoteOnlyMatch.match) {
        match = {
          ...quoteOnlyMatch.match,
          poolAddress: quoteOnlyPoolAddress,
          chainNow: quoteOnlyChainNow
        };
      }

      if (!match) {
        const representativeBorrowedState = await findRepresentativeBorrowedStepUpState(
          account,
          publicClient,
          walletClient,
          testClient,
          artifact
        );
        if (representativeBorrowedState) {
          const scenarioMatch = await findExactDualCandidateFromSnapshot(
            publicClient,
            account,
            representativeBorrowedState.poolAddress,
            representativeBorrowedState.chainNow,
            representativeBorrowedState.baselineSnapshot,
            {
              maxValidationsWithPureMatch: 4,
              maxValidationsWithoutPureMatch: 4
            }
          );
          attemptedConfigCount += scenarioMatch.attemptedConfigCount;
          if (scenarioMatch.match) {
            match = {
              ...scenarioMatch.match,
              poolAddress: representativeBorrowedState.poolAddress,
              chainNow: representativeBorrowedState.chainNow
            };
          }
        }
      }

      if (!match) {
        throw new Error(
          `failed to find a representative exact dual candidate; attemptedConfigs=${attemptedConfigCount}`
        );
      }

      expect(attemptedConfigCount).toBeGreaterThan(0);
      expect(match.dualCandidate.intent).toBe("LEND_AND_BORROW");
      expect(
        match.dualCandidate.minimumExecutionSteps.some((step: any) => step.type === "ADD_QUOTE")
      ).toBe(true);
      expect(
        match.dualCandidate.minimumExecutionSteps.some((step: any) => step.type === "DRAW_DEBT")
      ).toBe(true);

      const naturalPlan = planCycle(match.exactSnapshot, match.config);
      expect(naturalPlan.intent).toBe("LEND_AND_BORROW");

      const dualOnlySnapshot = {
        ...match.exactSnapshot,
        candidates: [match.dualCandidate]
      };
      const result = await runCycle(match.config, {
        snapshotSource: {
          getSnapshot: async () => dualOnlySnapshot
        },
        executor: createAjnaExecutionBackend(match.config)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("LEND_AND_BORROW");
      expect(result.plan.requiredSteps.some((step: any) => step.type === "ADD_QUOTE")).toBe(true);
      expect(result.plan.requiredSteps.some((step: any) => step.type === "DRAW_DEBT")).toBe(true);
      expect(
        result.plan.requiredSteps.some((step: any) => step.type === "UPDATE_INTEREST")
      ).toBe(false);
      expect(await readCurrentRateBps(publicClient, match.poolAddress)).toBe(
        match.dualCandidate.predictedRateBpsAfterNextUpdate
      );
    },
    420_000
  );

  itBaseDefault(
    "finds a due-cycle lend plan in a representative borrowed-pool step-up state",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      let matched:
        | {
            poolAddress: `0x${string}`;
            selectedConfig: any;
            chainNow: number;
            exactSnapshot: any;
            heuristicSnapshot: any;
          }
        | undefined;
      let stepUpScenarioCount = 0;

      for (const [index, scenario] of REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.borrowedStepUpScenarios.entries()) {
        const collateralToken = await deployMockToken(
          walletClient,
          publicClient,
          artifact,
          `Steering Collateral ${index}`,
          `SC${index}`
        );
        const quoteToken = await deployMockToken(
          walletClient,
          publicClient,
          artifact,
          `Steering Quote ${index}`,
          `SQ${index}`
        );

        for (const tokenAddress of [collateralToken, quoteToken]) {
          await mintToken(
            walletClient,
            publicClient,
            artifact,
            tokenAddress,
            account.address,
            1_000_000n * 10n ** 18n
          );
        }

        const poolAddress = await deployPoolThroughFactory(
          walletClient,
          publicClient,
          collateralToken,
          quoteToken
        );

        await approveToken(
          walletClient,
          publicClient,
          quoteToken,
          poolAddress,
          1_000_000n * 10n ** 18n,
          artifact.abi
        );
        await approveToken(
          walletClient,
          publicClient,
          collateralToken,
          poolAddress,
          5_000n * 10n ** 18n,
          artifact.abi
        );

        const latestBlock = await publicClient.getBlock();
        const initialQuoteAmount = scenario.initialQuoteAmount * 10n ** 18n;
        const borrowAmount = scenario.borrowAmount * 10n ** 18n;
        const collateralAmount = scenario.collateralAmount * 10n ** 18n;

        try {
          const addQuoteHash = await walletClient.writeContract({
            account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "addQuoteToken",
            args: [initialQuoteAmount, 3_000n, latestBlock.timestamp + 3600n]
          });
          await publicClient.waitForTransactionReceipt({ hash: addQuoteHash });

          const drawDebtHash = await walletClient.writeContract({
            account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "drawDebt",
            args: [account.address, borrowAmount, 3_000n, collateralAmount]
          });
          await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });
        } catch {
          continue;
        }

        await testClient.increaseTime({
          seconds: FORK_TIME_SKIP_SECONDS
        });
        await testClient.mine({
          blocks: 1
        });

        const chainNow = Number((await publicClient.getBlock()).timestamp);
        const baselineConfig = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps: 800,
          toleranceBps: 50,
          toleranceMode: "relative",
          completionPolicy: "next_move_would_overshoot",
          executionBufferBps: 0,
          maxQuoteTokenExposure: "1000000000000000000000000",
          maxBorrowExposure: "5000000000000000000000",
          snapshotAgeMaxSeconds: 3600,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: true
        });

        const snapshot = await new AjnaRpcSnapshotSource(baselineConfig, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();

        let evaluationSnapshot = snapshot;
        let evaluationChainNow = chainNow;

        if (snapshot.predictedNextOutcome === "STEP_DOWN") {
          const updateHash = await walletClient.writeContract({
            account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "updateInterest"
          });
          await publicClient.waitForTransactionReceipt({ hash: updateHash });

          await testClient.increaseTime({
            seconds: FORK_TIME_SKIP_SECONDS
          });
          await testClient.mine({
            blocks: 1
          });

          evaluationChainNow = Number((await publicClient.getBlock()).timestamp);
          evaluationSnapshot = await new AjnaRpcSnapshotSource(baselineConfig, {
            publicClient,
            now: () => evaluationChainNow
          }).getSnapshot();
        }

        if (
          evaluationSnapshot.currentRateBps > baselineConfig.targetRateBps &&
          evaluationSnapshot.predictedNextOutcome === "STEP_UP"
        ) {
          stepUpScenarioCount += 1;
          const exactConfig = resolveKeeperConfig({
            chainId: 8453,
            poolAddress,
            poolId: `8453:${poolAddress.toLowerCase()}`,
            rpcUrl: LOCAL_RPC_URL,
            targetRateBps: 800,
            toleranceBps: 50,
            toleranceMode: "relative",
            completionPolicy: "next_move_would_overshoot",
            executionBufferBps: 0,
            maxQuoteTokenExposure: "1000000000000000000000000",
            maxBorrowExposure: "5000000000000000000000",
            snapshotAgeMaxSeconds: 3600,
            minTimeBeforeRateWindowSeconds: 120,
            minExecutableActionQuoteToken: "1",
            recheckBeforeSubmit: true,
            addQuoteBucketIndex: 3000,
            addQuoteExpirySeconds: 3600,
            enableSimulationBackedLendSynthesis: true,
            simulationSenderAddress: account.address
          });
          const exactSnapshot = await new AjnaRpcSnapshotSource(exactConfig, {
            publicClient,
            now: () => evaluationChainNow
          }).getSnapshot();
          const heuristicConfig = resolveKeeperConfig({
            chainId: 8453,
            poolAddress,
            poolId: `8453:${poolAddress.toLowerCase()}`,
            rpcUrl: LOCAL_RPC_URL,
            targetRateBps: 800,
            toleranceBps: 50,
            toleranceMode: "relative",
            completionPolicy: "next_move_would_overshoot",
            executionBufferBps: 0,
            maxQuoteTokenExposure: "1000000000000000000000000",
            maxBorrowExposure: "5000000000000000000000",
            snapshotAgeMaxSeconds: 3600,
            minTimeBeforeRateWindowSeconds: 120,
            minExecutableActionQuoteToken: "1",
            recheckBeforeSubmit: true,
            addQuoteBucketIndex: 3000,
            addQuoteExpirySeconds: 3600,
            enableHeuristicLendSynthesis: true
          });
          const heuristicSnapshot = await new AjnaRpcSnapshotSource(heuristicConfig, {
            publicClient,
            now: () => evaluationChainNow
          }).getSnapshot();
          const exactHasLend = exactSnapshot.candidates.some(
            (candidate: any) => candidate.intent === "LEND"
          );
          const heuristicHasLend = heuristicSnapshot.candidates.some(
            (candidate: any) => candidate.intent === "LEND"
          );
          if (!exactHasLend && !heuristicHasLend) {
            continue;
          }

          matched = {
            poolAddress,
            selectedConfig: exactHasLend ? exactConfig : heuristicConfig,
            chainNow: evaluationChainNow,
            exactSnapshot,
            heuristicSnapshot
          };
          break;
        }
      }

      if (!matched) {
        throw new Error(
          `failed to find comparable step-up scenario; stepUpScenarios=${stepUpScenarioCount}`
        );
      }
      expect(matched.exactSnapshot.predictedNextOutcome).toBe("STEP_UP");
      expect(
        matched.exactSnapshot.candidates.some((candidate: any) => candidate.intent === "LEND") ||
          matched.heuristicSnapshot.candidates.some((candidate: any) => candidate.intent === "LEND")
      ).toBe(true);

      const runtimeConfig = {
        ...matched.selectedConfig,
        allowHeuristicExecution: true
      };
      const snapshotSource = new AjnaRpcSnapshotSource(runtimeConfig, {
        publicClient,
        now: () => matched.chainNow
      });
      const result = await runCycle(runtimeConfig, {
        snapshotSource,
        executor: new DryRunExecutionBackend()
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("LEND");
      expect(result.plan.requiredSteps.some((step: any) => step.type === "ADD_QUOTE")).toBe(true);
      expect(result.plan.requiredSteps.some((step: any) => step.type === "UPDATE_INTEREST")).toBe(
        false
      );
    },
    240_000
  );

  itBaseExperimental(
    "forecasts the next-cycle rate from a post-update state and does not yet surface an exact next-update pre-window lend plan before the next window",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;
      const matched = await createDeterministicPreWindowLendForecastFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      const exactConfig = resolveKeeperConfig({
        chainId: 8453,
        poolAddress: matched.poolAddress,
        poolId: `8453:${matched.poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: 800,
        toleranceBps: 50,
        toleranceMode: "relative",
        completionPolicy: "next_move_would_overshoot",
        executionBufferBps: 0,
        maxQuoteTokenExposure: "1000000000000000000000000",
        maxBorrowExposure: "5000000000000000000000",
        snapshotAgeMaxSeconds: 3600,
        minTimeBeforeRateWindowSeconds: 120,
        minExecutableActionQuoteToken: "1",
        recheckBeforeSubmit: true,
        addQuoteExpirySeconds: 3600,
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address
      });
      const exactSnapshot = await new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      expect(exactSnapshot.candidates.some((candidate: any) => candidate.intent === "LEND")).toBe(
        false
      );

      await testClient.increaseTime({
        seconds: matched.snapshot.secondsUntilNextRateUpdate
      });
      await testClient.mine({
        blocks: 1
      });

      const updateHash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: matched.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "updateInterest"
      });
      await publicClient.waitForTransactionReceipt({ hash: updateHash });

      const updatedRateBps = await readCurrentRateBps(publicClient, matched.poolAddress);
      expect(updatedRateBps).toBe(matched.snapshot.predictedNextRateBps);
    },
    240_000
  );

  itBaseSlow(
    "does not surface a heuristic pre-window lend plan from the deterministic not-due step-up fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createDeterministicPreWindowLendForecastFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );
      const heuristicConfig = resolveKeeperConfig({
        ...matched.config,
        enableHeuristicLendSynthesis: true
      });
      const heuristicSnapshot = await new AjnaRpcSnapshotSource(heuristicConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      expect(heuristicSnapshot.candidates.some((candidate: any) => candidate.intent === "LEND")).toBe(
        false
      );
      expect(
        heuristicSnapshot.candidates.some((candidate: any) => candidate.intent === "LEND_AND_BORROW")
      ).toBe(false);
    },
    120_000
  );

  itBaseExperimental(
    "surfaces a generic exact pre-window lend plan across representative complex ongoing multi-actor fixtures",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const competing = createClientsForPrivateKey(COMPETING_ANVIL_PRIVATE_KEY);
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createComplexOngoingPreWindowLendFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        competing,
        artifact
      );

      const exactConfig = resolveKeeperConfig({
        ...matched.config,
        enableSimulationBackedLendSynthesis: true
      });
      const exactSnapshot = await new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      expect(exactSnapshot.candidates.some((candidate: any) => candidate.intent === "LEND")).toBe(
        true
      );
      expect(planCycle(exactSnapshot, exactConfig).intent).toBe("LEND");

      const heuristicConfig = resolveKeeperConfig({
        ...matched.config,
        enableHeuristicLendSynthesis: true
      });
      const heuristicSnapshot = await new AjnaRpcSnapshotSource(heuristicConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      expect(
        heuristicSnapshot.candidates.some((candidate: any) => candidate.intent === "LEND")
      ).toBe(false);
      expect(
        heuristicSnapshot.candidates.some((candidate: any) => candidate.intent === "LEND_AND_BORROW")
      ).toBe(false);
    },
    240_000
  );

  itBaseExperimental(
    "finds a multi-cycle manual pre-window lend improvement across representative complex ongoing multi-actor fixtures",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const competing = createClientsForPrivateKey(COMPETING_ANVIL_PRIVATE_KEY);
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createComplexOngoingPreWindowLendFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        competing,
        artifact
      );

      const { passivePath, thresholdIndex, observations, positiveMatch } =
        await findManualPreWindowLendMatch(
          account,
          publicClient,
          walletClient,
          testClient,
          matched,
          {
            bucketOffsets: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
            quoteAmounts: EXPERIMENTAL_PREWINDOW_COMPLEX_QUOTE_AMOUNTS,
            updateCount: 2
          }
        );

      expect(thresholdIndex).toBeDefined();
      expect(
        positiveMatch,
        `no complex ongoing multi-cycle pre-window lend improvement near dwatpIndex=${thresholdIndex}; passiveRate=${passivePath.currentRateBps}; observations=${observations.join(" | ")}`
      ).toBeDefined();
    },
    240_000
  );

  itBaseExperimental(
    "surfaces and executes a targeted exact multi-cycle pre-window lend plan from a representative complex ongoing multi-actor fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const competing = createClientsForPrivateKey(COMPETING_ANVIL_PRIVATE_KEY);
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createComplexOngoingPreWindowLendFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        competing,
        artifact
      );

      const { passivePath, positiveMatch } = await findManualPreWindowLendMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        matched,
        {
          bucketOffsets: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
          quoteAmounts: EXPERIMENTAL_PREWINDOW_COMPLEX_QUOTE_AMOUNTS,
          updateCount: 2
        }
      );

      expect(positiveMatch).toBeDefined();

      let chainNow = matched.chainNow;
      const exactConfig = resolveKeeperConfig({
        ...matched.config,
        addQuoteBucketIndex: positiveMatch!.bucketIndex,
        addQuoteBucketIndexes: [positiveMatch!.bucketIndex],
        minExecutableActionQuoteToken: positiveMatch!.amount.toString(),
        maxQuoteTokenExposure: positiveMatch!.amount.toString(),
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address,
        recheckBeforeSubmit: false
      });
      const snapshotSource = new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => chainNow
      });
      const exactSnapshot = await snapshotSource.getSnapshot();
      const lendCandidate = exactSnapshot.candidates.find((candidate: any) => candidate.intent === "LEND");

      expect(lendCandidate).toBeDefined();
      expect(lendCandidate?.planningLookaheadUpdates).toBe(2);
      expect(planCycle(exactSnapshot, exactConfig).intent).toBe("LEND");

      const result = await runCycle(exactConfig, {
        snapshotSource,
        executor: createAjnaExecutionBackend(exactConfig)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("LEND");
      expect(result.plan.requiredSteps.some((step: any) => step.type === "ADD_QUOTE")).toBe(true);
      expect(result.plan.requiredSteps.some((step: any) => step.type === "UPDATE_INTEREST")).toBe(
        false
      );

      chainNow = Number((await publicClient.getBlock()).timestamp);
      const activePath = await advanceAndApplyEligibleUpdates(
        account,
        publicClient,
        walletClient,
        testClient,
        exactConfig,
        2
      );

      expect(activePath.currentRateBps).toBeLessThan(passivePath.currentRateBps);
    },
    240_000
  );

  itBaseExperimental(
    "surfaces and executes a generic exact multi-cycle pre-window lend plan from a manual-positive complex ongoing multi-actor fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const competing = createClientsForPrivateKey(COMPETING_ANVIL_PRIVATE_KEY);
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createComplexOngoingPreWindowLendFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        competing,
        artifact
      );

      const { passivePath, positiveMatch } = await findManualPreWindowLendMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        matched,
        {
          bucketOffsets: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
          quoteAmounts: EXPERIMENTAL_PREWINDOW_COMPLEX_QUOTE_AMOUNTS,
          updateCount: 2
        }
      );

      expect(positiveMatch).toBeDefined();

      const exactConfig = resolveKeeperConfig({
        ...matched.config,
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address
      });
      const exactSnapshot = await new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      const lendCandidate = exactSnapshot.candidates.find((candidate: any) => candidate.intent === "LEND");

      expect(lendCandidate).toBeDefined();
      expect(lendCandidate?.planningLookaheadUpdates).toBe(2);
      expect(planCycle(exactSnapshot, exactConfig).intent).toBe("LEND");

      let chainNow = matched.chainNow;
      const snapshotSource = new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => chainNow
      });
      const result = await runCycle(exactConfig, {
        snapshotSource,
        executor: createAjnaExecutionBackend(exactConfig)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("LEND");

      chainNow = Number((await publicClient.getBlock()).timestamp);
      const activePath = await advanceAndApplyEligibleUpdates(
        account,
        publicClient,
        walletClient,
        testClient,
        exactConfig,
        2
      );

      expect(activePath.currentRateBps).toBeLessThan(passivePath.currentRateBps);
    },
    240_000
  );

  itBaseExperimental(
    "does not yet find a positive next-update manual pre-window lend near the DWATP threshold in the deterministic fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createDeterministicPreWindowLendForecastFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );
      const { passivePath, thresholdIndex, observations, positiveMatch } =
        await findManualPreWindowLendMatch(
          account,
          publicClient,
          walletClient,
          testClient,
          matched,
          {
            bucketOffsets: EXPERIMENTAL_PREWINDOW_BUCKET_OFFSETS,
            quoteAmounts: EXPERIMENTAL_PREWINDOW_QUOTE_AMOUNTS,
            updateCount: 1
          }
        );

      expect(thresholdIndex).toBeDefined();

      expect(
        positiveMatch,
        `no positive pre-window lend match near dwatpIndex=${thresholdIndex}; passiveRate=${passivePath.currentRateBps}; observations=${observations.join(" | ")}`
      ).toBeUndefined();
    },
    240_000
  );

  itBaseExperimental(
    "searches for a multi-cycle manual pre-window lend improvement near the DWATP threshold in the deterministic fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createDeterministicPreWindowLendForecastFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      const { passivePath, thresholdIndex, observations, positiveMatch } =
        await findManualPreWindowLendMatch(
          account,
          publicClient,
          walletClient,
          testClient,
          matched,
          {
            bucketOffsets: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
            quoteAmounts: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS,
            updateCount: 2
          }
        );

      expect(thresholdIndex).toBeDefined();
      expect(
        positiveMatch,
        `no multi-cycle pre-window lend improvement near dwatpIndex=${thresholdIndex}; passiveRate=${passivePath.currentRateBps}; observations=${observations.join(" | ")}`
      ).toBeDefined();
    },
    240_000
  );

  itBaseExperimental(
    "surfaces and executes a targeted exact multi-cycle pre-window lend plan from the deterministic fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createDeterministicPreWindowLendForecastFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      const { passivePath, positiveMatch } = await findManualPreWindowLendMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        matched,
        {
          bucketOffsets: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
          quoteAmounts: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS,
          updateCount: 2
        }
      );

      expect(positiveMatch).toBeDefined();

      let chainNow = matched.chainNow;
      const exactConfig = resolveKeeperConfig({
        ...matched.config,
        addQuoteBucketIndex: positiveMatch!.bucketIndex,
        addQuoteBucketIndexes: [positiveMatch!.bucketIndex],
        minExecutableActionQuoteToken: positiveMatch!.amount.toString(),
        maxQuoteTokenExposure: positiveMatch!.amount.toString(),
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address,
        recheckBeforeSubmit: false
      });
      const snapshotSource = new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => chainNow
      });
      const exactSnapshot = await snapshotSource.getSnapshot();
      const lendCandidate = exactSnapshot.candidates.find((candidate: any) => candidate.intent === "LEND");

      expect(lendCandidate).toBeDefined();
      expect(lendCandidate?.planningLookaheadUpdates).toBe(2);
      expect(planCycle(exactSnapshot, exactConfig).intent).toBe("LEND");

      const result = await runCycle(exactConfig, {
        snapshotSource,
        executor: createAjnaExecutionBackend(exactConfig)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("LEND");
      expect(result.plan.requiredSteps.some((step: any) => step.type === "ADD_QUOTE")).toBe(true);
      expect(result.plan.requiredSteps.some((step: any) => step.type === "UPDATE_INTEREST")).toBe(
        false
      );

      chainNow = Number((await publicClient.getBlock()).timestamp);
      const activePath = await advanceAndApplyEligibleUpdates(
        account,
        publicClient,
        walletClient,
        testClient,
        exactConfig,
        2
      );

      expect(activePath.currentRateBps).toBeLessThan(passivePath.currentRateBps);
    },
    240_000
  );

  itBaseExperimental(
    "does not yet surface an exact multi-cycle pre-window lend plan from the deterministic fixture when only the previously known-good bucket is pinned",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createDeterministicPreWindowLendForecastFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      const { positiveMatch } = await findManualPreWindowLendMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        matched,
        {
          bucketOffsets: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
          quoteAmounts: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS,
          updateCount: 2
        }
      );

      expect(positiveMatch).toBeDefined();
      const thresholdIndex = await readDwatpThresholdFenwickIndex(publicClient, matched.poolAddress);
      expect(thresholdIndex).toBeDefined();
      const derivedBucketIndexes = Array.from<number>(
        new Set(
          EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS.map((offset: number) =>
            Math.max(0, Math.min(7388, (thresholdIndex ?? 0) + offset))
          )
        )
      ).sort((left, right) => left - right);
      expect(derivedBucketIndexes).toContain(positiveMatch!.bucketIndex);

      const bucketPinnedConfig = resolveKeeperConfig({
        ...matched.config,
        addQuoteBucketIndex: positiveMatch!.bucketIndex,
        addQuoteBucketIndexes: [positiveMatch!.bucketIndex],
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address
      });
      const exactSnapshot = await new AjnaRpcSnapshotSource(bucketPinnedConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      const lendCandidate = exactSnapshot.candidates.find((candidate: any) => candidate.intent === "LEND");

      expect(lendCandidate).toBeUndefined();
    },
    240_000
  );

  itBaseSlow(
    "surfaces and executes an exact pre-window lend plan from the deterministic fixture with threshold-aware buckets",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createDeterministicPreWindowLendForecastFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );
      const { passivePath } = await findManualPreWindowLendMatch(
        account,
        publicClient,
        walletClient,
        testClient,
        matched,
        {
          bucketOffsets: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
          quoteAmounts: EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS,
          updateCount: 2
        }
      );

      const exactConfig = resolveKeeperConfig({
        ...matched.config,
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address
      });
      const exactSnapshot = await new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      const lendCandidate = exactSnapshot.candidates.find((candidate: any) => candidate.intent === "LEND");

      expect(lendCandidate).toBeDefined();
      expect(lendCandidate?.planningLookaheadUpdates).toBe(2);
      expect(planCycle(exactSnapshot, exactConfig).intent).toBe("LEND");
      const surfacedAddQuoteStep = lendCandidate?.minimumExecutionSteps.find(
        (step: any) => step.type === "ADD_QUOTE"
      );
      expect(surfacedAddQuoteStep?.type).toBe("ADD_QUOTE");
      expect(surfacedAddQuoteStep?.amount).toBeGreaterThan(0n);
      expect(surfacedAddQuoteStep?.amount).toBeLessThanOrEqual(exactConfig.maxQuoteTokenExposure);

      let chainNow = matched.chainNow;
      const snapshotSource = new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => chainNow
      });
      const result = await runCycle(exactConfig, {
        snapshotSource,
        executor: createAjnaExecutionBackend(exactConfig)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("LEND");
      expect(result.plan.requiredSteps.some((step: any) => step.type === "ADD_QUOTE")).toBe(true);
      expect(result.plan.requiredSteps.some((step: any) => step.type === "UPDATE_INTEREST")).toBe(
        false
      );

      chainNow = Number((await publicClient.getBlock()).timestamp);
      const activePath = await advanceAndApplyEligibleUpdates(
        account,
        publicClient,
        walletClient,
        testClient,
        exactConfig,
        2
      );

      expect(activePath.currentRateBps).toBeLessThan(passivePath.currentRateBps);
    },
    240_000
  );

  itBaseDefault(
    "replays passive updates against a real active Base pool discovered from factory logs",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const activePool = await findRealActiveBasePool(publicClient);
      if (!activePool) {
        throw new Error("failed to discover a real active Base pool from recent factory logs");
      }

      let { config, snapshot, chainNow } = activePool;
      const currentDebtWad = BigInt(String(requireSnapshotMetadataValue(snapshot, "currentDebtWad")));
      const depositEmaWad = BigInt(String(requireSnapshotMetadataValue(snapshot, "depositEmaWad")));
      expect(currentDebtWad).toBeGreaterThan(0n);
      expect(depositEmaWad).toBeGreaterThan(0n);

      for (let replayIndex = 0; replayIndex < 2; replayIndex += 1) {
        if (snapshot.secondsUntilNextRateUpdate > 0) {
          await testClient.increaseTime({
            seconds: snapshot.secondsUntilNextRateUpdate
          });
          await testClient.mine({
            blocks: 1
          });
          chainNow = Number((await publicClient.getBlock()).timestamp);
        }
        const predictedNextOutcome = forecastAjnaNextEligibleRate(
          extractAjnaRateState(snapshot, chainNow)
        ).predictedOutcome;

        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: config.poolAddress!,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });

        const updatedRateBps = await readCurrentRateBps(publicClient, config.poolAddress!);
        if (predictedNextOutcome === "STEP_UP") {
          expect(updatedRateBps).toBeGreaterThanOrEqual(snapshot.currentRateBps);
        } else if (predictedNextOutcome === "STEP_DOWN") {
          expect(updatedRateBps).toBeLessThanOrEqual(snapshot.currentRateBps);
        } else if (predictedNextOutcome === "RESET_TO_TEN") {
          expect(Math.abs(updatedRateBps - 1000)).toBeLessThanOrEqual(1);
        } else {
          expect(Math.abs(updatedRateBps - snapshot.currentRateBps)).toBeLessThanOrEqual(1);
        }

        chainNow = Number((await publicClient.getBlock()).timestamp);
        snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
      }
    },
    180_000
  );

  itBaseSmoke(
    "brand-new quote-only pool continues repeated update-only downward convergence across roughly a week until the target band is reached, then stops cleanly",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      const collateralToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        "Long Horizon Collateral",
        "LHC"
      );
      const quoteToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        "Long Horizon Quote",
        "LHQ"
      );

      for (const tokenAddress of [collateralToken, quoteToken]) {
        await mintToken(
          walletClient,
          publicClient,
          artifact,
          tokenAddress,
          account.address,
          1_000_000n * 10n ** 18n
        );
      }

      const poolAddress = await deployPoolThroughFactory(
        walletClient,
        publicClient,
        collateralToken,
        quoteToken
      );

      await approveToken(
        walletClient,
        publicClient,
        quoteToken,
        poolAddress,
        1_000_000n * 10n ** 18n,
        artifact.abi
      );

      const latestBlock = await publicClient.getBlock();
      const addQuoteHash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "addQuoteToken",
        args: [1_000n * 10n ** 18n, 3_000n, latestBlock.timestamp + 3600n]
      });
      await publicClient.waitForTransactionReceipt({ hash: addQuoteHash });

      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;
      const config = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: 200,
        toleranceBps: 500,
        toleranceMode: "relative",
        completionPolicy: "next_move_would_overshoot",
        executionBufferBps: 0,
        maxQuoteTokenExposure: "1000000000000000000000000",
        maxBorrowExposure: "1000000000000000000000000",
        snapshotAgeMaxSeconds: 3600,
        minTimeBeforeRateWindowSeconds: 120,
        minExecutableActionQuoteToken: "1",
        recheckBeforeSubmit: true
      });

      const observedRates: number[] = [];
      let executedUpdateCount = 0;
      let sawTerminalNoOp = false;
      let chainNow = Number((await publicClient.getBlock()).timestamp);

      for (let cycle = 0; cycle < 20; cycle += 1) {
        await testClient.increaseTime({
          seconds: FORK_TIME_SKIP_SECONDS
        });
        await testClient.mine({
          blocks: 1
        });
        chainNow = Number((await publicClient.getBlock()).timestamp);

        const result = await runCycle(config, {
          snapshotSource: new AjnaRpcSnapshotSource(config, {
            publicClient,
            now: () => chainNow
          }),
          executor: createAjnaExecutionBackend(config)
        });

        chainNow = Number((await publicClient.getBlock()).timestamp);
        const currentRateBps = await readCurrentRateBps(publicClient, poolAddress);

        if (result.status === "NO_OP") {
          sawTerminalNoOp = true;
          expect(result.plan.requiredSteps).toEqual([]);
          expect(currentRateBps).toBeGreaterThanOrEqual(190);
          expect(currentRateBps).toBeLessThanOrEqual(210);
          break;
        }

        expect(result.status).toBe("EXECUTED");
        expect(result.plan.requiredSteps.some((step: any) => step.type === "UPDATE_INTEREST")).toBe(
          true
        );
        observedRates.push(currentRateBps);
        executedUpdateCount += 1;
      }

      expect(executedUpdateCount).toBe(15);
      expect(observedRates).toHaveLength(15);
      for (let index = 1; index < observedRates.length; index += 1) {
        expect(observedRates[index]).toBeLessThan(observedRates[index - 1]!);
      }
      expect(observedRates.at(-1)).toBeGreaterThanOrEqual(190);
      expect(observedRates.at(-1)).toBeLessThanOrEqual(210);
      expect(sawTerminalNoOp).toBe(true);
    },
    120_000
  );
}

import "dotenv/config";

import { spawn, type ChildProcess } from "node:child_process";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Hex } from "viem";

import {
  ajnaPoolAbi,
  erc20Abi,
  forecastAjnaNextEligibleRate,
  AjnaRpcSnapshotSource,
  clearAjnaSnapshotCaches,
  createAjnaExecutionBackend,
  DryRunExecutionBackend,
  planCycle,
  resolveKeeperConfig,
  runCycle,
  type KeeperConfig,
  type PlanCandidate,
  type PoolSnapshot
} from "../../src/index.js";
import { requireSnapshotMetadataString } from "../../src/snapshot-metadata.js";
import {
  AJNA_COLLATERALIZATION_FACTOR_WAD,
  AJNA_FLOAT_STEP,
  FORK_TIME_SKIP_SECONDS,
  WAD,
  approximatePreWindowBorrowForecast,
  fenwickIndexToPriceWad,
  priceToFenwickIndex,
  type ApproximatePreWindowBorrowForecast,
  type ApproximatePreWindowBorrowState,
  wdiv,
  wmul
} from "./base-factory.protocol.js";
import {
  BORROW_COLLATERAL_CANDIDATES,
  DETERMINISTIC_PREWINDOW_LEND_SCENARIO_INDEXES,
  EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_AMOUNTS_WAD,
  EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_LIMIT_INDEXES,
  EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_EXISTING_SCENARIOS,
  EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_CONFIG_CANDIDATES,
  EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_SCENARIOS,
  EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_AMOUNTS_WAD,
  EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_LOOKAHEAD_UPDATES,
  EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_TARGET_OFFSETS_BPS,
  EXPERIMENTAL_COMPLEX_PREWINDOW_LEND_SCENARIOS,
  EXPERIMENTAL_COMPLEX_PREWINDOW_TARGETS,
  EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE,
  EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_AMOUNTS_WAD,
  EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_LIMIT_INDEXES,
  EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_TARGET_OFFSETS_BPS,
  EXPERIMENTAL_PREWINDOW_BUCKET_OFFSETS,
  EXPERIMENTAL_PREWINDOW_COMPLEX_QUOTE_AMOUNTS,
  EXPERIMENTAL_PREWINDOW_QUOTE_AMOUNTS,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_SCENARIOS,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_TARGET_OFFSETS_BPS,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_AMOUNTS_WAD,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_LIMIT_INDEXES,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_TARGET_OFFSETS_BPS,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROWER_SCENARIOS,
  EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS,
  EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS,
  REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST,
  REPRESENTATIVE_MULTI_CYCLE_BORROW_CONFIG
} from "./base-factory.fixtures.js";
import { registerBaseFactoryBorrowerTests } from "./base-factory.borrower.js";
import { createBaseFactoryBorrowerHelpers } from "./base-factory.borrower-helpers.js";
import { registerBaseFactoryCuratorTests } from "./base-factory.curator.js";
import { createBaseFactoryCuratorHelpers } from "./base-factory.curator-helpers.js";
import { registerBaseFactoryLendTests } from "./base-factory.lend.js";
import {
  createComplexOngoingPreWindowLendFixture,
  createDeterministicPreWindowLendForecastFixture,
  createExistingBorrowerMultiBucketFixture,
  createExistingBorrowerSameCycleFixture,
  createLargeUsedPoolMultiWeekBorrowFixture,
  createQuoteOnlyBorrowFixture,
  createQuoteOnlyMultiBucketBorrowFixture,
  findManualPreWindowLendMatch,
  findRealActiveBasePool,
  findRepresentativeBorrowedStepUpState,
  formatTokenAmount,
  formatWeiAsEth,
  runLargeUsedPoolMultiWeekBorrowBranch
} from "./base-factory.scenarios.js";
import {
  COMPETING_ANVIL_PRIVATE_KEY,
  DEFAULT_ANVIL_PRIVATE_KEY,
  EXTERNAL_LOCAL_ANVIL_URL,
  LOCAL_RPC_URL,
  RUN_BASE_FORK_TESTS,
  RUN_BASE_FORK_ALL_TESTS,
  RUN_BASE_FORK_EXPERIMENTAL_TESTS,
  RUN_BASE_FORK_SLOW_TESTS,
  RUN_BASE_FORK_SMOKE_TESTS,
  RUN_BASE_FORK_STRESS_TESTS,
  TEST_PORT,
  approveToken,
  buildRepresentativeBorrowAbortCandidate,
  buildRepresentativeBorrowLookaheadConfig,
  createClients,
  createClientsForPrivateKey,
  currentBaseForkProfile,
  deployMockToken,
  deployPoolThroughFactory,
  describeForkHost,
  ensureMockArtifact,
  extractAjnaRateState,
  findExactDualCandidateConfig,
  findExactDualCandidateFromSnapshot,
  mintToken,
  readCurrentRateBps,
  readCurrentRateInfo,
  repoRoot,
  requireSnapshotMetadataValue,
  advanceAndApplyEligibleUpdates,
  advanceAndApplyEligibleUpdatesDirect,
  waitForPort,
  waitForRpcListener,
  drawDebtIntoRateStateForTest,
  computeStepUpMargin
} from "./base-factory.shared.js";
const DECREASED_RATE_BPS = 900;
const {
  findSavedUsedPoolUpwardDualArchetypeMatches,
  findPinnedUsedPoolUpwardSimulationMatches,
  findPinnedUsedPoolUpwardPairedDualMatches,
  inspectAjnaInfoManagedUsedPoolArchetypes,
  findTargetedAjnaInfoManagedUsedPoolInventoryCandidate,
  probeAjnaInfoManagedUsedPoolManualRemoveQuote,
  probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow
} = createBaseFactoryCuratorHelpers({
  createExistingBorrowerSameCycleFixture,
  createExistingBorrowerMultiBucketFixture,
  readCurrentRateInfo,
  advanceAndApplyEligibleUpdatesDirect
});

const {
  moveToFirstBorrowLookaheadState,
  createDeterministicPreWindowBorrowFixture,
  findExistingBorrowerPreWindowBorrowMatch,
  findComplexOngoingPreWindowBorrowMatch,
  findManualComplexOngoingPreWindowBorrowMatch,
  findManualExistingBorrowerPreWindowBorrowImprovement,
  findBoundaryDerivedExistingBorrowerPreWindowBorrowImprovement,
  findManualMultiBucketExistingBorrowerPreWindowBorrowImprovement,
  findExistingBorrowerSameCycleBorrowMatch,
  findManualExistingBorrowerSameCycleBorrowImprovement,
  findManualBrandNewSameCycleBorrowImprovement,
  findManualBrandNewFirstUpdateSameCycleBorrowImprovement,
  findManualBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement,
  findBoundaryDiscoveredBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement,
  findBoundaryTargetedManualSameCycleBorrowMatch
} = createBaseFactoryBorrowerHelpers({
  createQuoteOnlyBorrowFixture,
  createQuoteOnlyMultiBucketBorrowFixture,
  createExistingBorrowerSameCycleFixture,
  createExistingBorrowerMultiBucketFixture
});

const describeIf = RUN_BASE_FORK_TESTS ? describe : describe.skip;
const itBaseSmoke =
  (RUN_BASE_FORK_SLOW_TESTS ||
    RUN_BASE_FORK_STRESS_TESTS ||
    RUN_BASE_FORK_EXPERIMENTAL_TESTS) &&
  !RUN_BASE_FORK_ALL_TESTS
    ? it.skip
    : it;
const itBaseDefault =
  (RUN_BASE_FORK_SMOKE_TESTS ||
    RUN_BASE_FORK_SLOW_TESTS ||
    RUN_BASE_FORK_STRESS_TESTS ||
    RUN_BASE_FORK_EXPERIMENTAL_TESTS) &&
  !RUN_BASE_FORK_ALL_TESTS
    ? it.skip
    : it;
const itBaseSlow = RUN_BASE_FORK_SLOW_TESTS || RUN_BASE_FORK_ALL_TESTS ? it : it.skip;
const itBaseStress = RUN_BASE_FORK_STRESS_TESTS || RUN_BASE_FORK_ALL_TESTS ? it : it.skip;
const itBaseExperimental =
  RUN_BASE_FORK_EXPERIMENTAL_TESTS || RUN_BASE_FORK_ALL_TESTS ? it : it.skip;

describeIf("Base factory fork integration", () => {
  let anvil: ChildProcess | undefined;
  let anvilStderr = "";
  let outerSnapshotId: Hex | undefined;

  beforeAll(async () => {
    const forkUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
    if (EXTERNAL_LOCAL_ANVIL_URL) {
      console.log(
        `[base-fork] profile=${currentBaseForkProfile()} mode=reuse local=${describeForkHost(
          LOCAL_RPC_URL
        )}`
      );
      await waitForRpcListener(LOCAL_RPC_URL, 60_000);
      return;
    }

    console.log(
      `[base-fork] profile=${currentBaseForkProfile()} mode=spawn upstream=${describeForkHost(
        forkUrl
      )} local=${describeForkHost(LOCAL_RPC_URL)}`
    );
    anvil = spawn(
      "anvil",
      [
        "--fork-url",
        forkUrl,
        "--port",
        String(TEST_PORT),
        "--chain-id",
        "8453",
        "--silent"
      ],
      {
        cwd: repoRoot(),
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    anvil.stderr?.setEncoding("utf8");
    anvil.stderr?.on("data", (chunk: string) => {
      anvilStderr = `${anvilStderr}${chunk}`.slice(-8_000);
    });

    try {
      await waitForPort(TEST_PORT, 60_000);
    } catch (error) {
      if (anvilStderr.trim().length > 0) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${anvilStderr.trim()}`
        );
      }

      throw error;
    }
  }, 70_000);

  beforeEach(async () => {
    clearAjnaSnapshotCaches();
    const { testClient } = createClients();
    outerSnapshotId = await testClient.snapshot();
  });

  afterEach(async () => {
    if (!outerSnapshotId) {
      return;
    }

    const { testClient } = createClients();
    await testClient.revert({ id: outerSnapshotId });
    clearAjnaSnapshotCaches();
    outerSnapshotId = undefined;
  });

  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  itBaseSmoke(
    "brand-new quote-only pool passively steps down on its first eligible update",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();

      const artifact = await ensureMockArtifact();
      const collateralToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        "Keeper Collateral",
        "KCOL"
      );
      const quoteToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        "Keeper Quote",
        "KQTE"
      );

      for (const tokenAddress of [collateralToken, quoteToken]) {
        await mintToken(
          walletClient,
          publicClient,
          artifact,
          tokenAddress,
          account.address,
          10_000n * 10n ** 18n
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
        2_000n * 10n ** 18n,
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

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      let chainNow = Number((await publicClient.getBlock()).timestamp);
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const config: KeeperConfig = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: 800,
        toleranceBps: 50,
        toleranceMode: "relative",
        completionPolicy: "next_move_would_overshoot",
        maxQuoteTokenExposure: "1000000000000000000000000",
        maxBorrowExposure: "1000000000000000000000000",
        snapshotAgeMaxSeconds: 3600,
        minTimeBeforeRateWindowSeconds: 120,
        minExecutableActionQuoteToken: "1",
        recheckBeforeSubmit: true
      });

      const snapshotSource = new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      });
      const snapshot = await snapshotSource.getSnapshot();
      expect(snapshot.predictedNextOutcome).toBe("STEP_DOWN");
      expect(snapshot.secondsUntilNextRateUpdate).toBe(0);

      const result = await runCycle(config, {
        snapshotSource: new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }),
        executor: createAjnaExecutionBackend(config)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")).toBe(true);

      chainNow = Number((await publicClient.getBlock()).timestamp);
      expect(await readCurrentRateBps(publicClient, poolAddress)).toBe(DECREASED_RATE_BPS);
    },
    120_000
  );

  itBaseDefault(
    "brand-new quote-only pool does not yet find an exact same-cycle borrow steering candidate after the first passive update when exact search is restricted to one update",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const poolAddress = await createQuoteOnlyBorrowFixture(
        account,
        publicClient,
        walletClient,
        artifact
      );
      const chainNow = await moveToFirstBorrowLookaheadState(
        account,
        publicClient,
        walletClient,
        testClient,
        poolAddress
      );

      const baselineConfig = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
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
      const baselineSnapshot = await new AjnaRpcSnapshotSource(baselineConfig, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();

      expect(baselineSnapshot.currentRateBps).toBe(900);
      expect(baselineSnapshot.predictedNextOutcome).not.toBe("STEP_UP");

      const config = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
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
        recheckBeforeSubmit: true,
        borrowerAddress: account.address,
        simulationSenderAddress: account.address,
        enableSimulationBackedBorrowSynthesis: true,
        borrowSimulationLookaheadUpdates: 1,
        drawDebtLimitIndexes: [3000],
        drawDebtCollateralAmounts: ["10000000000000000000"]
      });
      const snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();

      expect(snapshot.candidates.some((candidate) => candidate.intent === "BORROW")).toBe(false);
    },
    120_000
  );

  itBaseExperimental(
    "brand-new quote-only pool finds and live-executes a multi-cycle borrow plan when target is above the passive trajectory",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const poolAddress = await createQuoteOnlyBorrowFixture(
        account,
        publicClient,
        walletClient,
        artifact
      );
      const chainNow = await moveToFirstBorrowLookaheadState(
        account,
        publicClient,
        walletClient,
        testClient,
        poolAddress
      );

      const config = buildRepresentativeBorrowLookaheadConfig(poolAddress, account.address);
      const snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();

      expect(snapshot.planningLookaheadUpdates).toBe(3);
      expect(snapshot.planningRateBps).toBeLessThan(config.targetRateBps);
      const borrowCandidate = snapshot.candidates.find((candidate) => candidate.intent === "BORROW");
      expect(borrowCandidate).toBeDefined();
      expect(borrowCandidate?.planningLookaheadUpdates).toBe(3);
      expect(borrowCandidate?.planningRateBps).toBeDefined();
      const initialLastInterestUpdateTimestamp = Number(
        requireSnapshotMetadataValue(snapshot, "lastInterestRateUpdateTimestamp")
      );
      const lookaheadUpdates = borrowCandidate?.planningLookaheadUpdates ?? 1;
      const expectedFirstRateBps = borrowCandidate?.predictedRateBpsAfterNextUpdate;
      const expectedTerminalRateBps =
        borrowCandidate?.planningRateBps ?? borrowCandidate?.predictedRateBpsAfterNextUpdate;
      expect(expectedFirstRateBps).toBeDefined();
      expect(expectedTerminalRateBps).toBeDefined();

      const passiveBranchId = await testClient.snapshot();
      const passivePath = await advanceAndApplyEligibleUpdates(
        account,
        publicClient,
        walletClient,
        testClient,
        config,
        lookaheadUpdates
      );
      await testClient.revert({ id: passiveBranchId });

      const result = await runCycle(config, {
        snapshotSource: new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }),
        executor: createAjnaExecutionBackend(config)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("BORROW");
      expect(result.plan.requiredSteps.some((step) => step.type === "DRAW_DEBT")).toBe(true);
      expect(result.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")).toBe(
        false
      );

      const postExecutionNow = Number((await publicClient.getBlock()).timestamp);
      const postExecutionSnapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => postExecutionNow
      }).getSnapshot();
      const postExecutionLastInterestUpdateTimestamp = Number(
        requireSnapshotMetadataValue(postExecutionSnapshot, "lastInterestRateUpdateTimestamp")
      );
      expect(postExecutionLastInterestUpdateTimestamp).toBeGreaterThan(
        initialLastInterestUpdateTimestamp
      );
      expect(postExecutionSnapshot.currentRateBps).toBe(expectedFirstRateBps);

      const executedUpdates =
        postExecutionLastInterestUpdateTimestamp > initialLastInterestUpdateTimestamp ? 1 : 0;
      const remainingUpdates = Math.max(0, lookaheadUpdates - executedUpdates);
      const activePath = await advanceAndApplyEligibleUpdates(
        account,
        publicClient,
        walletClient,
        testClient,
        config,
        remainingUpdates
      );

      expect(activePath.currentRateBps).toBe(expectedTerminalRateBps);
      expect(activePath.currentRateBps).toBeGreaterThan(passivePath.currentRateBps);
    },
    420_000
  );

  itBaseExperimental(
    "surfaces a generic exact pre-window borrow plan from a deterministic brand-new quote-only fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createDeterministicPreWindowBorrowFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      const config = resolveKeeperConfig({
        ...matched.config,
        enableSimulationBackedBorrowSynthesis: true,
        enableHeuristicBorrowSynthesis: false
      });
      const snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      const borrowCandidate = snapshot.candidates.find((candidate) => candidate.intent === "BORROW");
      const borrowOnlySnapshot = {
        ...snapshot,
        candidates: borrowCandidate === undefined ? [] : [borrowCandidate]
      };
      const plan = planCycle(borrowOnlySnapshot, config);

      expect(snapshot.secondsUntilNextRateUpdate).toBeGreaterThan(0);
      expect(borrowCandidate).toBeDefined();
      expect(plan.intent).toBe("BORROW");
      expect(plan.requiredSteps.some((step) => step.type === "DRAW_DEBT")).toBe(true);
      expect(
        borrowCandidate?.planningLookaheadUpdates === undefined ||
          borrowCandidate.planningLookaheadUpdates >= 1
      ).toBe(true);
    },
    420_000
  );

  itBaseExperimental(
    "surfaces and executes a targeted exact pre-window borrow plan from the deterministic brand-new quote-only fixture",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const matched = await createDeterministicPreWindowBorrowFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );

      const surfacedConfig = resolveKeeperConfig({
        ...matched.config,
        enableSimulationBackedBorrowSynthesis: true,
        enableHeuristicBorrowSynthesis: false
      });
      const surfacedSnapshot = await new AjnaRpcSnapshotSource(surfacedConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      const surfacedBorrowCandidate = surfacedSnapshot.candidates.find(
        (candidate) => candidate.intent === "BORROW"
      );

      expect(surfacedBorrowCandidate).toBeDefined();

      const executionConfig = resolveKeeperConfig({
        ...matched.config,
        enableSimulationBackedBorrowSynthesis: false,
        enableHeuristicBorrowSynthesis: false,
        manualCandidates: surfacedBorrowCandidate === undefined ? [] : [surfacedBorrowCandidate]
      });
      const executionSnapshot = await new AjnaRpcSnapshotSource(executionConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      const executionPlan = planCycle(executionSnapshot, executionConfig);

      expect(executionPlan.intent).toBe("BORROW");
      expect(executionPlan.requiredSteps.some((step) => step.type === "DRAW_DEBT")).toBe(true);

      const lookaheadUpdates = surfacedBorrowCandidate?.planningLookaheadUpdates ?? 1;
      const expectedTerminalRateBps =
        surfacedBorrowCandidate?.planningRateBps ??
        surfacedBorrowCandidate?.predictedRateBpsAfterNextUpdate;
      expect(expectedTerminalRateBps).toBeDefined();

      const passiveBranchId = await testClient.snapshot();
      const passivePath = await advanceAndApplyEligibleUpdates(
        account,
        publicClient,
        walletClient,
        testClient,
        matched.config,
        lookaheadUpdates
      );
      await testClient.revert({ id: passiveBranchId });

      const result = await runCycle(executionConfig, {
        snapshotSource: new AjnaRpcSnapshotSource(executionConfig, {
          publicClient,
          now: () => matched.chainNow
        }),
        executor: createAjnaExecutionBackend(executionConfig)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("BORROW");
      expect(result.plan.requiredSteps.some((step) => step.type === "DRAW_DEBT")).toBe(true);
      expect(result.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")).toBe(
        false
      );

      const activePath = await advanceAndApplyEligibleUpdates(
        account,
        publicClient,
        walletClient,
        testClient,
        matched.config,
        lookaheadUpdates
      );

      expect(activePath.currentRateBps).toBe(expectedTerminalRateBps);
      expect(
        Math.abs(activePath.currentRateBps - matched.config.targetRateBps)
      ).toBeLessThan(Math.abs(passivePath.currentRateBps - matched.config.targetRateBps));
    },
    420_000
  );

  itBaseExperimental(
    "surfaces a real multi-cycle borrow in a significantly used pool over multiple weeks and shows that it does not yet beat the passive upward path",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const fixture = await createLargeUsedPoolMultiWeekBorrowFixture(
        account,
        publicClient,
        walletClient,
        testClient,
        artifact
      );
      const initialSnapshot = await new AjnaRpcSnapshotSource(fixture.config, {
        publicClient,
        now: () => fixture.chainNow
      }).getSnapshot();
      const loansInfo = await publicClient.readContract({
        address: fixture.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "loansInfo",
        args: []
      });
      const noOfLoans = Number(loansInfo[2]);

      expect(noOfLoans).toBeGreaterThanOrEqual(3);
      expect(initialSnapshot.currentRateBps).toBeLessThan(fixture.config.targetRateBps);
      expect(initialSnapshot.currentRateBps).toBeGreaterThan(0);

      const branchId = await testClient.snapshot();
      const activeBranch = await runLargeUsedPoolMultiWeekBorrowBranch("active", {
        account,
        publicClient,
        walletClient,
        testClient,
        poolAddress: fixture.poolAddress,
        config: fixture.config,
        actorAddresses: fixture.actorAddresses,
        cycleCount: EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.cycleCount,
        initialOperatorDebtWad: fixture.initialOperatorDebtWad
      });
      await testClient.revert({ id: branchId });

      const passiveBranch = await runLargeUsedPoolMultiWeekBorrowBranch("passive", {
        account,
        publicClient,
        walletClient,
        testClient,
        poolAddress: fixture.poolAddress,
        config: fixture.config,
        actorAddresses: fixture.actorAddresses,
        cycleCount: EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.cycleCount,
        initialOperatorDebtWad: fixture.initialOperatorDebtWad
      });

      const activeDistanceToTarget = Math.abs(
        activeBranch.finalRateBps - fixture.config.targetRateBps
      );
      const passiveDistanceToTarget = Math.abs(
        passiveBranch.finalRateBps - fixture.config.targetRateBps
      );
      const activeDebtDeltaWad = activeBranch.finalOperatorDebtWad - fixture.initialOperatorDebtWad;
      const passiveDebtDeltaWad =
        passiveBranch.finalOperatorDebtWad - fixture.initialOperatorDebtWad;
      const summary = [
        `initialRate=${initialSnapshot.currentRateBps}`,
        `target=${fixture.config.targetRateBps}`,
        `activeFinal=${activeBranch.finalRateBps}`,
        `passiveFinal=${passiveBranch.finalRateBps}`,
        `borrowCycles=${activeBranch.executedBorrowCycles}`,
        `cumulativeBorrowed=${formatTokenAmount(activeBranch.cumulativeNetQuoteBorrowedWad)}`,
        `additionalCollateral=${formatTokenAmount(activeBranch.cumulativeAdditionalCollateralWad)}`,
        `operatorCapitalRequired=${formatTokenAmount(activeBranch.cumulativeOperatorCapitalRequiredWad)}`,
        `activeDebtDelta=${formatTokenAmount(activeDebtDeltaWad)}`,
        `passiveDebtDelta=${formatTokenAmount(passiveDebtDeltaWad)}`,
        `activeGasEth=${formatWeiAsEth(activeBranch.cumulativeGasCostWei)}`,
        `passiveGasEth=${formatWeiAsEth(passiveBranch.cumulativeGasCostWei)}`,
        `activeObs=${activeBranch.observations.join(",")}`,
        `passiveObs=${passiveBranch.observations.join(",")}`
      ].join(" ");

      console.info(
        [
          "large-used-pool-upward-summary",
          `initial_rate=${initialSnapshot.currentRateBps}`,
          `target=${fixture.config.targetRateBps}`,
          `active_final=${activeBranch.finalRateBps}`,
          `passive_final=${passiveBranch.finalRateBps}`,
          `active_reached_cycle=${activeBranch.reachedTargetCycle ?? "-"}`,
          `borrow_cycles=${activeBranch.executedBorrowCycles}`,
          `initial_operator_collateral=${formatTokenAmount(fixture.initialOperatorCollateralWad)}`,
          `incremental_collateral=${formatTokenAmount(activeBranch.cumulativeAdditionalCollateralWad)}`,
          `cumulative_borrowed=${formatTokenAmount(activeBranch.cumulativeNetQuoteBorrowedWad)}`,
          `operator_capital_required=${formatTokenAmount(activeBranch.cumulativeOperatorCapitalRequiredWad)}`,
          `active_debt_delta=${formatTokenAmount(activeDebtDeltaWad)}`,
          `passive_debt_delta=${formatTokenAmount(passiveDebtDeltaWad)}`,
          `gas_eth=${formatWeiAsEth(activeBranch.cumulativeGasCostWei)}`,
          `active_observations=${activeBranch.observations.join(",")}`,
          `passive_observations=${passiveBranch.observations.join(",")}`
        ].join(" ")
      );

      expect(activeBranch.executedBorrowCycles, summary).toBeGreaterThan(0);
      expect(activeBranch.cumulativeNetQuoteBorrowedWad, summary).toBeGreaterThan(0n);
      expect(activeDebtDeltaWad, summary).toBeGreaterThan(passiveDebtDeltaWad);
      expect(activeBranch.cumulativeGasCostWei, summary).toBeGreaterThan(
        passiveBranch.cumulativeGasCostWei
      );
      expect(activeBranch.finalRateBps, summary).toBeLessThanOrEqual(passiveBranch.finalRateBps);
      expect(activeDistanceToTarget, summary).toBeGreaterThanOrEqual(passiveDistanceToTarget);
    },
    420_000
  );

  registerBaseFactoryCuratorTests({
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
  });

  registerBaseFactoryBorrowerTests({
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
  });

  itBaseStress(
    "aborts when another actor changes the pool between planning and execution",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const competing = createClientsForPrivateKey(COMPETING_ANVIL_PRIVATE_KEY);
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const poolAddress = await createQuoteOnlyBorrowFixture(
        account,
        publicClient,
        walletClient,
        artifact
      );
      const chainNow = await moveToFirstBorrowLookaheadState(
        account,
        publicClient,
        walletClient,
        testClient,
        poolAddress
      );

      await testClient.setBalance({
        address: competing.account.address,
        value: 10n ** 24n
      });

      const snapshotOnlyConfig = buildRepresentativeBorrowLookaheadConfig(poolAddress, account.address, {
        enableSimulationBackedBorrowSynthesis: false
      });
      const rawPlanningSnapshot = await new AjnaRpcSnapshotSource(snapshotOnlyConfig, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();
      const borrowCandidate = buildRepresentativeBorrowAbortCandidate(
        rawPlanningSnapshot,
        snapshotOnlyConfig
      );
      const planningSnapshot = {
        ...rawPlanningSnapshot,
        candidates: [borrowCandidate]
      };
      const plan = planCycle(planningSnapshot, snapshotOnlyConfig);

      expect(plan.intent).toBe("BORROW");
      expect(plan.selectedCandidateId).toBeDefined();

      const result = await runCycle(snapshotOnlyConfig, {
        snapshotSource: {
          getSnapshot: (() => {
            let callCount = 0;

            return async () => {
              callCount += 1;
              if (callCount === 1) {
                return planningSnapshot;
              }

              const competingHash = await competing.walletClient.writeContract({
                account: competing.account,
                chain: undefined,
                address: poolAddress,
                abi: ajnaPoolAbi,
                functionName: "updateInterest"
              });
              await competing.publicClient.waitForTransactionReceipt({ hash: competingHash });

              const freshChainNow = Number((await publicClient.getBlock()).timestamp);
              return new AjnaRpcSnapshotSource(snapshotOnlyConfig, {
                publicClient,
                now: () => freshChainNow
              }).getSnapshot();
            };
          })()
        },
        executor: createAjnaExecutionBackend(snapshotOnlyConfig)
      });

      expect(result.status).toBe("ABORTED");
      expect(result.reason).toMatch(/pool state changed|candidate is no longer valid/i);
      expect(result.transactionHashes).toHaveLength(0);
    },
    180_000
  );

  itBaseStress(
    "aborts when another lender adds quote between planning and execution",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const competing = createClientsForPrivateKey(COMPETING_ANVIL_PRIVATE_KEY);
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const poolAddress = await createQuoteOnlyBorrowFixture(
        account,
        publicClient,
        walletClient,
        artifact
      );
      const chainNow = await moveToFirstBorrowLookaheadState(
        account,
        publicClient,
        walletClient,
        testClient,
        poolAddress
      );

      await testClient.setBalance({
        address: competing.account.address,
        value: 10n ** 24n
      });

      const snapshotOnlyConfig = buildRepresentativeBorrowLookaheadConfig(poolAddress, account.address, {
        enableSimulationBackedBorrowSynthesis: false
      });
      const rawPlanningSnapshot = await new AjnaRpcSnapshotSource(snapshotOnlyConfig, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();
      const borrowCandidate = buildRepresentativeBorrowAbortCandidate(
        rawPlanningSnapshot,
        snapshotOnlyConfig
      );
      const planningSnapshot = {
        ...rawPlanningSnapshot,
        candidates: [borrowCandidate]
      };
      const plan = planCycle(planningSnapshot, snapshotOnlyConfig);

      expect(plan.intent).toBe("BORROW");
      expect(plan.selectedCandidateId).toBeDefined();

      const quoteTokenAddress = requireSnapshotMetadataString(
        planningSnapshot,
        "quoteTokenAddress"
      ) as `0x${string}`;

      const result = await runCycle(snapshotOnlyConfig, {
        snapshotSource: {
          getSnapshot: (() => {
            let callCount = 0;

            return async () => {
              callCount += 1;
              if (callCount === 1) {
                return planningSnapshot;
              }

              await mintToken(
                competing.walletClient,
                competing.publicClient,
                artifact,
                quoteTokenAddress,
                competing.account.address,
                100n * 10n ** 18n
              );
              await approveToken(
                competing.walletClient,
                competing.publicClient,
                quoteTokenAddress,
                poolAddress,
                100n * 10n ** 18n,
                artifact.abi
              );

              const latestBlock = await competing.publicClient.getBlock();
              const competingHash = await competing.walletClient.writeContract({
                account: competing.account,
                chain: undefined,
                address: poolAddress,
                abi: ajnaPoolAbi,
                functionName: "addQuoteToken",
                args: [50n * 10n ** 18n, 3000n, latestBlock.timestamp + 3600n]
              });
              await competing.publicClient.waitForTransactionReceipt({ hash: competingHash });

              const freshChainNow = Number((await publicClient.getBlock()).timestamp);
              return new AjnaRpcSnapshotSource(snapshotOnlyConfig, {
                publicClient,
                now: () => freshChainNow
              }).getSnapshot();
            };
          })()
        },
        executor: createAjnaExecutionBackend(snapshotOnlyConfig)
      });

      expect(result.status).toBe("ABORTED");
      expect(result.reason).toMatch(/pool state changed|candidate is no longer valid/i);
      expect(result.transactionHashes).toHaveLength(0);
    },
    180_000
  );

  registerBaseFactoryLendTests({
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
  });
});

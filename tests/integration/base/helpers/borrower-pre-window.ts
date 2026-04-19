import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  forecastAjnaNextEligibleRate,
  planCycle,
  resolveKeeperConfig
} from "../../../../src/index.js";
import {
  approximatePreWindowBorrowForecast,
  FORK_TIME_SKIP_SECONDS,
  type ApproximatePreWindowBorrowForecast,
  type ApproximatePreWindowBorrowState
} from "./protocol.js";
import {
  EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_AMOUNTS_WAD,
  EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_LIMIT_INDEXES,
  EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_EXISTING_SCENARIOS,
  EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_AMOUNTS_WAD,
  EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_LOOKAHEAD_UPDATES,
  EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_TARGET_OFFSETS_BPS,
  EXPERIMENTAL_COMPLEX_PREWINDOW_LEND_SCENARIOS,
  EXPERIMENTAL_MANUAL_BRAND_NEW_SAME_CYCLE_CONFIG_CANDIDATES,
  EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_AMOUNTS_WAD,
  EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_LIMIT_INDEXES,
  EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_TARGET_OFFSETS_BPS,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_SCENARIOS,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_TARGET_OFFSETS_BPS,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_AMOUNTS_WAD,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_LIMIT_INDEXES,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_TARGET_OFFSETS_BPS,
  EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROWER_SCENARIOS
} from "./fixtures.js";
import {
  LOCAL_RPC_URL,
  approveToken,
  advanceAndApplyEligibleUpdates,
  capturePassiveRateBranch,
  computeStepUpMargin,
  deployMockToken,
  deployPoolThroughFactory,
  drawDebtIntoRateStateForTest,
  executeRateProbeBranch,
  extractAjnaRateState,
  mintToken,
  readCurrentRateInfo,
  requireSnapshotMetadataValue
} from "./shared.js";

type BorrowerPreWindowHelperDeps = {
  createQuoteOnlyBorrowFixture: (...args: any[]) => Promise<`0x${string}`>;
  createExistingBorrowerSameCycleFixture: (...args: any[]) => Promise<`0x${string}` | undefined>;
  createExistingBorrowerMultiBucketFixture: (...args: any[]) => Promise<`0x${string}` | undefined>;
};

export function createBaseFactoryBorrowerPreWindowHelpers(
  deps: BorrowerPreWindowHelperDeps
) {
  const {
    createQuoteOnlyBorrowFixture,
    createExistingBorrowerSameCycleFixture,
    createExistingBorrowerMultiBucketFixture
  } = deps;

  async function createDeterministicPreWindowBorrowFixture(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    const failures: string[] = [];
    const poolAddress = await createQuoteOnlyBorrowFixture(
      account,
      publicClient,
      walletClient,
      artifact
    );

    await testClient.increaseTime({
      seconds: FORK_TIME_SKIP_SECONDS
    });
    await testClient.mine({
      blocks: 1
    });

    const updateHash = await walletClient.writeContract({
      account,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "updateInterest"
    });
    await publicClient.waitForTransactionReceipt({ hash: updateHash });

    const chainNow = Number((await publicClient.getBlock()).timestamp);

    for (const candidate of EXPERIMENTAL_MANUAL_BRAND_NEW_SAME_CYCLE_CONFIG_CANDIDATES) {
      const config = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: candidate.targetRateBps,
        toleranceBps: candidate.toleranceBps,
        toleranceMode: candidate.toleranceMode,
        completionPolicy: "next_move_would_overshoot",
        enableSimulationBackedLendSynthesis: false,
        enableSimulationBackedBorrowSynthesis: false,
        enableHeuristicLendSynthesis: false,
        enableHeuristicBorrowSynthesis: false,
        executionBufferBps: 0,
        maxQuoteTokenExposure: "1000000000000000000000000",
        maxBorrowExposure: "1000000000000000000000",
        snapshotAgeMaxSeconds: 3600,
        minTimeBeforeRateWindowSeconds: 120,
        minExecutableActionQuoteToken: "1",
        recheckBeforeSubmit: true,
        borrowerAddress: account.address,
        simulationSenderAddress: account.address,
        drawDebtLimitIndexes: [...candidate.drawDebtLimitIndexes],
        drawDebtCollateralAmounts: [...candidate.drawDebtCollateralAmounts]
      });
      const snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();

      if (
        snapshot.secondsUntilNextRateUpdate > 0 &&
        snapshot.currentRateBps < config.targetRateBps &&
        snapshot.predictedNextOutcome !== "STEP_UP"
      ) {
        return {
          poolAddress,
          chainNow,
          config,
          snapshot
        };
      }

      failures.push(
        `target=${candidate.targetRateBps}: currentRate=${snapshot.currentRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} next=${snapshot.predictedNextOutcome}`
      );
    }

    throw new Error(
      `deterministic pre-window borrower fixture did not land on the expected not-due upward-steering state: ${failures.join("; ")}`
    );
  }

  async function findExistingBorrowerPreWindowBorrowMatch(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    for (const scenario of EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_SCENARIOS) {
      const poolAddress = await createExistingBorrowerSameCycleFixture(
        account,
        publicClient,
        walletClient,
        artifact,
        scenario
      );
      if (!poolAddress) {
        continue;
      }

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      const updateHash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "updateInterest"
      });
      await publicClient.waitForTransactionReceipt({ hash: updateHash });

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const [loansInfo, borrowerInfo, currentRateInfo] = await Promise.all([
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "loansInfo",
          args: []
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "borrowerInfo",
          args: [account.address]
        }),
        readCurrentRateInfo(publicClient, poolAddress)
      ]);
      const noOfLoans = loansInfo[2] as bigint;
      const borrowerT0Debt = borrowerInfo[0] as bigint;
      const borrowerCollateral = borrowerInfo[1] as bigint;
      if (noOfLoans === 0n || (borrowerT0Debt === 0n && borrowerCollateral === 0n)) {
        continue;
      }

      for (const targetOffsetBps of EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_TARGET_OFFSETS_BPS) {
        const targetRateBps = currentRateInfo.currentRateBps + targetOffsetBps;
        const baselineConfig = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps,
          toleranceBps: 50,
          toleranceMode: "absolute",
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
          enableSimulationBackedBorrowSynthesis: false,
          enableHeuristicBorrowSynthesis: false,
          drawDebtLimitIndexes: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES],
          drawDebtCollateralAmounts: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS]
        });
        const baselineSnapshot = await new AjnaRpcSnapshotSource(baselineConfig, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
        if (
          baselineSnapshot.secondsUntilNextRateUpdate <= 0 ||
          baselineSnapshot.currentRateBps >= targetRateBps ||
          baselineSnapshot.predictedNextOutcome === "STEP_UP"
        ) {
          continue;
        }

        const config = resolveKeeperConfig({
          ...baselineConfig,
          enableSimulationBackedBorrowSynthesis: true
        });
        const snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
        const borrowCandidate = snapshot.candidates.find(
          (candidate) => candidate.intent === "BORROW"
        );
        if (!borrowCandidate) {
          continue;
        }

        const borrowOnlySnapshot = {
          ...snapshot,
          candidates: [borrowCandidate]
        };
        const plan = planCycle(borrowOnlySnapshot, config);
        if (plan.intent !== "BORROW") {
          continue;
        }

        return {
          poolAddress,
          chainNow,
          scenario,
          config,
          snapshot: borrowOnlySnapshot,
          borrowCandidate,
          plan
        };
      }
    }

    return undefined;
  }

  async function findComplexOngoingPreWindowBorrowMatch(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    competing: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    await testClient.setBalance({
      address: competing.account.address,
      value: 10n ** 24n
    });

    for (const [scenarioIndex, scenario] of EXPERIMENTAL_COMPLEX_PREWINDOW_LEND_SCENARIOS.entries()) {
      const collateralToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        `Complex Pre Borrow Collateral ${scenarioIndex}`,
        `CPBC${scenarioIndex}`
      );
      const quoteToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        `Complex Pre Borrow Quote ${scenarioIndex}`,
        `CPBQ${scenarioIndex}`
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
        await mintToken(
          walletClient,
          publicClient,
          artifact,
          tokenAddress,
          competing.account.address,
          1_000_000n * 10n ** 18n
        );
      }

      const poolAddress = await deployPoolThroughFactory(
        walletClient,
        publicClient,
        collateralToken,
        quoteToken
      );

      for (const actorClients of [
        { walletClient, publicClient },
        { walletClient: competing.walletClient, publicClient: competing.publicClient }
      ]) {
        await approveToken(
          actorClients.walletClient,
          actorClients.publicClient,
          quoteToken,
          poolAddress,
          1_000_000n * 10n ** 18n,
          artifact.abi
        );
        await approveToken(
          actorClients.walletClient,
          actorClients.publicClient,
          collateralToken,
          poolAddress,
          1_000_000n * 10n ** 18n,
          artifact.abi
        );
      }

      try {
        const latestBlock = await publicClient.getBlock();
        const addQuoteHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "addQuoteToken",
          args: [
            scenario.initialQuoteAmount * 10n ** 18n,
            3_000n,
            latestBlock.timestamp + 3600n
          ]
        });
        await publicClient.waitForTransactionReceipt({ hash: addQuoteHash });

        const drawDebtHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "drawDebt",
          args: [
            account.address,
            scenario.initialBorrowAmount * 10n ** 18n,
            3_000n,
            scenario.initialCollateralAmount * 10n ** 18n
          ]
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

      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
      } catch {
        continue;
      }

      try {
        const competingBlock = await competing.publicClient.getBlock();
        const competingAddQuoteHash = await competing.walletClient.writeContract({
          account: competing.account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "addQuoteToken",
          args: [
            scenario.competingQuoteAmount * 10n ** 18n,
            3_000n,
            competingBlock.timestamp + 3600n
          ]
        });
        await competing.publicClient.waitForTransactionReceipt({ hash: competingAddQuoteHash });

        const competingDrawDebtHash = await competing.walletClient.writeContract({
          account: competing.account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "drawDebt",
          args: [
            competing.account.address,
            scenario.competingBorrowAmount * 10n ** 18n,
            3_000n,
            scenario.competingCollateralAmount * 10n ** 18n
          ]
        });
        await competing.publicClient.waitForTransactionReceipt({ hash: competingDrawDebtHash });

        if (scenario.primaryFollowupQuoteAmount > 0n) {
          const primaryBlock = await publicClient.getBlock();
          const primaryFollowupQuoteHash = await walletClient.writeContract({
            account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "addQuoteToken",
            args: [
              scenario.primaryFollowupQuoteAmount * 10n ** 18n,
              3_000n,
              primaryBlock.timestamp + 3600n
            ]
          });
          await publicClient.waitForTransactionReceipt({ hash: primaryFollowupQuoteHash });
        }

        if (scenario.competingFollowupBorrowAmount > 0n) {
          const competingFollowupBorrowHash = await competing.walletClient.writeContract({
            account: competing.account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "drawDebt",
            args: [
              competing.account.address,
              scenario.competingFollowupBorrowAmount * 10n ** 18n,
              3_000n,
              scenario.competingCollateralAmount * 10n ** 18n
            ]
          });
          await competing.publicClient.waitForTransactionReceipt({
            hash: competingFollowupBorrowHash
          });
        }
      } catch {
        continue;
      }

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const [loansInfo, borrowerInfo, currentRateInfo] = await Promise.all([
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "loansInfo",
          args: []
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "borrowerInfo",
          args: [account.address]
        }),
        readCurrentRateInfo(publicClient, poolAddress)
      ]);
      const noOfLoans = loansInfo[2] as bigint;
      const borrowerT0Debt = borrowerInfo[0] as bigint;
      const borrowerCollateral = borrowerInfo[1] as bigint;
      if (noOfLoans === 0n || (borrowerT0Debt === 0n && borrowerCollateral === 0n)) {
        continue;
      }

      for (const targetOffsetBps of EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_TARGET_OFFSETS_BPS) {
        const targetRateBps = currentRateInfo.currentRateBps + targetOffsetBps;
        const baselineConfig = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps,
          toleranceBps: 50,
          toleranceMode: "absolute",
          completionPolicy: "next_move_would_overshoot",
          enableSimulationBackedLendSynthesis: false,
          enableSimulationBackedBorrowSynthesis: false,
          enableHeuristicLendSynthesis: false,
          enableHeuristicBorrowSynthesis: false,
          executionBufferBps: 0,
          maxQuoteTokenExposure: "1000000000000000000000000",
          maxBorrowExposure: "1000000000000000000000",
          snapshotAgeMaxSeconds: 3600,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: true,
          borrowerAddress: account.address,
          simulationSenderAddress: account.address,
          drawDebtLimitIndexes: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES],
          drawDebtCollateralAmounts: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS]
        });
        const baselineSnapshot = await new AjnaRpcSnapshotSource(baselineConfig, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
        if (
          baselineSnapshot.secondsUntilNextRateUpdate <= 0 ||
          baselineSnapshot.currentRateBps >= targetRateBps ||
          baselineSnapshot.predictedNextOutcome === "STEP_UP"
        ) {
          continue;
        }

        const config = resolveKeeperConfig({
          ...baselineConfig,
          enableSimulationBackedBorrowSynthesis: true
        });
        const snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
        const borrowCandidate = snapshot.candidates.find(
          (candidate) => candidate.intent === "BORROW"
        );
        if (!borrowCandidate) {
          continue;
        }

        const borrowOnlySnapshot = {
          ...snapshot,
          candidates: [borrowCandidate]
        };
        const plan = planCycle(borrowOnlySnapshot, config);
        if (plan.intent !== "BORROW") {
          continue;
        }

        return {
          poolAddress,
          chainNow,
          scenarioIndex,
          config,
          snapshot: borrowOnlySnapshot,
          borrowCandidate,
          plan
        };
      }
    }

    return undefined;
  }

  async function findManualComplexOngoingPreWindowBorrowMatch(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    competing: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    const observations: string[] = [];
    await testClient.setBalance({
      address: competing.account.address,
      value: 10n ** 24n
    });

    for (const [scenarioIndex, scenario] of EXPERIMENTAL_COMPLEX_PREWINDOW_LEND_SCENARIOS.entries()) {
      const collateralToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        `Complex Manual Pre Borrow Collateral ${scenarioIndex}`,
        `CMPBC${scenarioIndex}`
      );
      const quoteToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        `Complex Manual Pre Borrow Quote ${scenarioIndex}`,
        `CMPBQ${scenarioIndex}`
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
        await mintToken(
          walletClient,
          publicClient,
          artifact,
          tokenAddress,
          competing.account.address,
          1_000_000n * 10n ** 18n
        );
      }

      const poolAddress = await deployPoolThroughFactory(
        walletClient,
        publicClient,
        collateralToken,
        quoteToken
      );

      for (const actorClients of [
        { walletClient, publicClient },
        { walletClient: competing.walletClient, publicClient: competing.publicClient }
      ]) {
        await approveToken(
          actorClients.walletClient,
          actorClients.publicClient,
          quoteToken,
          poolAddress,
          1_000_000n * 10n ** 18n,
          artifact.abi
        );
        await approveToken(
          actorClients.walletClient,
          actorClients.publicClient,
          collateralToken,
          poolAddress,
          1_000_000n * 10n ** 18n,
          artifact.abi
        );
      }

      try {
        const latestBlock = await publicClient.getBlock();
        const addQuoteHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "addQuoteToken",
          args: [
            scenario.initialQuoteAmount * 10n ** 18n,
            3_000n,
            latestBlock.timestamp + 3600n
          ]
        });
        await publicClient.waitForTransactionReceipt({ hash: addQuoteHash });

        const drawDebtHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "drawDebt",
          args: [
            account.address,
            scenario.initialBorrowAmount * 10n ** 18n,
            3_000n,
            scenario.initialCollateralAmount * 10n ** 18n
          ]
        });
        await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });
      } catch {
        observations.push(`scenario ${scenarioIndex}: initial primary positioning failed`);
        continue;
      }

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
      } catch {
        observations.push(`scenario ${scenarioIndex}: initial updateInterest failed`);
        continue;
      }

      try {
        const competingBlock = await competing.publicClient.getBlock();
        const competingAddQuoteHash = await competing.walletClient.writeContract({
          account: competing.account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "addQuoteToken",
          args: [
            scenario.competingQuoteAmount * 10n ** 18n,
            3_000n,
            competingBlock.timestamp + 3600n
          ]
        });
        await competing.publicClient.waitForTransactionReceipt({ hash: competingAddQuoteHash });

        const competingDrawDebtHash = await competing.walletClient.writeContract({
          account: competing.account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "drawDebt",
          args: [
            competing.account.address,
            scenario.competingBorrowAmount * 10n ** 18n,
            3_000n,
            scenario.competingCollateralAmount * 10n ** 18n
          ]
        });
        await competing.publicClient.waitForTransactionReceipt({ hash: competingDrawDebtHash });

        if (scenario.primaryFollowupQuoteAmount > 0n) {
          const primaryBlock = await publicClient.getBlock();
          const primaryFollowupQuoteHash = await walletClient.writeContract({
            account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "addQuoteToken",
            args: [
              scenario.primaryFollowupQuoteAmount * 10n ** 18n,
              3_000n,
              primaryBlock.timestamp + 3600n
            ]
          });
          await publicClient.waitForTransactionReceipt({ hash: primaryFollowupQuoteHash });
        }

        if (scenario.competingFollowupBorrowAmount > 0n) {
          const competingFollowupBorrowHash = await competing.walletClient.writeContract({
            account: competing.account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "drawDebt",
            args: [
              competing.account.address,
              scenario.competingFollowupBorrowAmount * 10n ** 18n,
              3_000n,
              scenario.competingCollateralAmount * 10n ** 18n
            ]
          });
          await competing.publicClient.waitForTransactionReceipt({
            hash: competingFollowupBorrowHash
          });
        }
      } catch {
        observations.push(`scenario ${scenarioIndex}: not-due competing positioning failed`);
        continue;
      }

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const [loansInfo, borrowerInfo, currentRateInfo] = await Promise.all([
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "loansInfo",
          args: []
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "borrowerInfo",
          args: [account.address]
        }),
        readCurrentRateInfo(publicClient, poolAddress)
      ]);
      const noOfLoans = loansInfo[2] as bigint;
      const borrowerT0Debt = borrowerInfo[0] as bigint;
      const borrowerCollateral = borrowerInfo[1] as bigint;
      if (noOfLoans === 0n || (borrowerT0Debt === 0n && borrowerCollateral === 0n)) {
        observations.push(`scenario ${scenarioIndex}: no live borrower remained after setup`);
        continue;
      }

      for (const targetOffsetBps of EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_TARGET_OFFSETS_BPS) {
        const targetRateBps = currentRateInfo.currentRateBps + targetOffsetBps;
        const config = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps,
          toleranceBps: 50,
          toleranceMode: "absolute",
          completionPolicy: "next_move_would_overshoot",
          enableSimulationBackedLendSynthesis: false,
          enableSimulationBackedBorrowSynthesis: false,
          enableHeuristicLendSynthesis: false,
          enableHeuristicBorrowSynthesis: false,
          executionBufferBps: 0,
          maxQuoteTokenExposure: "1000000000000000000000000",
          maxBorrowExposure: "1000000000000000000000",
          snapshotAgeMaxSeconds: 3600,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: true,
          borrowerAddress: account.address,
          simulationSenderAddress: account.address,
          drawDebtLimitIndexes: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES],
          drawDebtCollateralAmounts: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS]
        });
        const snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();

        if (
          snapshot.secondsUntilNextRateUpdate <= 0 ||
          snapshot.currentRateBps >= targetRateBps ||
          snapshot.predictedNextOutcome === "STEP_UP"
        ) {
          observations.push(
            `scenario ${scenarioIndex}/target ${targetRateBps}: currentRate=${snapshot.currentRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} next=${snapshot.predictedNextOutcome}`
          );
          continue;
        }

        for (const lookaheadUpdates of EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_LOOKAHEAD_UPDATES) {
          const { passivePath, passiveDistanceToTargetBps } = await capturePassiveRateBranch(
            testClient,
            targetRateBps,
            () =>
              advanceAndApplyEligibleUpdates(
                account,
                publicClient,
                walletClient,
                testClient,
                config,
                lookaheadUpdates
              )
          );

          for (const limitIndex of EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES) {
            for (const rawCollateralAmount of EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS) {
              const collateralAmount = BigInt(rawCollateralAmount);

              for (const amount of EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_AMOUNTS_WAD) {
                const probe = await executeRateProbeBranch({
                  testClient,
                  targetRateBps,
                  observations,
                  passivePath,
                  label: `scenario=${scenarioIndex} target=${targetRateBps} updates=${lookaheadUpdates} limit=${limitIndex} collateral=${collateralAmount.toString()} amount=${amount.toString()}`,
                  runBranch: async () => {
                    const drawDebtHash = await walletClient.writeContract({
                      account,
                      chain: undefined,
                      address: poolAddress,
                      abi: ajnaPoolAbi,
                      functionName: "drawDebt",
                      args: [account.address, amount, BigInt(limitIndex), collateralAmount]
                    });
                    await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

                    return advanceAndApplyEligibleUpdates(
                      account,
                      publicClient,
                      walletClient,
                      testClient,
                      config,
                      lookaheadUpdates
                    );
                  }
                });

                if (
                  probe.activePath !== undefined &&
                  probe.activePath.currentRateBps > passivePath.currentRateBps &&
                  (probe.activeDistanceToTargetBps ?? Number.POSITIVE_INFINITY) <
                    passiveDistanceToTargetBps
                ) {
                  return {
                    observations,
                    positiveMatch: {
                      poolAddress,
                      chainNow,
                      scenarioIndex,
                      config,
                      amount,
                      limitIndex,
                      collateralAmount,
                      lookaheadUpdates,
                      passiveRateBps: passivePath.currentRateBps,
                      activeRateBps: probe.activePath.currentRateBps
                    }
                  };
                }
              }
            }
          }
        }
      }
    }

    return {
      observations,
      positiveMatch: undefined
    };
  }

  async function findManualExistingBorrowerPreWindowBorrowImprovement(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` },
    options: {
      scenarios?: readonly {
        initialQuoteAmount: bigint;
        borrowAmount: bigint;
        collateralAmount: bigint;
      }[];
      targetOffsetsBps?: readonly number[];
      lookaheadUpdates?: readonly number[];
      limitIndexes?: readonly number[];
      collateralAmounts?: readonly string[];
      amounts?: readonly bigint[];
    } = {}
  ): Promise<any> {
    const observations: string[] = [];
    const scenarios = options.scenarios ?? EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_SCENARIOS;

    for (const scenario of scenarios) {
      const poolAddress = await createExistingBorrowerSameCycleFixture(
        account,
        publicClient,
        walletClient,
        artifact,
        scenario
      );
      if (!poolAddress) {
        observations.push(
          `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()}: fixture creation failed`
        );
        continue;
      }

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
      } catch (error) {
        observations.push(
          `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()}: initial updateInterest failed=${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const [loansInfo, borrowerInfo, currentRateInfo] = await Promise.all([
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "loansInfo",
          args: []
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "borrowerInfo",
          args: [account.address]
        }),
        readCurrentRateInfo(publicClient, poolAddress)
      ]);
      const noOfLoans = loansInfo[2] as bigint;
      const borrowerT0Debt = borrowerInfo[0] as bigint;
      const borrowerCollateral = borrowerInfo[1] as bigint;
      if (noOfLoans === 0n || (borrowerT0Debt === 0n && borrowerCollateral === 0n)) {
        observations.push(
          `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()}: no live borrower remained`
        );
        continue;
      }

      for (const targetOffsetBps of options.targetOffsetsBps ??
        EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_TARGET_OFFSETS_BPS) {
        const targetRateBps = currentRateInfo.currentRateBps + targetOffsetBps;
        const config = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps,
          toleranceBps: 50,
          toleranceMode: "absolute",
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
          drawDebtLimitIndexes: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES],
          drawDebtCollateralAmounts: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS]
        });
        const snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
        if (
          snapshot.secondsUntilNextRateUpdate <= 0 ||
          snapshot.currentRateBps >= targetRateBps ||
          snapshot.predictedNextOutcome === "STEP_UP"
        ) {
          observations.push(
            `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()} target=${targetRateBps}: currentRate=${snapshot.currentRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} next=${snapshot.predictedNextOutcome}`
          );
          continue;
        }

        for (const lookaheadUpdates of options.lookaheadUpdates ?? ([2] as const)) {
          const { passivePath, passiveDistanceToTargetBps } = await capturePassiveRateBranch(
            testClient,
            targetRateBps,
            () =>
              advanceAndApplyEligibleUpdates(
                account,
                publicClient,
                walletClient,
                testClient,
                config,
                lookaheadUpdates
              )
          );

          for (const limitIndex of options.limitIndexes ??
            EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_LIMIT_INDEXES) {
            for (const rawCollateralAmount of options.collateralAmounts ??
              EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_COLLATERAL_AMOUNTS) {
              const collateralAmount = BigInt(rawCollateralAmount);

              for (const amount of options.amounts ??
                EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_AMOUNTS_WAD) {
                const probe = await executeRateProbeBranch({
                  testClient,
                  targetRateBps,
                  observations,
                  passivePath,
                  label: `scenario=${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()} target=${targetRateBps} updates=${lookaheadUpdates} limit=${limitIndex} collateral=${collateralAmount.toString()} amount=${amount.toString()}`,
                  runBranch: async () => {
                    const drawDebtHash = await walletClient.writeContract({
                      account,
                      chain: undefined,
                      address: poolAddress,
                      abi: ajnaPoolAbi,
                      functionName: "drawDebt",
                      args: [account.address, amount, BigInt(limitIndex), collateralAmount]
                    });
                    await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

                    return advanceAndApplyEligibleUpdates(
                      account,
                      publicClient,
                      walletClient,
                      testClient,
                      config,
                      lookaheadUpdates
                    );
                  }
                });

                if (
                  probe.activePath !== undefined &&
                  probe.activePath.currentRateBps > passivePath.currentRateBps &&
                  (probe.activeDistanceToTargetBps ?? Number.POSITIVE_INFINITY) <
                    passiveDistanceToTargetBps
                ) {
                  return {
                    observations,
                    positiveMatch: {
                      poolAddress,
                      chainNow,
                      scenario,
                      config,
                      amount,
                      limitIndex,
                      collateralAmount,
                      lookaheadUpdates,
                      passiveRateBps: passivePath.currentRateBps,
                      activeRateBps: probe.activePath.currentRateBps
                    }
                  };
                }
              }
            }
          }
        }
      }
    }

    return {
      observations,
      positiveMatch: undefined
    };
  }

  async function findBoundaryDerivedExistingBorrowerPreWindowBorrowImprovement(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` },
    options: {
      targetRateBps?: number;
    } = {}
  ): Promise<any> {
    const observations: string[] = [];
    type BoundaryDerivedPureCandidate = {
      amount: bigint;
      collateralAmount: bigint;
      candidateMargin: bigint;
      predictedRateBps: number;
      predictedOutcome: ReturnType<typeof forecastAjnaNextEligibleRate>["predictedOutcome"];
      distanceToTargetBps: number;
    };
    type BoundaryDerivedRankedState = {
      poolAddress: `0x${string}`;
      chainNow: number;
      scenario: {
        initialQuoteAmount: bigint;
        borrowAmount: bigint;
        collateralAmount: bigint;
      };
      config: any;
      baselineMargin: bigint;
      baselinePrediction: ReturnType<typeof forecastAjnaNextEligibleRate>;
      pureCandidates: BoundaryDerivedPureCandidate[];
    };

    const rankedStates: BoundaryDerivedRankedState[] = [];

    for (const scenario of EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_EXISTING_SCENARIOS) {
      const poolAddress = await createExistingBorrowerSameCycleFixture(
        account,
        publicClient,
        walletClient,
        artifact,
        scenario
      );
      if (!poolAddress) {
        observations.push(
          `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()}: fixture creation failed`
        );
        continue;
      }

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
      } catch (error) {
        observations.push(
          `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()}: initial updateInterest failed=${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const config = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: options.targetRateBps ?? 1_000,
        toleranceBps: 50,
        toleranceMode: "absolute",
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
        drawDebtLimitIndexes: [...EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_LIMIT_INDEXES],
        drawDebtCollateralAmounts: [...EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_COLLATERAL_AMOUNTS]
      });
      const snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();
      if (
        snapshot.secondsUntilNextRateUpdate <= 0 ||
        snapshot.currentRateBps >= (options.targetRateBps ?? 1_000) ||
        snapshot.predictedNextOutcome === "STEP_UP"
      ) {
        observations.push(
          `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()}: currentRate=${snapshot.currentRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} next=${snapshot.predictedNextOutcome}`
        );
        continue;
      }

      const rateState = extractAjnaRateState(snapshot, chainNow);
      const baselineMargin = computeStepUpMargin(rateState);
      const baselinePrediction = forecastAjnaNextEligibleRate(rateState);
      const baselineNextDistance = Math.abs(
        baselinePrediction.predictedNextRateBps - config.targetRateBps
      );
      const pureCandidates: BoundaryDerivedPureCandidate[] = [];

      for (const rawCollateralAmount of EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_COLLATERAL_AMOUNTS) {
        const collateralAmount = BigInt(rawCollateralAmount);
        for (const amount of EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_AMOUNTS_WAD) {
          const candidateState = drawDebtIntoRateStateForTest(rateState, amount, collateralAmount);
          const prediction = forecastAjnaNextEligibleRate(candidateState);
          const distanceToTargetBps = Math.abs(
            prediction.predictedNextRateBps - config.targetRateBps
          );
          if (
            prediction.predictedOutcome !== "STEP_UP" &&
            distanceToTargetBps >= baselineNextDistance
          ) {
            continue;
          }

          pureCandidates.push({
            amount,
            collateralAmount,
            candidateMargin: computeStepUpMargin(candidateState),
            predictedRateBps: prediction.predictedNextRateBps,
            predictedOutcome: prediction.predictedOutcome,
            distanceToTargetBps
          });
        }
      }

      if (pureCandidates.length === 0) {
        observations.push(
          `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()}: no pure boundary candidate baselineNext=${baselinePrediction.predictedNextRateBps} baselineMargin=${baselineMargin.toString()}`
        );
        continue;
      }

      pureCandidates.sort((left, right) => {
        if (left.distanceToTargetBps !== right.distanceToTargetBps) {
          return left.distanceToTargetBps - right.distanceToTargetBps;
        }
        if (left.predictedOutcome !== right.predictedOutcome) {
          return left.predictedOutcome === "STEP_UP" ? -1 : 1;
        }
        if (left.candidateMargin !== right.candidateMargin) {
          return left.candidateMargin > right.candidateMargin ? -1 : 1;
        }
        if (left.collateralAmount !== right.collateralAmount) {
          return left.collateralAmount < right.collateralAmount ? -1 : 1;
        }
        if (left.amount !== right.amount) {
          return left.amount < right.amount ? -1 : 1;
        }
        return 0;
      });

      observations.push(
        `scenario ${scenario.initialQuoteAmount.toString()}/${scenario.borrowAmount.toString()}: baselineNext=${baselinePrediction.predictedNextRateBps} baselineMargin=${baselineMargin.toString()} bestPure=${pureCandidates
          .slice(0, 3)
          .map(
            (candidate) =>
              `${candidate.amount.toString()}/${candidate.collateralAmount.toString()}/${candidate.predictedRateBps}/${candidate.predictedOutcome}/${candidate.candidateMargin.toString()}`
          )
          .join(",")}`
      );

      rankedStates.push({
        poolAddress,
        chainNow,
        scenario,
        config,
        baselineMargin,
        baselinePrediction,
        pureCandidates
      });
    }

    rankedStates.sort((left, right) => {
      const leftBest = left.pureCandidates[0];
      const rightBest = right.pureCandidates[0];
      if (!leftBest && !rightBest) {
        return 0;
      }
      if (!leftBest) {
        return 1;
      }
      if (!rightBest) {
        return -1;
      }
      if (leftBest.distanceToTargetBps !== rightBest.distanceToTargetBps) {
        return leftBest.distanceToTargetBps - rightBest.distanceToTargetBps;
      }
      if (leftBest.predictedOutcome !== rightBest.predictedOutcome) {
        return leftBest.predictedOutcome === "STEP_UP" ? -1 : 1;
      }
      if (leftBest.candidateMargin !== rightBest.candidateMargin) {
        return leftBest.candidateMargin > rightBest.candidateMargin ? -1 : 1;
      }
      if (left.baselineMargin !== right.baselineMargin) {
        return left.baselineMargin > right.baselineMargin ? -1 : 1;
      }
      return 0;
    });

    for (const rankedState of rankedStates.slice(0, 1)) {
      for (const lookaheadUpdates of [2] as const) {
        const { passivePath, passiveDistanceToTargetBps } = await capturePassiveRateBranch(
          testClient,
          rankedState.config.targetRateBps,
          () =>
            advanceAndApplyEligibleUpdates(
              account,
              publicClient,
              walletClient,
              testClient,
              rankedState.config,
              lookaheadUpdates
            )
        );

        observations.push(
          `validating scenario ${rankedState.scenario.initialQuoteAmount.toString()}/${rankedState.scenario.borrowAmount.toString()} updates=${lookaheadUpdates}: passive=${passivePath.currentRateBps} baselineNext=${rankedState.baselinePrediction.predictedNextRateBps}`
        );

        for (const pureCandidate of rankedState.pureCandidates.slice(0, 2)) {
          for (const limitIndex of EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_LIMIT_INDEXES) {
            const collateralAmount = pureCandidate.collateralAmount;
            const amount = pureCandidate.amount;
            const probe = await executeRateProbeBranch({
              testClient,
              targetRateBps: rankedState.config.targetRateBps,
              observations,
              passivePath,
              label: `scenario=${rankedState.scenario.initialQuoteAmount.toString()}/${rankedState.scenario.borrowAmount.toString()} updates=${lookaheadUpdates} limit=${limitIndex} collateral=${collateralAmount.toString()} amount=${amount.toString()} pureNext=${pureCandidate.predictedRateBps}/${pureCandidate.predictedOutcome}`,
              runBranch: async () => {
                const drawDebtHash = await walletClient.writeContract({
                  account,
                  chain: undefined,
                  address: rankedState.poolAddress,
                  abi: ajnaPoolAbi,
                  functionName: "drawDebt",
                  args: [account.address, amount, BigInt(limitIndex), collateralAmount]
                });
                await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

                return advanceAndApplyEligibleUpdates(
                  account,
                  publicClient,
                  walletClient,
                  testClient,
                  rankedState.config,
                  lookaheadUpdates
                );
              }
            });

            if (
              probe.activePath !== undefined &&
              probe.activePath.currentRateBps > passivePath.currentRateBps &&
              (probe.activeDistanceToTargetBps ?? Number.POSITIVE_INFINITY) <
                passiveDistanceToTargetBps
            ) {
              return {
                observations,
                positiveMatch: {
                  poolAddress: rankedState.poolAddress,
                  chainNow: rankedState.chainNow,
                  scenario: rankedState.scenario,
                  config: rankedState.config,
                  amount,
                  limitIndex,
                  collateralAmount,
                  passiveRateBps: passivePath.currentRateBps,
                  activeRateBps: probe.activePath.currentRateBps
                }
              };
            }
          }
        }
      }
    }

    return {
      observations,
      positiveMatch: undefined
    };
  }

  async function findManualMultiBucketExistingBorrowerPreWindowBorrowImprovement(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    const observations: string[] = [];

    for (const scenario of EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROWER_SCENARIOS) {
      const poolAddress = await createExistingBorrowerMultiBucketFixture(
        account,
        publicClient,
        walletClient,
        artifact,
        scenario
      );
      if (!poolAddress) {
        observations.push(
          `multi-bucket scenario ${scenario.borrowAmount.toString()}: fixture creation failed`
        );
        continue;
      }

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      const updateHash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "updateInterest"
      }).catch(() => undefined);
      if (!updateHash) {
        observations.push(
          `multi-bucket scenario ${scenario.borrowAmount.toString()}: initial updateInterest failed`
        );
        continue;
      }
      await publicClient.waitForTransactionReceipt({ hash: updateHash });

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const [loansInfo, borrowerInfo, currentRateInfo] = await Promise.all([
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "loansInfo",
          args: []
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "borrowerInfo",
          args: [account.address]
        }),
        readCurrentRateInfo(publicClient, poolAddress)
      ]);
      const noOfLoans = loansInfo[2] as bigint;
      const borrowerT0Debt = borrowerInfo[0] as bigint;
      const borrowerCollateral = borrowerInfo[1] as bigint;
      if (noOfLoans === 0n || (borrowerT0Debt === 0n && borrowerCollateral === 0n)) {
        observations.push(
          `multi-bucket scenario ${scenario.borrowAmount.toString()}: borrower state vanished`
        );
        continue;
      }

      for (const targetOffsetBps of EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_TARGET_OFFSETS_BPS) {
        const targetRateBps = currentRateInfo.currentRateBps + targetOffsetBps;
        const config = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps,
          toleranceBps: 50,
          toleranceMode: "absolute",
          completionPolicy: "next_move_would_overshoot",
          executionBufferBps: 0,
          maxQuoteTokenExposure: "1000000000000000000000000",
          maxBorrowExposure: "1000000000000000000000",
          snapshotAgeMaxSeconds: 3600,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: true,
          borrowerAddress: account.address,
          simulationSenderAddress: account.address
        });
        const snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
        if (
          snapshot.secondsUntilNextRateUpdate <= 0 ||
          snapshot.currentRateBps >= targetRateBps ||
          snapshot.predictedNextOutcome === "STEP_UP"
        ) {
          observations.push(
            `multi-bucket scenario ${scenario.borrowAmount.toString()} target=${targetRateBps}: currentRate=${snapshot.currentRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} next=${snapshot.predictedNextOutcome}`
          );
          continue;
        }

        const { passivePath, passiveDistanceToTargetBps } = await capturePassiveRateBranch(
          testClient,
          targetRateBps,
          () =>
            advanceAndApplyEligibleUpdates(
              account,
              publicClient,
              walletClient,
              testClient,
              config,
              2
            )
        );

        const [
          [currentDebtWad, , , t0Debt2ToCollateralWad],
          [inflatorWad],
          [debtColEmaWad, lupt0DebtEmaWad, debtEmaWad, depositEmaWad],
          totalT0Debt,
          totalT0DebtInAuction
        ] = await Promise.all([
          publicClient.readContract({
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "debtInfo"
          }),
          publicClient.readContract({
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "inflatorInfo"
          }),
          publicClient.readContract({
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "emasInfo"
          }),
          publicClient.readContract({
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "totalT0Debt"
          }),
          publicClient.readContract({
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "totalT0DebtInAuction"
          })
        ]);
        const approximateState: ApproximatePreWindowBorrowState = {
          currentRateWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "currentRateWad"))),
          currentDebtWad,
          debtEmaWad,
          depositEmaWad,
          debtColEmaWad,
          lupt0DebtEmaWad,
          inflatorWad,
          totalT0Debt,
          totalT0DebtInAuction,
          t0Debt2ToCollateralWad,
          borrowerT0Debt,
          borrowerCollateral,
          secondsUntilNextRateUpdate: snapshot.secondsUntilNextRateUpdate
        };
        const approximateCandidates: Array<{
          limitIndex: number;
          collateralAmount: bigint;
          amount: bigint;
          forecast: ApproximatePreWindowBorrowForecast;
        }> = [];

        for (const limitIndex of EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_LIMIT_INDEXES) {
          for (const rawCollateralAmount of EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_COLLATERAL_AMOUNTS) {
            const collateralAmount = BigInt(rawCollateralAmount);
            for (const amount of EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_AMOUNTS_WAD) {
              const forecast = approximatePreWindowBorrowForecast(
                approximateState,
                scenario.deposits,
                amount,
                collateralAmount,
                config.targetRateBps
              );
              if (
                forecast.terminalDistanceToTargetBps >=
                  Math.abs(passivePath.currentRateBps - config.targetRateBps) &&
                forecast.nextDistanceToTargetBps >=
                  Math.abs(snapshot.predictedNextRateBps - config.targetRateBps)
              ) {
                continue;
              }
              approximateCandidates.push({
                limitIndex,
                collateralAmount,
                amount,
                forecast
              });
            }
          }
        }

        approximateCandidates.sort((left, right) => {
          if (left.forecast.terminalDistanceToTargetBps !== right.forecast.terminalDistanceToTargetBps) {
            return left.forecast.terminalDistanceToTargetBps - right.forecast.terminalDistanceToTargetBps;
          }
          if (left.forecast.nextDistanceToTargetBps !== right.forecast.nextDistanceToTargetBps) {
            return left.forecast.nextDistanceToTargetBps - right.forecast.nextDistanceToTargetBps;
          }
          if (left.forecast.nextOutcome !== right.forecast.nextOutcome) {
            return left.forecast.nextOutcome === "STEP_UP" ? -1 : 1;
          }
          if (left.collateralAmount !== right.collateralAmount) {
            return left.collateralAmount < right.collateralAmount ? -1 : 1;
          }
          return left.amount < right.amount ? -1 : left.amount > right.amount ? 1 : 0;
        });

        observations.push(
          `multi-bucket scenario ${scenario.borrowAmount.toString()} target=${targetRateBps}: approx=${approximateCandidates
            .slice(0, 4)
            .map(
              (candidate) =>
                `${candidate.amount.toString()}/${candidate.collateralAmount.toString()}/${candidate.limitIndex}/${candidate.forecast.nextRateBps}/${candidate.forecast.terminalRateBps}`
            )
            .join(",")}`
        );

        for (const candidate of approximateCandidates.slice(0, 6)) {
          const { limitIndex, collateralAmount, amount } = candidate;
          const probe = await executeRateProbeBranch({
            testClient,
            targetRateBps,
            observations,
            passivePath,
            label: `multi-bucket scenario=${scenario.borrowAmount.toString()} target=${targetRateBps} limit=${limitIndex} collateral=${collateralAmount.toString()} amount=${amount.toString()} approxNext=${candidate.forecast.nextRateBps} approxTerminal=${candidate.forecast.terminalRateBps}`,
            runBranch: async () => {
              const drawDebtHash = await walletClient.writeContract({
                account,
                chain: undefined,
                address: poolAddress,
                abi: ajnaPoolAbi,
                functionName: "drawDebt",
                args: [account.address, amount, BigInt(limitIndex), collateralAmount]
              });
              await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

              return advanceAndApplyEligibleUpdates(
                account,
                publicClient,
                walletClient,
                testClient,
                config,
                2
              );
            }
          });

          if (
            probe.activePath !== undefined &&
            probe.activePath.currentRateBps > passivePath.currentRateBps &&
            (probe.activeDistanceToTargetBps ?? Number.POSITIVE_INFINITY) <
              passiveDistanceToTargetBps
          ) {
            return {
              observations,
              positiveMatch: {
                poolAddress,
                chainNow,
                scenario,
                config,
                amount,
                limitIndex,
                collateralAmount,
                passiveRateBps: passivePath.currentRateBps,
                activeRateBps: probe.activePath.currentRateBps
              }
            };
          }
        }
      }
    }

    return {
      observations,
      positiveMatch: undefined
    };
  }

  return {
    createDeterministicPreWindowBorrowFixture,
    findExistingBorrowerPreWindowBorrowMatch,
    findComplexOngoingPreWindowBorrowMatch,
    findManualComplexOngoingPreWindowBorrowMatch,
    findManualExistingBorrowerPreWindowBorrowImprovement,
    findBoundaryDerivedExistingBorrowerPreWindowBorrowImprovement,
    findManualMultiBucketExistingBorrowerPreWindowBorrowImprovement
  };
}

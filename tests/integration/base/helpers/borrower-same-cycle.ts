import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  forecastAjnaNextEligibleRate,
  planCycle,
  resolveKeeperConfig
} from "../../../../src/index.js";
import {
  FORK_TIME_SKIP_SECONDS,
  deriveRequiredCollateralWad,
  type ApproximatePreWindowBorrowState
} from "./protocol.js";
import {
  EXPERIMENTAL_BOUNDARY_TARGETED_BORROWER_SCENARIOS,
  EXPERIMENTAL_BOUNDARY_TARGETED_PASSIVE_CYCLES,
  EXPERIMENTAL_BOUNDARY_TARGETED_SAME_CYCLE_COLLATERAL_AMOUNTS_WAD,
  EXPERIMENTAL_BOUNDARY_TARGETED_SAME_CYCLE_LIMIT_INDEXES,
  EXPERIMENTAL_MANUAL_BRAND_NEW_SAME_CYCLE_CONFIG_CANDIDATES,
  EXPERIMENTAL_MANUAL_SAME_CYCLE_BORROW_AMOUNTS_WAD,
  REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_CONFIG_CANDIDATES,
  REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_SCENARIOS
} from "./fixtures.js";
import {
  LOCAL_RPC_URL,
  advanceAndApplyEligibleUpdates,
  computeStepUpMargin,
  drawDebtIntoRateStateForTest,
  extractAjnaRateState,
  readCurrentRateInfo
} from "./shared.js";

type BorrowerSameCycleHelperDeps = {
  createQuoteOnlyBorrowFixture: (...args: any[]) => Promise<`0x${string}`>;
  createQuoteOnlyMultiBucketBorrowFixture: (...args: any[]) => Promise<`0x${string}`>;
  createExistingBorrowerSameCycleFixture: (...args: any[]) => Promise<`0x${string}` | undefined>;
  moveToFirstBorrowLookaheadState: (...args: any[]) => Promise<number>;
};

export function createBaseFactoryBorrowerSameCycleHelpers(
  deps: BorrowerSameCycleHelperDeps
) {
  const {
    createQuoteOnlyBorrowFixture,
    createQuoteOnlyMultiBucketBorrowFixture,
    createExistingBorrowerSameCycleFixture,
    moveToFirstBorrowLookaheadState
  } = deps;

  async function findExistingBorrowerSameCycleBorrowMatch(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` },
    options: {
      borrowSimulationLookaheadUpdates?: number;
      scenarios?: readonly {
        initialQuoteAmount: bigint;
        borrowAmount: bigint;
        collateralAmount: bigint;
      }[];
      configCandidates?: readonly {
        targetRateBps: number;
        toleranceBps: number;
        toleranceMode: "absolute" | "relative";
        drawDebtLimitIndexes: readonly number[];
        drawDebtCollateralAmounts: readonly string[];
      }[];
    } = {}
  ): Promise<any> {
    const scenarios = options.scenarios ?? REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_SCENARIOS;
    const configCandidates =
      options.configCandidates ?? REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_CONFIG_CANDIDATES;

    for (const scenario of scenarios) {
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
      const chainNow = await moveToFirstBorrowLookaheadState(
        account,
        publicClient,
        walletClient,
        testClient,
        poolAddress
      );
      const [loansInfo, borrowerInfo] = await Promise.all([
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
        })
      ]);
      const noOfLoans = loansInfo[2] as bigint;
      const borrowerT0Debt = borrowerInfo[0] as bigint;
      const borrowerCollateral = borrowerInfo[1] as bigint;
      if (noOfLoans === 0n || (borrowerT0Debt === 0n && borrowerCollateral === 0n)) {
        continue;
      }

      for (const candidate of configCandidates) {
        const heuristicConfig = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps: candidate.targetRateBps,
          toleranceBps: candidate.toleranceBps,
          toleranceMode: candidate.toleranceMode,
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
          enableHeuristicBorrowSynthesis: true,
          drawDebtLimitIndexes: [...candidate.drawDebtLimitIndexes],
          drawDebtCollateralAmounts: [...candidate.drawDebtCollateralAmounts],
          ...(options.borrowSimulationLookaheadUpdates === undefined
            ? {}
            : { borrowSimulationLookaheadUpdates: options.borrowSimulationLookaheadUpdates })
        });
        if (options.borrowSimulationLookaheadUpdates === 1) {
          const heuristicSnapshot = await new AjnaRpcSnapshotSource(heuristicConfig, {
            publicClient,
            now: () => chainNow
          }).getSnapshot();
          const heuristicBorrowCandidate = heuristicSnapshot.candidates.find(
            (innerCandidate) => innerCandidate.intent === "BORROW"
          );
          if (!heuristicBorrowCandidate) {
            continue;
          }
        }

        const config = resolveKeeperConfig({
          ...heuristicConfig,
          enableSimulationBackedBorrowSynthesis: true,
          enableHeuristicBorrowSynthesis: true
        });
        const snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
        const borrowCandidate = snapshot.candidates.find(
          (innerCandidate) => innerCandidate.intent === "BORROW"
        );
        if (!borrowCandidate) {
          continue;
        }

        const borrowOnlySnapshot = {
          ...snapshot,
          candidates: [borrowCandidate]
        };
        const plan = planCycle(borrowOnlySnapshot, config);
        if (plan.intent === "BORROW") {
          return {
            poolAddress,
            chainNow,
            config,
            snapshot: borrowOnlySnapshot,
            plan
          };
        }
      }
    }

    return undefined;
  }

  async function findManualExistingBorrowerSameCycleBorrowImprovement(
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
      configCandidates?: readonly {
        targetRateBps: number;
        toleranceBps: number;
        toleranceMode: "absolute" | "relative";
        drawDebtLimitIndexes: readonly number[];
        drawDebtCollateralAmounts: readonly string[];
      }[];
      drawDebtAmountsWad?: readonly bigint[];
    } = {}
  ): Promise<any> {
    const scenarios = options.scenarios ?? REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_SCENARIOS;
    const configCandidates =
      options.configCandidates ?? REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_CONFIG_CANDIDATES;
    const drawDebtAmountsWad =
      options.drawDebtAmountsWad ?? EXPERIMENTAL_MANUAL_SAME_CYCLE_BORROW_AMOUNTS_WAD;

    for (const scenario of scenarios) {
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

      const chainNow = await moveToFirstBorrowLookaheadState(
        account,
        publicClient,
        walletClient,
        testClient,
        poolAddress
      );
      const [loansInfo, borrowerInfo, baselineRateInfo] = await Promise.all([
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

      for (const candidate of configCandidates) {
        const config = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps: candidate.targetRateBps,
          toleranceBps: candidate.toleranceBps,
          toleranceMode: candidate.toleranceMode,
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
        if (snapshot.secondsUntilNextRateUpdate !== 0) {
          continue;
        }

        const passiveBranchId = await testClient.snapshot();
        let passiveRateBps: number;
        try {
          const updateHash = await walletClient.writeContract({
            account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "updateInterest"
          });
          await publicClient.waitForTransactionReceipt({ hash: updateHash });
          passiveRateBps = (await readCurrentRateInfo(publicClient, poolAddress)).currentRateBps;
        } finally {
          await testClient.revert({ id: passiveBranchId });
        }

        for (const limitIndex of candidate.drawDebtLimitIndexes) {
          for (const rawCollateralAmount of candidate.drawDebtCollateralAmounts) {
            const collateralAmount = BigInt(rawCollateralAmount);
            for (const amount of drawDebtAmountsWad) {
              const branchId = await testClient.snapshot();

              try {
                const drawDebtHash = await walletClient.writeContract({
                  account,
                  chain: undefined,
                  address: poolAddress,
                  abi: ajnaPoolAbi,
                  functionName: "drawDebt",
                  args: [account.address, amount, BigInt(limitIndex), collateralAmount]
                });
                await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

                const activeRateInfo = await readCurrentRateInfo(publicClient, poolAddress);
                if (
                  activeRateInfo.lastInterestRateUpdateTimestamp >
                    baselineRateInfo.lastInterestRateUpdateTimestamp &&
                  Math.abs(activeRateInfo.currentRateBps - candidate.targetRateBps) <
                    Math.abs(passiveRateBps - candidate.targetRateBps)
                ) {
                  return {
                    poolAddress,
                    chainNow,
                    scenario,
                    config,
                    amount,
                    limitIndex,
                    collateralAmount,
                    passiveRateBps,
                    activeRateBps: activeRateInfo.currentRateBps
                  };
                }
              } catch {
                // Ignore revert-heavy borrower probes; the positive case is the only thing we care about.
              } finally {
                await testClient.revert({ id: branchId });
              }
            }
          }
        }
      }
    }

    return undefined;
  }

  async function findManualBrandNewSameCycleBorrowImprovement(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` },
    options: {
      configCandidates?: readonly {
        targetRateBps: number;
        toleranceBps: number;
        toleranceMode: "absolute" | "relative";
        drawDebtLimitIndexes: readonly number[];
        drawDebtCollateralAmounts: readonly string[];
      }[];
      drawDebtAmountsWad?: readonly bigint[];
    } = {}
  ): Promise<any> {
    const configCandidates =
      options.configCandidates ?? EXPERIMENTAL_MANUAL_BRAND_NEW_SAME_CYCLE_CONFIG_CANDIDATES;
    const drawDebtAmountsWad =
      options.drawDebtAmountsWad ?? EXPERIMENTAL_MANUAL_SAME_CYCLE_BORROW_AMOUNTS_WAD;
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
    const baselineRateInfo = await readCurrentRateInfo(publicClient, poolAddress);

    for (const candidate of configCandidates) {
      const config = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: candidate.targetRateBps,
        toleranceBps: candidate.toleranceBps,
        toleranceMode: candidate.toleranceMode,
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
      if (snapshot.secondsUntilNextRateUpdate !== 0) {
        continue;
      }

      const passiveBranchId = await testClient.snapshot();
      let passiveRateBps: number;
      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
        passiveRateBps = (await readCurrentRateInfo(publicClient, poolAddress)).currentRateBps;
      } finally {
        await testClient.revert({ id: passiveBranchId });
      }

      for (const limitIndex of candidate.drawDebtLimitIndexes) {
        for (const rawCollateralAmount of candidate.drawDebtCollateralAmounts) {
          const collateralAmount = BigInt(rawCollateralAmount);
          for (const amount of drawDebtAmountsWad) {
            const branchId = await testClient.snapshot();

            try {
              const drawDebtHash = await walletClient.writeContract({
                account,
                chain: undefined,
                address: poolAddress,
                abi: ajnaPoolAbi,
                functionName: "drawDebt",
                args: [account.address, amount, BigInt(limitIndex), collateralAmount]
              });
              await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

              const activeRateInfo = await readCurrentRateInfo(publicClient, poolAddress);
              if (
                activeRateInfo.lastInterestRateUpdateTimestamp >
                  baselineRateInfo.lastInterestRateUpdateTimestamp &&
                Math.abs(activeRateInfo.currentRateBps - candidate.targetRateBps) <
                  Math.abs(passiveRateBps - candidate.targetRateBps)
              ) {
                return {
                  poolAddress,
                  chainNow,
                  config,
                  amount,
                  limitIndex,
                  collateralAmount,
                  passiveRateBps,
                  activeRateBps: activeRateInfo.currentRateBps
                };
              }
            } catch {
              // Ignore revert-heavy borrower probes; the positive case is the only thing we care about.
            } finally {
              await testClient.revert({ id: branchId });
            }
          }
        }
      }
    }

    return undefined;
  }

  async function findManualBrandNewFirstUpdateSameCycleBorrowImprovement(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    const configCandidates = [
      {
        targetRateBps: 950,
        toleranceBps: 50,
        toleranceMode: "absolute" as const,
        drawDebtLimitIndexes: [2750, 3000, 3250, 3500] as const,
        drawDebtCollateralAmounts: [
          "10000000000000000",
          "100000000000000000",
          "1000000000000000000",
          "10000000000000000000"
        ] as const
      },
      {
        targetRateBps: 1000,
        toleranceBps: 50,
        toleranceMode: "absolute" as const,
        drawDebtLimitIndexes: [2750, 3000, 3250, 3500] as const,
        drawDebtCollateralAmounts: [
          "10000000000000000",
          "100000000000000000",
          "1000000000000000000",
          "10000000000000000000"
        ] as const
      },
      {
        targetRateBps: 1050,
        toleranceBps: 50,
        toleranceMode: "absolute" as const,
        drawDebtLimitIndexes: [2750, 3000, 3250, 3500] as const,
        drawDebtCollateralAmounts: [
          "10000000000000000",
          "100000000000000000",
          "1000000000000000000",
          "10000000000000000000"
        ] as const
      }
    ] as const;
    const drawDebtAmountsWad = [
      10n ** 17n,
      5n * 10n ** 17n,
      10n ** 18n,
      2n * 10n ** 18n,
      5n * 10n ** 18n,
      10n * 10n ** 18n,
      20n * 10n ** 18n,
      50n * 10n ** 18n,
      100n * 10n ** 18n
    ] as const;

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

    const chainNow = Number((await publicClient.getBlock()).timestamp);
    const baselineRateInfo = await readCurrentRateInfo(publicClient, poolAddress);

    for (const candidate of configCandidates) {
      const config = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: candidate.targetRateBps,
        toleranceBps: candidate.toleranceBps,
        toleranceMode: candidate.toleranceMode,
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
      if (snapshot.secondsUntilNextRateUpdate !== 0) {
        continue;
      }

      const passiveBranchId = await testClient.snapshot();
      let passiveRateBps: number;
      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
        passiveRateBps = (await readCurrentRateInfo(publicClient, poolAddress)).currentRateBps;
      } finally {
        await testClient.revert({ id: passiveBranchId });
      }

      for (const limitIndex of candidate.drawDebtLimitIndexes) {
        for (const rawCollateralAmount of candidate.drawDebtCollateralAmounts) {
          const collateralAmount = BigInt(rawCollateralAmount);
          for (const amount of drawDebtAmountsWad) {
            const branchId = await testClient.snapshot();

            try {
              const drawDebtHash = await walletClient.writeContract({
                account,
                chain: undefined,
                address: poolAddress,
                abi: ajnaPoolAbi,
                functionName: "drawDebt",
                args: [account.address, amount, BigInt(limitIndex), collateralAmount]
              });
              await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

              const activeRateInfo = await readCurrentRateInfo(publicClient, poolAddress);
              if (
                activeRateInfo.lastInterestRateUpdateTimestamp >
                  baselineRateInfo.lastInterestRateUpdateTimestamp &&
                activeRateInfo.currentRateBps > passiveRateBps
              ) {
                return {
                  poolAddress,
                  chainNow,
                  config,
                  amount,
                  limitIndex,
                  collateralAmount,
                  passiveRateBps,
                  activeRateBps: activeRateInfo.currentRateBps
                };
              }
            } catch {
              // Ignore revert-heavy borrower probes; positive existence is what matters here.
            } finally {
              await testClient.revert({ id: branchId });
            }
          }
        }
      }
    }

    return undefined;
  }

  async function findManualBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    const depositLayouts = [
      [
        { amount: 100n * 10n ** 18n, bucketIndex: 3000 },
        { amount: 900n * 10n ** 18n, bucketIndex: 3250 }
      ],
      [
        { amount: 50n * 10n ** 18n, bucketIndex: 3000 },
        { amount: 950n * 10n ** 18n, bucketIndex: 3250 }
      ],
      [
        { amount: 100n * 10n ** 18n, bucketIndex: 3000 },
        { amount: 900n * 10n ** 18n, bucketIndex: 3500 }
      ],
      [
        { amount: 50n * 10n ** 18n, bucketIndex: 3000 },
        { amount: 950n * 10n ** 18n, bucketIndex: 3500 }
      ],
      [
        { amount: 100n * 10n ** 18n, bucketIndex: 2750 },
        { amount: 900n * 10n ** 18n, bucketIndex: 3000 }
      ],
      [
        { amount: 100n * 10n ** 18n, bucketIndex: 2750 },
        { amount: 900n * 10n ** 18n, bucketIndex: 3250 }
      ]
    ] as const;
    const borrowAmountsWad = [
      25n * 10n ** 18n,
      50n * 10n ** 18n,
      75n * 10n ** 18n,
      100n * 10n ** 18n,
      125n * 10n ** 18n,
      150n * 10n ** 18n,
      200n * 10n ** 18n
    ] as const;
    const limitIndexes = [3000, 3250, 3500, 4000] as const;
    const collateralMultiplierBps = [10_200, 10_500, 11_000] as const;

    for (const deposits of depositLayouts) {
      const poolAddress = await createQuoteOnlyMultiBucketBorrowFixture(
        account,
        publicClient,
        walletClient,
        artifact,
        deposits
      );

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const baselineRateInfo = await readCurrentRateInfo(publicClient, poolAddress);

      const passiveBranchId = await testClient.snapshot();
      let passiveRateBps: number;
      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
        passiveRateBps = (await readCurrentRateInfo(publicClient, poolAddress)).currentRateBps;
      } finally {
        await testClient.revert({ id: passiveBranchId });
      }

      for (const limitIndex of limitIndexes) {
        for (const amount of borrowAmountsWad) {
          for (const multiplierBps of collateralMultiplierBps) {
            const collateralAmount = deriveRequiredCollateralWad(amount, limitIndex, multiplierBps);
            const branchId = await testClient.snapshot();

            try {
              const drawDebtHash = await walletClient.writeContract({
                account,
                chain: undefined,
                address: poolAddress,
                abi: ajnaPoolAbi,
                functionName: "drawDebt",
                args: [account.address, amount, BigInt(limitIndex), collateralAmount]
              });
              await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

              const activeRateInfo = await readCurrentRateInfo(publicClient, poolAddress);
              if (
                activeRateInfo.lastInterestRateUpdateTimestamp >
                  baselineRateInfo.lastInterestRateUpdateTimestamp &&
                activeRateInfo.currentRateBps > passiveRateBps
              ) {
                return {
                  poolAddress,
                  chainNow,
                  deposits,
                  amount,
                  limitIndex,
                  collateralAmount,
                  passiveRateBps,
                  activeRateBps: activeRateInfo.currentRateBps
                };
              }
            } catch {
              // Ignore revert-heavy borrower probes; positive existence is what matters here.
            } finally {
              await testClient.revert({ id: branchId });
            }
          }
        }
      }
    }

    return undefined;
  }

  async function findBoundaryDiscoveredBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    const depositLayouts = [
      [
        { amount: 50n * 10n ** 18n, bucketIndex: 3000 },
        { amount: 950n * 10n ** 18n, bucketIndex: 3500 }
      ],
      [
        { amount: 100n * 10n ** 18n, bucketIndex: 3000 },
        { amount: 900n * 10n ** 18n, bucketIndex: 3500 }
      ],
      [
        { amount: 50n * 10n ** 18n, bucketIndex: 2750 },
        { amount: 950n * 10n ** 18n, bucketIndex: 3500 }
      ],
      [
        { amount: 100n * 10n ** 18n, bucketIndex: 3000 },
        { amount: 900n * 10n ** 18n, bucketIndex: 3750 }
      ]
    ] as const;
    const borrowAmountsWad = [
      100n * 10n ** 18n,
      150n * 10n ** 18n,
      200n * 10n ** 18n,
      300n * 10n ** 18n
    ] as const;
    const collateralSearchUpperBoundWad = 5_000n * 10n ** 18n;
    const collateralSearchToleranceWad = 10n ** 16n;

    for (const deposits of depositLayouts) {
      const poolAddress = await createQuoteOnlyMultiBucketBorrowFixture(
        account,
        publicClient,
        walletClient,
        artifact,
        deposits
      );

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const baselineRateInfo = await readCurrentRateInfo(publicClient, poolAddress);

      const passiveBranchId = await testClient.snapshot();
      let passiveRateBps: number;
      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
        passiveRateBps = (await readCurrentRateInfo(publicClient, poolAddress)).currentRateBps;
      } finally {
        await testClient.revert({ id: passiveBranchId });
      }

      for (const amount of borrowAmountsWad) {
        const canBorrowAtUpperBound = await (async () => {
          const branchId = await testClient.snapshot();
          try {
            const drawDebtHash = await walletClient.writeContract({
              account,
              chain: undefined,
              address: poolAddress,
              abi: ajnaPoolAbi,
              functionName: "drawDebt",
              args: [account.address, amount, 7388n, collateralSearchUpperBoundWad]
            });
            await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });
            return true;
          } catch {
            return false;
          } finally {
            await testClient.revert({ id: branchId });
          }
        })();

        if (!canBorrowAtUpperBound) {
          continue;
        }

        let lowerBound = 1n;
        let upperBound = collateralSearchUpperBoundWad;

        while (upperBound - lowerBound > collateralSearchToleranceWad) {
          const middle = lowerBound + (upperBound - lowerBound) / 2n;
          const branchId = await testClient.snapshot();

          try {
            const drawDebtHash = await walletClient.writeContract({
              account,
              chain: undefined,
              address: poolAddress,
              abi: ajnaPoolAbi,
              functionName: "drawDebt",
              args: [account.address, amount, 7388n, middle]
            });
            await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });
            upperBound = middle;
          } catch {
            lowerBound = middle + 1n;
          } finally {
            await testClient.revert({ id: branchId });
          }
        }

        const boundaryCollateralAmount = (upperBound * 10_010n + 9_999n) / 10_000n;
        const branchId = await testClient.snapshot();

        try {
          const drawDebtHash = await walletClient.writeContract({
            account,
            chain: undefined,
            address: poolAddress,
            abi: ajnaPoolAbi,
            functionName: "drawDebt",
            args: [account.address, amount, 7388n, boundaryCollateralAmount]
          });
          await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

          const activeRateInfo = await readCurrentRateInfo(publicClient, poolAddress);
          if (
            activeRateInfo.lastInterestRateUpdateTimestamp >
              baselineRateInfo.lastInterestRateUpdateTimestamp &&
            activeRateInfo.currentRateBps > passiveRateBps
          ) {
            return {
              poolAddress,
              chainNow,
              deposits,
              amount,
              collateralAmount: boundaryCollateralAmount,
              passiveRateBps,
              activeRateBps: activeRateInfo.currentRateBps
            };
          }
        } catch {
          // Ignore revert-heavy boundary discovery probes.
        } finally {
          await testClient.revert({ id: branchId });
        }
      }
    }

    return undefined;
  }

  async function findBoundaryTargetedManualSameCycleBorrowMatch(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<any> {
    const boundaryBorrowAmountsWad = [
      10n ** 16n,
      10n ** 17n,
      5n * 10n ** 17n,
      10n ** 18n,
      5n * 10n ** 18n,
      10n * 10n ** 18n,
      50n * 10n ** 18n,
      100n * 10n ** 18n
    ] as const;

    type BoundaryPureCandidate = {
      amount: bigint;
      collateralAmount: bigint;
      candidateMargin: bigint;
    };
    type BoundaryScenarioState = {
      passiveCycles: number;
      chainNow: number;
      snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
      baselineRateInfo: Awaited<ReturnType<typeof readCurrentRateInfo>>;
      baselineMargin: bigint;
      pureCandidates: BoundaryPureCandidate[];
    };
    type BoundaryRankedState = BoundaryScenarioState & {
      poolAddress: `0x${string}`;
      scenario: {
        initialQuoteAmount: bigint;
        borrowAmount: bigint;
        collateralAmount: bigint;
      };
    };

    async function loadBoundaryScenarioState(
      poolAddress: `0x${string}`,
      passiveCycles: number
    ): Promise<BoundaryScenarioState | undefined> {
      if (passiveCycles > 0) {
        const config = resolveKeeperConfig({
          chainId: 8453,
          poolAddress,
          poolId: `8453:${poolAddress.toLowerCase()}`,
          rpcUrl: LOCAL_RPC_URL,
          targetRateBps: 1000,
          toleranceBps: 50,
          toleranceMode: "absolute",
          completionPolicy: "next_move_would_overshoot",
          executionBufferBps: 0,
          maxQuoteTokenExposure: "1000000000000000000000000",
          maxBorrowExposure: "1000000000000000000000",
          snapshotAgeMaxSeconds: 3600,
          minTimeBeforeRateWindowSeconds: 120,
          minExecutableActionQuoteToken: "1",
          recheckBeforeSubmit: true
        });
        await advanceAndApplyEligibleUpdates(
          account,
          publicClient,
          walletClient,
          testClient,
          config,
          passiveCycles
        );
      }

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const snapshotConfig = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps: 1000,
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
        enableSimulationBackedLendSynthesis: false,
        enableSimulationBackedBorrowSynthesis: false,
        enableHeuristicLendSynthesis: false,
        enableHeuristicBorrowSynthesis: false
      });
      const snapshot = await new AjnaRpcSnapshotSource(snapshotConfig, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();
      if (
        snapshot.secondsUntilNextRateUpdate !== 0 ||
        snapshot.predictedNextOutcome === "STEP_UP"
      ) {
        return undefined;
      }

      const [loansInfo, borrowerInfo, baselineRateInfo] = await Promise.all([
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
        return undefined;
      }

      const rateState = extractAjnaRateState(snapshot, chainNow);
      const baselineMargin = computeStepUpMargin(rateState);
      const pureCandidates: BoundaryPureCandidate[] = [];

      for (const collateralAmount of EXPERIMENTAL_BOUNDARY_TARGETED_SAME_CYCLE_COLLATERAL_AMOUNTS_WAD) {
        for (const amount of boundaryBorrowAmountsWad) {
          const candidateState = drawDebtIntoRateStateForTest(rateState, amount, collateralAmount);
          const prediction = forecastAjnaNextEligibleRate(candidateState);
          if (prediction.predictedOutcome !== "STEP_UP") {
            continue;
          }

          pureCandidates.push({
            amount,
            collateralAmount,
            candidateMargin: computeStepUpMargin(candidateState)
          });
        }
      }

      if (pureCandidates.length === 0) {
        return undefined;
      }

      pureCandidates.sort((left, right) => {
        if (left.candidateMargin !== right.candidateMargin) {
          return left.candidateMargin > right.candidateMargin ? -1 : 1;
        }
        if (left.amount !== right.amount) {
          return left.amount < right.amount ? -1 : 1;
        }
        if (left.collateralAmount !== right.collateralAmount) {
          return left.collateralAmount < right.collateralAmount ? -1 : 1;
        }
        return 0;
      });

      return {
        passiveCycles,
        chainNow,
        snapshot,
        baselineRateInfo,
        baselineMargin,
        pureCandidates: pureCandidates.slice(0, 2)
      };
    }

    const compareBoundaryScenarioStates = (
      left: BoundaryScenarioState,
      right: BoundaryScenarioState
    ): number => {
      const leftBest = left.pureCandidates[0];
      const rightBest = right.pureCandidates[0];
      if (!leftBest && !rightBest) {
        return left.passiveCycles - right.passiveCycles;
      }
      if (!leftBest) {
        return 1;
      }
      if (!rightBest) {
        return -1;
      }
      if (leftBest.candidateMargin !== rightBest.candidateMargin) {
        return leftBest.candidateMargin > rightBest.candidateMargin ? -1 : 1;
      }
      if (left.baselineMargin !== right.baselineMargin) {
        return left.baselineMargin > right.baselineMargin ? -1 : 1;
      }
      if (leftBest.amount !== rightBest.amount) {
        return leftBest.amount < rightBest.amount ? -1 : 1;
      }
      if (leftBest.collateralAmount !== rightBest.collateralAmount) {
        return leftBest.collateralAmount < rightBest.collateralAmount ? -1 : 1;
      }
      return left.passiveCycles - right.passiveCycles;
    };

    const rankedStates: BoundaryRankedState[] = [];

    for (const scenario of EXPERIMENTAL_BOUNDARY_TARGETED_BORROWER_SCENARIOS) {
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

      const rankedScenarioStates: BoundaryScenarioState[] = [];

      for (const passiveCycles of EXPERIMENTAL_BOUNDARY_TARGETED_PASSIVE_CYCLES) {
        const scenarioBranchId = await testClient.snapshot();

        try {
          const state = await loadBoundaryScenarioState(poolAddress, passiveCycles);
          if (state) {
            rankedScenarioStates.push(state);
          }
        } finally {
          await testClient.revert({ id: scenarioBranchId });
        }
      }

      rankedScenarioStates.sort(compareBoundaryScenarioStates);
      rankedStates.push(
        ...rankedScenarioStates.slice(0, 1).map((state) => ({
          ...state,
          poolAddress,
          scenario
        }))
      );
    }

    rankedStates.sort(compareBoundaryScenarioStates);

    for (const rankedState of rankedStates.slice(0, 2)) {
      const validationBranchId = await testClient.snapshot();

      try {
        const state = await loadBoundaryScenarioState(
          rankedState.poolAddress,
          rankedState.passiveCycles
        );
        if (!state) {
          continue;
        }

        const passiveBranchId = await testClient.snapshot();
        let passiveRateBps: number;
        try {
          const updateHash = await walletClient.writeContract({
            account,
            chain: undefined,
            address: rankedState.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "updateInterest"
          });
          await publicClient.waitForTransactionReceipt({ hash: updateHash });
          passiveRateBps = (
            await readCurrentRateInfo(publicClient, rankedState.poolAddress)
          ).currentRateBps;
        } finally {
          await testClient.revert({ id: passiveBranchId });
        }

        for (const pureCandidate of state.pureCandidates.slice(0, 1)) {
          for (const limitIndex of EXPERIMENTAL_BOUNDARY_TARGETED_SAME_CYCLE_LIMIT_INDEXES) {
            const branchId = await testClient.snapshot();

            try {
              const drawDebtHash = await walletClient.writeContract({
                account,
                chain: undefined,
                address: rankedState.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "drawDebt",
                args: [
                  account.address,
                  pureCandidate.amount,
                  BigInt(limitIndex),
                  pureCandidate.collateralAmount
                ]
              });
              await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

              const activeRateInfo = await readCurrentRateInfo(publicClient, rankedState.poolAddress);
              if (
                activeRateInfo.lastInterestRateUpdateTimestamp >
                  state.baselineRateInfo.lastInterestRateUpdateTimestamp &&
                activeRateInfo.currentRateBps > passiveRateBps
              ) {
                return {
                  poolAddress: rankedState.poolAddress,
                  chainNow: state.chainNow,
                  passiveCycles: state.passiveCycles,
                  scenario: rankedState.scenario,
                  snapshot: state.snapshot,
                  amount: pureCandidate.amount,
                  limitIndex,
                  collateralAmount: pureCandidate.collateralAmount,
                  passiveRateBps,
                  activeRateBps: activeRateInfo.currentRateBps,
                  baselineMargin: state.baselineMargin,
                  candidateMargin: pureCandidate.candidateMargin
                };
              }
            } catch {
              // Candidate not executable on this limit index. Try the next one.
            } finally {
              await testClient.revert({ id: branchId });
            }
          }
        }
      } finally {
        await testClient.revert({ id: validationBranchId });
      }
    }

    return undefined;
  }

  return {
    findExistingBorrowerSameCycleBorrowMatch,
    findManualExistingBorrowerSameCycleBorrowImprovement,
    findManualBrandNewSameCycleBorrowImprovement,
    findManualBrandNewFirstUpdateSameCycleBorrowImprovement,
    findManualBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement,
    findBoundaryDiscoveredBrandNewFirstUpdateMultiBucketSameCycleBorrowImprovement,
    findBoundaryTargetedManualSameCycleBorrowMatch
  };
}

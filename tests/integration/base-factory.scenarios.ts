import { decodeEventLog, type Hex } from "viem";

import {
  ajnaErc20PoolFactoryAbi,
  ajnaPoolAbi,
  BASE_AJNA_DEPLOYMENT,
  AjnaRpcSnapshotSource,
  createAjnaExecutionBackend,
  resolveKeeperConfig,
  runCycle,
  type KeeperConfig
} from "../../src/index.js";
import { FORK_TIME_SKIP_SECONDS, TWELVE_HOURS_SECONDS, WAD } from "./base-factory.protocol.js";
import {
  DETERMINISTIC_PREWINDOW_LEND_SCENARIO_INDEXES,
  EXPERIMENTAL_COMPLEX_PREWINDOW_LEND_SCENARIOS,
  EXPERIMENTAL_COMPLEX_PREWINDOW_TARGETS,
  EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE,
  REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST
} from "./base-factory.fixtures.js";
import {
  LOCAL_RPC_URL,
  approveToken,
  advanceAndApplyEligibleUpdates,
  buildRepresentativeBorrowLookaheadConfig,
  createRpcWalletClient,
  deployMockToken,
  deployPoolThroughFactory,
  formatTokenAmount,
  formatWeiAsEth,
  listUnlockedRpcAccounts,
  mintToken,
  readBorrowerDebtState,
  readCurrentRateBps,
  readDwatpThresholdFenwickIndex,
  requireSnapshotMetadataValue,
  writePoolContractFromAddress,
  writeTokenContractFromAddress
} from "./base-factory.shared.js";

const LARGE_USED_POOL_MULTI_WEEK_KEEPER_CADENCE_SECONDS = TWELVE_HOURS_SECONDS * 16;
const LARGE_USED_POOL_MULTI_WEEK_PRE_ACTION_SECONDS = TWELVE_HOURS_SECONDS / 2;

type LargeUsedPoolActor =
  (typeof EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.initialDeposits)[number]["actor"] |
  (typeof EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.initialBorrows)[number]["actor"];

type LargeUsedPoolCycleAction =
  (typeof EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.cycleActionPatterns)[number][number];

async function sumGasCostWei(
  publicClient: any,
  transactionHashes: readonly Hex[]
): Promise<bigint> {
  let total = 0n;

  for (const hash of transactionHashes) {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const effectiveGasPrice = BigInt(String(receipt.effectiveGasPrice ?? 0n));
    total += receipt.gasUsed * effectiveGasPrice;
  }

  return total;
}

export { formatTokenAmount, formatWeiAsEth } from "./base-factory.shared.js";

async function moveToFirstBorrowLookaheadState(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  testClient: any,
  poolAddress: `0x${string}`
): Promise<number> {
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

  await testClient.increaseTime({
    seconds: FORK_TIME_SKIP_SECONDS
  });
  await testClient.mine({
    blocks: 1
  });

  return Number((await publicClient.getBlock()).timestamp);
}

export async function findManualPreWindowLendMatch(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  testClient: any,
  matched: Awaited<ReturnType<typeof createDeterministicPreWindowLendForecastFixture>>,
  options: {
    bucketOffsets: readonly number[];
    quoteAmounts: readonly bigint[];
    updateCount: number;
  }
): Promise<{
  passivePath: {
    chainNow: number;
    currentRateBps: number;
  };
  thresholdIndex: number | undefined;
  observations: string[];
  positiveMatch:
    | {
        bucketIndex: number;
        amount: bigint;
        resultingRateBps: number;
      }
    | undefined;
}> {
  const thresholdIndex = await readDwatpThresholdFenwickIndex(publicClient, matched.poolAddress);
  const passiveBranchId = await testClient.snapshot();
  const passivePath = await advanceAndApplyEligibleUpdates(
    account,
    publicClient,
    walletClient,
    testClient,
    matched.config,
    options.updateCount
  );
  await testClient.revert({ id: passiveBranchId });

  const observations: string[] = [];
  let positiveMatch:
    | {
        bucketIndex: number;
        amount: bigint;
        resultingRateBps: number;
      }
    | undefined;

  for (const offset of options.bucketOffsets) {
    const bucketIndex = Math.max(0, Math.min(7388, (thresholdIndex ?? 0) + offset));

    for (const quoteAmount of options.quoteAmounts) {
      const quoteAmountWad = quoteAmount * 10n ** 18n;
      const branchId = await testClient.snapshot();

      try {
        const latestBlock = await publicClient.getBlock();
        const hash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: matched.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "addQuoteToken",
          args: [quoteAmountWad, BigInt(bucketIndex), latestBlock.timestamp + 3600n]
        });
        await publicClient.waitForTransactionReceipt({ hash });

        const activePath = await advanceAndApplyEligibleUpdates(
          account,
          publicClient,
          walletClient,
          testClient,
          matched.config,
          options.updateCount
        );
        observations.push(
          `bucket=${bucketIndex} amount=${quoteAmount.toString()} rate=${activePath.currentRateBps}`
        );

        if (activePath.currentRateBps < passivePath.currentRateBps) {
          positiveMatch = {
            bucketIndex,
            amount: quoteAmountWad,
            resultingRateBps: activePath.currentRateBps
          };
          break;
        }
      } catch (error) {
        observations.push(
          `bucket=${bucketIndex} amount=${quoteAmount.toString()} error=${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        await testClient.revert({ id: branchId });
      }
    }

    if (positiveMatch) {
      break;
    }
  }

  return {
    passivePath,
    thresholdIndex,
    observations,
    positiveMatch
  };
}

export async function findRealActiveBasePool(
  publicClient: any
): Promise<
  | {
      poolAddress: `0x${string}`;
      chainNow: number;
      config: KeeperConfig;
      snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
    }
  | undefined
> {
  const overridePoolAddress = process.env.BASE_ACTIVE_POOL_ADDRESS as `0x${string}` | undefined;
  if (overridePoolAddress) {
    const chainNow = Number((await publicClient.getBlock()).timestamp);
    const config = resolveKeeperConfig({
      chainId: 8453,
      poolAddress: overridePoolAddress,
      poolId: `8453:${overridePoolAddress.toLowerCase()}`,
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
    const snapshot = await new AjnaRpcSnapshotSource(config, {
      publicClient,
      now: () => chainNow
    }).getSnapshot();
    const currentDebtWad = BigInt(String(requireSnapshotMetadataValue(snapshot, "currentDebtWad")));
    const depositEmaWad = BigInt(String(requireSnapshotMetadataValue(snapshot, "depositEmaWad")));
    if (currentDebtWad <= 0n || depositEmaWad <= 0n) {
      throw new Error(
        `BASE_ACTIVE_POOL_ADDRESS ${overridePoolAddress} did not look active (debt=${currentDebtWad.toString()}, depositEma=${depositEmaWad.toString()})`
      );
    }

    return {
      poolAddress: overridePoolAddress,
      chainNow,
      config,
      snapshot
    };
  }

  const latestBlock = await publicClient.getBlockNumber();
  const maxLookback = 2_000_000n;
  const chunkSize = 200_000n;
  const seenPools = new Set<string>();

  for (let scanned = 0n; scanned < maxLookback; scanned += chunkSize) {
    const toBlock = latestBlock > scanned ? latestBlock - scanned : 0n;
    const fromBlock = toBlock > chunkSize ? toBlock - chunkSize + 1n : 0n;
    const logs = await publicClient.getLogs({
      address: BASE_AJNA_DEPLOYMENT.erc20Factory,
      fromBlock,
      toBlock
    });

    const poolAddresses = logs
      .map((log: any) => {
        try {
          return decodeEventLog({
            abi: ajnaErc20PoolFactoryAbi,
            data: log.data,
            topics: log.topics
          });
        } catch {
          return undefined;
        }
      })
      .filter((log: any) => log?.eventName === "PoolCreated")
      .map((log: any) => log.args.pool_ as `0x${string}`)
      .reverse();

    for (const poolAddress of poolAddresses) {
      if (seenPools.has(poolAddress.toLowerCase())) {
        continue;
      }
      seenPools.add(poolAddress.toLowerCase());

      const chainNow = Number((await publicClient.getBlock()).timestamp);
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
        enableSimulationBackedLendSynthesis: false,
        enableSimulationBackedBorrowSynthesis: false,
        enableHeuristicLendSynthesis: false,
        enableHeuristicBorrowSynthesis: false
      });
      const snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();

      const currentDebtWad = BigInt(String(requireSnapshotMetadataValue(snapshot, "currentDebtWad")));
      const depositEmaWad = BigInt(String(requireSnapshotMetadataValue(snapshot, "depositEmaWad")));

      if (currentDebtWad > 0n && depositEmaWad > 0n) {
        return {
          poolAddress,
          chainNow,
          config,
          snapshot
        };
      }
    }
  }

  return undefined;
}

export async function createQuoteOnlyBorrowFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` }
): Promise<`0x${string}`> {
  const collateralToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Borrow Lookahead Collateral",
    "BLC"
  );
  const quoteToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Borrow Lookahead Quote",
    "BLQ"
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

  return poolAddress;
}

export async function createQuoteOnlyMultiBucketBorrowFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` },
  deposits: readonly {
    amount: bigint;
    bucketIndex: number;
  }[]
): Promise<`0x${string}`> {
  const collateralToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Multi Bucket Borrow Collateral",
    "MBBC"
  );
  const quoteToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Multi Bucket Borrow Quote",
    "MBBQ"
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
    1_000_000n * 10n ** 18n,
    artifact.abi
  );

  for (const deposit of deposits) {
    const latestBlock = await publicClient.getBlock();
    const addQuoteHash = await walletClient.writeContract({
      account,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "addQuoteToken",
      args: [deposit.amount, BigInt(deposit.bucketIndex), latestBlock.timestamp + 3600n]
    });
    await publicClient.waitForTransactionReceipt({ hash: addQuoteHash });
  }

  return poolAddress;
}

export async function createExistingBorrowerSameCycleFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` },
  scenario: {
    initialQuoteAmount: bigint;
    borrowAmount: bigint;
    collateralAmount: bigint;
  }
): Promise<`0x${string}` | undefined> {
  const collateralToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Existing Borrower Collateral",
    "EBC"
  );
  const quoteToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Existing Borrower Quote",
    "EBQ"
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
    args: [scenario.initialQuoteAmount * 10n ** 18n, 3_000n, latestBlock.timestamp + 3600n]
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
      scenario.borrowAmount * 10n ** 18n,
      3_000n,
      scenario.collateralAmount * 10n ** 18n
    ]
  }).catch(() => undefined);
  if (!drawDebtHash) {
    return undefined;
  }
  await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

  return poolAddress;
}

export async function createExistingBorrowerMultiBucketFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` },
  scenario: {
    deposits: readonly {
      amount: bigint;
      bucketIndex: number;
    }[];
    borrowAmount: bigint;
    collateralAmount: bigint;
  }
): Promise<`0x${string}` | undefined> {
  const collateralToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Existing Multi Bucket Collateral",
    "EMBC"
  );
  const quoteToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Existing Multi Bucket Quote",
    "EMBQ"
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
    1_000_000n * 10n ** 18n,
    artifact.abi
  );

  const latestBlock = await publicClient.getBlock();
  for (const deposit of scenario.deposits) {
    const addQuoteHash = await walletClient.writeContract({
      account,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "addQuoteToken",
      args: [deposit.amount * 10n ** 18n, BigInt(deposit.bucketIndex), latestBlock.timestamp + 3600n]
    });
    await publicClient.waitForTransactionReceipt({ hash: addQuoteHash });
  }

  const drawDebtHash = await walletClient.writeContract({
    account,
    chain: undefined,
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "drawDebt",
    args: [
      account.address,
      scenario.borrowAmount * 10n ** 18n,
      3_000n,
      scenario.collateralAmount * 10n ** 18n
    ]
  }).catch(() => undefined);
  if (!drawDebtHash) {
    return undefined;
  }
  await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

  return poolAddress;
}

export async function createLargeUsedPoolMultiWeekBorrowFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  testClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` }
): Promise<{
  poolAddress: `0x${string}`;
  chainNow: number;
  config: KeeperConfig;
  actorAddresses: Record<LargeUsedPoolActor, `0x${string}`>;
  initialOperatorDebtWad: bigint;
  initialOperatorCollateralWad: bigint;
}> {
  const rpcWalletClient = createRpcWalletClient();
  const unlockedAddresses = await listUnlockedRpcAccounts(publicClient);
  const externalAddresses = unlockedAddresses
    .filter((address) => address.toLowerCase() !== account.address.toLowerCase())
    .slice(0, 5);
  if (externalAddresses.length < 5) {
    throw new Error("expected at least five unlocked external RPC accounts on local anvil");
  }

  const actorAddresses: Record<LargeUsedPoolActor, `0x${string}`> = {
    operator: account.address,
    lenderA: externalAddresses[0]!,
    lenderB: externalAddresses[1]!,
    lenderC: externalAddresses[2]!,
    borrowerA: externalAddresses[3]!,
    borrowerB: externalAddresses[4]!
  };

  for (const address of externalAddresses) {
    await testClient.setBalance({
      address,
      value: 10n ** 24n
    });
  }

  const collateralToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Large Used Pool Collateral",
    "LUPC"
  );
  const quoteToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    "Large Used Pool Quote",
    "LUPQ"
  );

  for (const actorAddress of Object.values(actorAddresses)) {
    await mintToken(
      walletClient,
      publicClient,
      artifact,
      collateralToken,
      actorAddress,
      1_000_000n * 10n ** 18n
    );
    await mintToken(
      walletClient,
      publicClient,
      artifact,
      quoteToken,
      actorAddress,
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
    1_000_000n * 10n ** 18n,
    artifact.abi
  );
  for (const actorAddress of externalAddresses) {
    await writeTokenContractFromAddress(rpcWalletClient, publicClient, actorAddress, quoteToken, {
      functionName: "approve",
      args: [poolAddress, 1_000_000n * 10n ** 18n]
    });
    await writeTokenContractFromAddress(
      rpcWalletClient,
      publicClient,
      actorAddress,
      collateralToken,
      {
        functionName: "approve",
        args: [poolAddress, 1_000_000n * 10n ** 18n]
      }
    );
  }

  for (const deposit of EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.initialDeposits) {
    const actorAddress = actorAddresses[deposit.actor];
    const latestBlock = await publicClient.getBlock();
    const writeFrom =
      actorAddress.toLowerCase() === account.address.toLowerCase() ? walletClient : rpcWalletClient;
    await writePoolContractFromAddress(writeFrom, publicClient, actorAddress, poolAddress, {
      functionName: "addQuoteToken",
      args: [
        deposit.amount * 10n ** 18n,
        BigInt(deposit.bucketIndex),
        latestBlock.timestamp + 3600n
      ]
    });
  }

  for (const borrow of EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.initialBorrows) {
    const actorAddress = actorAddresses[borrow.actor];
    const writeFrom =
      actorAddress.toLowerCase() === account.address.toLowerCase() ? walletClient : rpcWalletClient;
    await writePoolContractFromAddress(writeFrom, publicClient, actorAddress, poolAddress, {
      functionName: "drawDebt",
      args: [
        actorAddress,
        borrow.amount * 10n ** 18n,
        BigInt(borrow.limitIndex),
        borrow.collateralAmount * 10n ** 18n
      ]
    });
  }

  const chainNow = await moveToFirstBorrowLookaheadState(
    account,
    publicClient,
    walletClient,
    testClient,
    poolAddress
  );
  const config = buildRepresentativeBorrowLookaheadConfig(poolAddress, account.address, {
    targetRateBps: EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.targetRateBps,
    toleranceBps: EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.toleranceBps,
    drawDebtLimitIndexes: [3000],
    drawDebtCollateralAmounts: [10n * 10n ** 18n],
    borrowSimulationLookaheadUpdates: 3
  });

  const operatorDebtState = await readBorrowerDebtState(publicClient, poolAddress, account.address);
  return {
    poolAddress,
    chainNow,
    config,
    actorAddresses,
    initialOperatorDebtWad: operatorDebtState.currentDebtWad,
    initialOperatorCollateralWad: operatorDebtState.collateral
  };
}

async function applyLargeUsedPoolCycleActions(
  cycleIndex: number,
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  actorAddresses: Record<LargeUsedPoolActor, `0x${string}`>,
  poolAddress: `0x${string}`
): Promise<void> {
  const rpcWalletClient = createRpcWalletClient();
  const cyclePattern =
    EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.cycleActionPatterns[
      cycleIndex % EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.cycleActionPatterns.length
    ]!;

  for (const action of cyclePattern) {
    const actorAddress = actorAddresses[action.actor];
    const writeFrom =
      actorAddress.toLowerCase() === account.address.toLowerCase() ? walletClient : rpcWalletClient;

    if (action.type === "ADD_QUOTE") {
      const latestBlock = await publicClient.getBlock();
      await writePoolContractFromAddress(writeFrom, publicClient, actorAddress, poolAddress, {
        functionName: "addQuoteToken",
        args: [
          action.amount * 10n ** 18n,
          BigInt(action.bucketIndex),
          latestBlock.timestamp + 3600n
        ]
      });
      continue;
    }

    await writePoolContractFromAddress(writeFrom, publicClient, actorAddress, poolAddress, {
      functionName: "drawDebt",
      args: [
        actorAddress,
        action.amount * 10n ** 18n,
        BigInt(action.limitIndex),
        action.collateralAmount * 10n ** 18n
      ]
    });
  }
}

export async function runLargeUsedPoolMultiWeekBorrowBranch(
  mode: "active" | "passive",
  params: {
    account: { address: `0x${string}` };
    publicClient: any;
    walletClient: any;
    testClient: any;
    poolAddress: `0x${string}`;
    config: KeeperConfig;
    actorAddresses: Record<LargeUsedPoolActor, `0x${string}`>;
    cycleCount: number;
    initialOperatorDebtWad: bigint;
  }
): Promise<{
  finalRateBps: number;
  reachedTargetCycle?: number;
  executedBorrowCycles: number;
  cumulativeNetQuoteBorrowedWad: bigint;
  cumulativeAdditionalCollateralWad: bigint;
  cumulativeOperatorCapitalRequiredWad: bigint;
  cumulativeGasCostWei: bigint;
  finalOperatorDebtWad: bigint;
  observations: string[];
}> {
  const passiveConfig = resolveKeeperConfig({
    ...params.config,
    enableSimulationBackedBorrowSynthesis: false,
    enableHeuristicBorrowSynthesis: false
  });
  const observations: string[] = [];
  let reachedTargetCycle: number | undefined;
  let executedBorrowCycles = 0;
  let cumulativeNetQuoteBorrowedWad = 0n;
  let cumulativeAdditionalCollateralWad = 0n;
  let cumulativeOperatorCapitalRequiredWad = 0n;
  let cumulativeGasCostWei = 0n;

  for (let cycleIndex = 0; cycleIndex < params.cycleCount; cycleIndex += 1) {
    let chainNow = Number((await params.publicClient.getBlock()).timestamp);
    const cycleStartSnapshot = await new AjnaRpcSnapshotSource(passiveConfig, {
      publicClient: params.publicClient,
      now: () => chainNow
    }).getSnapshot();
    const preActionSeconds = Math.max(
      1,
      Math.min(
        LARGE_USED_POOL_MULTI_WEEK_PRE_ACTION_SECONDS,
        Math.max(1, cycleStartSnapshot.secondsUntilNextRateUpdate)
      )
    );

    if (cycleStartSnapshot.secondsUntilNextRateUpdate > 0) {
      await params.testClient.increaseTime({
        seconds: preActionSeconds
      });
      await params.testClient.mine({
        blocks: 1
      });
    }

    await applyLargeUsedPoolCycleActions(
      cycleIndex,
      params.account,
      params.publicClient,
      params.walletClient,
      params.actorAddresses,
      params.poolAddress
    );

    chainNow = Number((await params.publicClient.getBlock()).timestamp);
    const preDueSnapshot = await new AjnaRpcSnapshotSource(passiveConfig, {
      publicClient: params.publicClient,
      now: () => chainNow
    }).getSnapshot();
    const keeperDelaySeconds =
      preDueSnapshot.secondsUntilNextRateUpdate +
      (LARGE_USED_POOL_MULTI_WEEK_KEEPER_CADENCE_SECONDS - TWELVE_HOURS_SECONDS);
    if (keeperDelaySeconds > 0) {
      await params.testClient.increaseTime({
        seconds: keeperDelaySeconds
      });
      await params.testClient.mine({
        blocks: 1
      });
    }

    chainNow = Number((await params.publicClient.getBlock()).timestamp);
    if (mode === "active") {
      const result = await runCycle(params.config, {
        snapshotSource: new AjnaRpcSnapshotSource(params.config, {
          publicClient: params.publicClient,
          now: () => chainNow
        }),
        executor: createAjnaExecutionBackend(params.config)
      });

      if (result.status === "EXECUTED") {
        cumulativeGasCostWei += await sumGasCostWei(
          params.publicClient,
          result.transactionHashes as Hex[]
        );
        cumulativeNetQuoteBorrowedWad += result.plan.netQuoteBorrowed;
        cumulativeAdditionalCollateralWad += result.plan.additionalCollateralRequired;
        cumulativeOperatorCapitalRequiredWad += result.plan.operatorCapitalRequired;
        if (result.plan.intent === "BORROW") {
          executedBorrowCycles += 1;
        }
      } else if (result.status !== "NO_OP") {
        throw new Error(
          `large used-pool active branch failed at cycle ${cycleIndex}: status=${result.status} reason=${result.reason} error=${result.error ?? ""}`
        );
      }

      if (result.status === "NO_OP") {
        await writePoolContractFromAddress(
          params.walletClient,
          params.publicClient,
          params.account.address,
          params.poolAddress,
          {
            functionName: "updateInterest"
          }
        );
      }
    } else {
      await writePoolContractFromAddress(
        params.walletClient,
        params.publicClient,
        params.account.address,
        params.poolAddress,
        {
          functionName: "updateInterest"
        }
      );
    }

    const cycleEndRateBps = await readCurrentRateBps(params.publicClient, params.poolAddress);
    if (
      reachedTargetCycle === undefined &&
      cycleEndRateBps >= params.config.targetRateBps - params.config.toleranceBps &&
      cycleEndRateBps <= params.config.targetRateBps + params.config.toleranceBps
    ) {
      reachedTargetCycle = cycleIndex + 1;
    }

    observations.push(
      `${mode}:cycle=${cycleIndex + 1} rate=${cycleEndRateBps} executedBorrowCycles=${executedBorrowCycles} cumulativeBorrowed=${formatTokenAmount(cumulativeNetQuoteBorrowedWad)}`
    );
  }

  const finalRateBps = await readCurrentRateBps(params.publicClient, params.poolAddress);
  const finalOperatorDebtWad = (
    await readBorrowerDebtState(params.publicClient, params.poolAddress, params.account.address)
  ).currentDebtWad;

  observations.push(
    `${mode}:finalRate=${finalRateBps} reachedTargetCycle=${reachedTargetCycle ?? "-"} finalDebtDelta=${formatTokenAmount(finalOperatorDebtWad - params.initialOperatorDebtWad)} gasEth=${formatWeiAsEth(cumulativeGasCostWei)}`
  );

  return {
    finalRateBps,
    executedBorrowCycles,
    cumulativeNetQuoteBorrowedWad,
    cumulativeAdditionalCollateralWad,
    cumulativeOperatorCapitalRequiredWad,
    cumulativeGasCostWei,
    finalOperatorDebtWad,
    observations,
    ...(reachedTargetCycle === undefined ? {} : { reachedTargetCycle })
  };
}

async function createBorrowedStepUpFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` },
  scenario: {
    initialQuoteAmount: bigint;
    borrowAmount: bigint;
    collateralAmount: bigint;
  },
  labels: {
    collateralName: string;
    collateralSymbol: string;
    quoteName: string;
    quoteSymbol: string;
  }
): Promise<`0x${string}` | undefined> {
  const collateralToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    labels.collateralName,
    labels.collateralSymbol
  );
  const quoteToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    labels.quoteName,
    labels.quoteSymbol
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
    return undefined;
  }

  return poolAddress;
}

export async function createDeterministicPreWindowLendForecastFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  testClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` }
): Promise<{
  poolAddress: `0x${string}`;
  chainNow: number;
  config: KeeperConfig;
  snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
}> {
  const failures: string[] = [];
  for (const scenarioIndex of DETERMINISTIC_PREWINDOW_LEND_SCENARIO_INDEXES) {
    const scenario =
      REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.borrowedStepUpScenarios[scenarioIndex]!;
    const poolAddress = await createBorrowedStepUpFixture(
      account,
      publicClient,
      walletClient,
      artifact,
      scenario,
      {
        collateralName: `Deterministic Pre Position Collateral ${scenarioIndex}`,
        collateralSymbol: `DPC${scenarioIndex}`,
        quoteName: `Deterministic Pre Position Quote ${scenarioIndex}`,
        quoteSymbol: `DPQ${scenarioIndex}`
      }
    );
    if (!poolAddress) {
      failures.push(`scenario ${scenarioIndex}: fixture creation failed`);
      continue;
    }

    await testClient.increaseTime({
      seconds: FORK_TIME_SKIP_SECONDS
    });
    await testClient.mine({
      blocks: 1
    });

    let chainNow = Number((await publicClient.getBlock()).timestamp);
    const config = resolveKeeperConfig({
      chainId: 8453,
      poolAddress,
      poolId: `8453:${poolAddress.toLowerCase()}`,
      rpcUrl: LOCAL_RPC_URL,
      targetRateBps: 800,
      toleranceBps: 50,
      toleranceMode: "relative",
      completionPolicy: "next_move_would_overshoot",
      enableSimulationBackedLendSynthesis: false,
      enableSimulationBackedBorrowSynthesis: false,
      enableHeuristicLendSynthesis: false,
      enableHeuristicBorrowSynthesis: false,
      executionBufferBps: 0,
      maxQuoteTokenExposure: "1000000000000000000000000",
      maxBorrowExposure: "5000000000000000000000",
      snapshotAgeMaxSeconds: 3600,
      minTimeBeforeRateWindowSeconds: 120,
      minExecutableActionQuoteToken: "1",
      recheckBeforeSubmit: true
    });

    let snapshot = await new AjnaRpcSnapshotSource(config, {
      publicClient,
      now: () => chainNow
    }).getSnapshot();

    if (snapshot.predictedNextOutcome === "STEP_DOWN") {
      const updateHash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "updateInterest"
      });
      await publicClient.waitForTransactionReceipt({ hash: updateHash });

      chainNow = Number((await publicClient.getBlock()).timestamp);
      snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();
    }

    if (
      snapshot.currentRateBps > config.targetRateBps &&
      snapshot.secondsUntilNextRateUpdate > 0 &&
      snapshot.predictedNextOutcome === "STEP_UP"
    ) {
      return {
        poolAddress,
        chainNow,
        config,
        snapshot
      };
    }

    failures.push(
      `scenario ${scenarioIndex}: currentRate=${snapshot.currentRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} next=${snapshot.predictedNextOutcome}`
    );
  }

  throw new Error(
    `deterministic pre-window fixture did not land on the expected not-due step-up state across saved scenarios: ${failures.join("; ")}`
  );
}

export async function createComplexOngoingPreWindowLendFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  testClient: any,
  competing: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` }
): Promise<{
  poolAddress: `0x${string}`;
  chainNow: number;
  config: KeeperConfig;
  snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
  scenarioIndex: number;
}> {
  const failures: string[] = [];
  await testClient.setBalance({
    address: competing.account.address,
    value: 10n ** 24n
  });

  for (const [scenarioIndex, scenario] of EXPERIMENTAL_COMPLEX_PREWINDOW_LEND_SCENARIOS.entries()) {
    const collateralToken = await deployMockToken(
      walletClient,
      publicClient,
      artifact,
      `Complex Pre Position Collateral ${scenarioIndex}`,
      `CPC${scenarioIndex}`
    );
    const quoteToken = await deployMockToken(
      walletClient,
      publicClient,
      artifact,
      `Complex Pre Position Quote ${scenarioIndex}`,
      `CPQ${scenarioIndex}`
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
      failures.push(`scenario ${scenarioIndex}: initial primary positioning failed`);
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
      failures.push(`scenario ${scenarioIndex}: initial updateInterest failed`);
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
      failures.push(`scenario ${scenarioIndex}: not-due competing positioning failed`);
      continue;
    }

    const chainNow = Number((await publicClient.getBlock()).timestamp);
    for (const targetRateBps of EXPERIMENTAL_COMPLEX_PREWINDOW_TARGETS) {
      const config = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps,
        toleranceBps: 50,
        toleranceMode: "relative",
        completionPolicy: "next_move_would_overshoot",
        enableSimulationBackedLendSynthesis: false,
        enableSimulationBackedBorrowSynthesis: false,
        enableHeuristicLendSynthesis: false,
        enableHeuristicBorrowSynthesis: false,
        executionBufferBps: 0,
        maxQuoteTokenExposure: "1000000000000000000000000",
        maxBorrowExposure: "5000000000000000000000",
        snapshotAgeMaxSeconds: 3600,
        minTimeBeforeRateWindowSeconds: 120,
        minExecutableActionQuoteToken: "1",
        recheckBeforeSubmit: true
      });
      const snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();

      if (
        snapshot.currentRateBps > config.targetRateBps &&
        snapshot.secondsUntilNextRateUpdate > 0 &&
        snapshot.predictedNextOutcome === "STEP_UP"
      ) {
        return {
          poolAddress,
          chainNow,
          config,
          snapshot,
          scenarioIndex
        };
      }

      failures.push(
        `scenario ${scenarioIndex}/target ${targetRateBps}: currentRate=${snapshot.currentRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} next=${snapshot.predictedNextOutcome}`
      );
    }
  }

  throw new Error(
    `complex multi-actor pre-window fixture did not land on the expected not-due step-up state across saved scenarios: ${failures.join("; ")}`
  );
}

export async function findRepresentativeBorrowedStepUpState(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  testClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` }
): Promise<
  | {
      poolAddress: `0x${string}`;
      chainNow: number;
      baselineSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
    }
  | undefined
> {
  for (const [index, scenario] of REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.borrowedStepUpScenarios.entries()) {
    const collateralToken = await deployMockToken(
      walletClient,
      publicClient,
      artifact,
      `Dual Steering Collateral ${index}`,
      `DSC${index}`
    );
    const quoteToken = await deployMockToken(
      walletClient,
      publicClient,
      artifact,
      `Dual Steering Quote ${index}`,
      `DSQ${index}`
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

    let chainNow = Number((await publicClient.getBlock()).timestamp);
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

    let snapshot = await new AjnaRpcSnapshotSource(baselineConfig, {
      publicClient,
      now: () => chainNow
    }).getSnapshot();

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

      chainNow = Number((await publicClient.getBlock()).timestamp);
      snapshot = await new AjnaRpcSnapshotSource(baselineConfig, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();
    }

    if (
      snapshot.currentRateBps > baselineConfig.targetRateBps &&
      snapshot.predictedNextOutcome === "STEP_UP"
    ) {
      return {
        poolAddress,
        chainNow,
        baselineSnapshot: snapshot
      };
    }
  }

  return undefined;
}

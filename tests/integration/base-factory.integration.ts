import "dotenv/config";

import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import net from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import {
  ajnaErc20PoolFactoryAbi,
  ajnaPoolAbi,
  forecastAjnaNextEligibleRate,
  BASE_AJNA_DEPLOYMENT,
  AjnaRpcSnapshotSource,
  createAjnaExecutionBackend,
  DryRunExecutionBackend,
  planCycle,
  resolveKeeperConfig,
  runCycle,
  synthesizeAjnaLendAndBorrowCandidate,
  type AjnaRateState,
  type KeeperConfig,
  type PlanCandidate,
  type PoolSnapshot
} from "../../src/index.js";

const execFile = promisify(execFileCallback);
const RUN_BASE_FORK_TESTS = process.env.RUN_BASE_FORK_TESTS === "1";
const RUN_BASE_FORK_SMOKE_TESTS = process.env.RUN_BASE_FORK_SMOKE_TESTS === "1";
const RUN_BASE_FORK_SLOW_TESTS = process.env.RUN_BASE_FORK_SLOW_TESTS === "1";
const RUN_BASE_FORK_STRESS_TESTS = process.env.RUN_BASE_FORK_STRESS_TESTS === "1";
const RUN_BASE_FORK_EXPERIMENTAL_TESTS = process.env.RUN_BASE_FORK_EXPERIMENTAL_TESTS === "1";
const RUN_BASE_FORK_ALL_TESTS = process.env.RUN_BASE_FORK_ALL_TESTS === "1";
const TEST_PORT = 9545;
const DEFAULT_LOCAL_ANVIL_URL = `http://127.0.0.1:${TEST_PORT}`;
const EXTERNAL_LOCAL_ANVIL_URL = process.env.BASE_LOCAL_ANVIL_URL?.trim() || undefined;
const LOCAL_RPC_URL = EXTERNAL_LOCAL_ANVIL_URL ?? DEFAULT_LOCAL_ANVIL_URL;
const DEFAULT_ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const COMPETING_ANVIL_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945382dbf7f2e1a0d7f6c3b5b0c2cf4f1f7f94";
const INITIAL_RATE_WAD = 100_000_000_000_000_000n;
const DECREASED_RATE_BPS = 900;
const FORK_TIME_SKIP_SECONDS = 12 * 60 * 60 + 5;
const STEERING_BUCKET_CANDIDATES = [2500, 2750, 3000, 3250, 3500] as const;
const BORROW_COLLATERAL_CANDIDATES = [1n, 2n, 5n, 10n, 20n, 50n, 100n] as const;
const DETERMINISTIC_PREWINDOW_LEND_SCENARIO_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;
const EXPERIMENTAL_COMPLEX_PREWINDOW_LEND_SCENARIOS = [
  {
    initialQuoteAmount: 1_000n,
    initialBorrowAmount: 850n,
    initialCollateralAmount: 1_500n,
    competingQuoteAmount: 150n,
    competingBorrowAmount: 125n,
    competingCollateralAmount: 300n,
    primaryFollowupQuoteAmount: 0n,
    competingFollowupBorrowAmount: 0n
  },
  {
    initialQuoteAmount: 1_000n,
    initialBorrowAmount: 950n,
    initialCollateralAmount: 2_000n,
    competingQuoteAmount: 200n,
    competingBorrowAmount: 175n,
    competingCollateralAmount: 400n,
    primaryFollowupQuoteAmount: 50n,
    competingFollowupBorrowAmount: 0n
  },
  {
    initialQuoteAmount: 750n,
    initialBorrowAmount: 650n,
    initialCollateralAmount: 1_000n,
    competingQuoteAmount: 250n,
    competingBorrowAmount: 220n,
    competingCollateralAmount: 500n,
    primaryFollowupQuoteAmount: 0n,
    competingFollowupBorrowAmount: 50n
  },
  {
    initialQuoteAmount: 1_000n,
    initialBorrowAmount: 900n,
    initialCollateralAmount: 1_500n,
    competingQuoteAmount: 300n,
    competingBorrowAmount: 250n,
    competingCollateralAmount: 600n,
    primaryFollowupQuoteAmount: 100n,
    competingFollowupBorrowAmount: 75n
  }
] as const;
const EXPERIMENTAL_COMPLEX_PREWINDOW_TARGETS = [750, 800, 850, 900] as const;
const REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST = {
  borrowedStepUpScenarios: [
    { initialQuoteAmount: 500n, borrowAmount: 400n, collateralAmount: 600n },
    { initialQuoteAmount: 500n, borrowAmount: 450n, collateralAmount: 800n },
    { initialQuoteAmount: 500n, borrowAmount: 490n, collateralAmount: 1_000n },
    { initialQuoteAmount: 750n, borrowAmount: 650n, collateralAmount: 1_000n },
    { initialQuoteAmount: 1_000n, borrowAmount: 850n, collateralAmount: 1_200n },
    { initialQuoteAmount: 1_000n, borrowAmount: 950n, collateralAmount: 1_500n },
    { initialQuoteAmount: 1_000n, borrowAmount: 990n, collateralAmount: 2_000n }
  ],
  dualSearch: {
    targetOffsetsBps: [50, 100] as const,
    tolerancesBps: [25] as const,
    lookaheadUpdates: [1, 3] as const,
    collateralAmounts: [10n * 10n ** 18n] as const
  }
} as const;
const REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_SCENARIOS = [
  { initialQuoteAmount: 1_000n, borrowAmount: 100n, collateralAmount: 1_000n },
  { initialQuoteAmount: 1_000n, borrowAmount: 250n, collateralAmount: 1_000n },
  { initialQuoteAmount: 2_000n, borrowAmount: 150n, collateralAmount: 1_200n },
  { initialQuoteAmount: 2_000n, borrowAmount: 400n, collateralAmount: 1_500n }
] as const;
const EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_SCENARIOS = [
  { initialQuoteAmount: 500n, borrowAmount: 450n, collateralAmount: 1_000n },
  { initialQuoteAmount: 750n, borrowAmount: 700n, collateralAmount: 1_200n },
  { initialQuoteAmount: 1_000n, borrowAmount: 950n, collateralAmount: 1_500n }
] as const;
const REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_CONFIG_CANDIDATES = [
  {
    targetRateBps: 950,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2750, 3000, 3250] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "10000000000000000000"] as const
  },
  {
    targetRateBps: 1000,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2750, 3000, 3250] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "10000000000000000000"] as const
  },
  {
    targetRateBps: 1050,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2750, 3000, 3250] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "10000000000000000000"] as const
  },
  {
    targetRateBps: 1100,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2750, 3000, 3250] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "10000000000000000000"] as const
  }
] as const;
const EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_CONFIG_CANDIDATES = [
  {
    targetRateBps: 950,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2500, 2750, 3000, 3250, 3500] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "5000000000000000000"] as const
  },
  {
    targetRateBps: 1000,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2500, 2750, 3000, 3250, 3500] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "5000000000000000000"] as const
  },
  {
    targetRateBps: 1050,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2500, 2750, 3000, 3250, 3500] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "5000000000000000000"] as const
  }
] as const;
const REPRESENTATIVE_MULTI_CYCLE_BORROW_CONFIG = {
  targetRateBps: 1300,
  toleranceBps: 50,
  lookaheadUpdates: 3
} as const;
const MAX_EXACT_DUAL_VALIDATIONS_WITH_PURE_MATCH = 1;
const MAX_EXACT_DUAL_VALIDATIONS_WITHOUT_PURE_MATCH = 1;
const AJNA_COLLATERALIZATION_FACTOR_WAD = 1_040_000_000_000_000_000n;
const AJNA_FLOAT_STEP = 1.005;
const EXPERIMENTAL_PREWINDOW_BUCKET_OFFSETS = [-250, -100, -50, -20, -10, -5, 0, 5, 10, 20, 50, 100, 250] as const;
const EXPERIMENTAL_PREWINDOW_QUOTE_AMOUNTS = [1n, 2n, 5n, 10n, 20n, 50n, 100n, 200n, 500n, 1_000n] as const;
const EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS = [-1_000, -500, -250, -100, -50, -20, -10, -5, 0] as const;
const EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS = [
  10n,
  20n,
  50n,
  100n,
  200n,
  500n,
  1_000n,
  2_000n,
  5_000n,
  10_000n
] as const;

function currentBaseForkProfile():
  | "smoke"
  | "default"
  | "slow"
  | "stress"
  | "experimental"
  | "all" {
  if (RUN_BASE_FORK_ALL_TESTS) {
    return "all";
  }
  if (RUN_BASE_FORK_EXPERIMENTAL_TESTS) {
    return "experimental";
  }
  if (RUN_BASE_FORK_STRESS_TESTS) {
    return "stress";
  }
  if (RUN_BASE_FORK_SLOW_TESTS) {
    return "slow";
  }
  if (RUN_BASE_FORK_SMOKE_TESTS) {
    return "smoke";
  }
  return "default";
}

function describeForkHost(forkUrl: string): string {
  try {
    return new URL(forkUrl).host;
  } catch {
    return forkUrl;
  }
}

function repoRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function artifactPath(): string {
  return join(repoRoot(), "out", "MockERC20.sol", "MockERC20.json");
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out waiting for localhost:${port}`);
}

async function waitForRpcListener(rpcUrl: string, timeoutMs = 20_000): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error(`invalid RPC URL: ${rpcUrl}`);
  }

  const port =
    parsed.port.length > 0 ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  const host = parsed.hostname;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out waiting for ${host}:${port}`);
}

async function ensureMockArtifact(): Promise<{
  abi: unknown[];
  bytecode: `0x${string}`;
}> {
  mockArtifactPromise ??= (async () => {
    await execFile("forge", ["build"], {
      cwd: repoRoot()
    });

    const artifact = JSON.parse(await readFile(artifactPath(), "utf8")) as {
      abi: unknown[];
      bytecode: { object: string };
    };
    const object = artifact.bytecode.object.startsWith("0x")
      ? artifact.bytecode.object
      : `0x${artifact.bytecode.object}`;

    return {
      abi: artifact.abi,
      bytecode: object as `0x${string}`
    };
  })();

  return mockArtifactPromise;
}

let mockArtifactPromise:
  | Promise<{
      abi: unknown[];
      bytecode: `0x${string}`;
    }>
  | undefined;

async function deployMockToken(
  walletClient: any,
  publicClient: any,
  artifact: { abi: unknown[]; bytecode: `0x${string}` },
  name: string,
  symbol: string
): Promise<`0x${string}`> {
  const hash = await walletClient.deployContract({
    account: walletClient.account!,
    chain: undefined,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [name, symbol, 18]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`missing contract address for ${name} deployment`);
  }

  return receipt.contractAddress;
}

function createClients() {
  const account = privateKeyToAccount(DEFAULT_ANVIL_PRIVATE_KEY);

  return {
    account,
    publicClient: createPublicClient({
      chain: base,
      transport: http(LOCAL_RPC_URL)
    }) as any,
    walletClient: createWalletClient({
      account,
      chain: base,
      transport: http(LOCAL_RPC_URL)
    }) as any,
    testClient: createTestClient({
      chain: base,
      mode: "anvil",
      transport: http(LOCAL_RPC_URL)
    }) as any
  };
}

function createClientsForPrivateKey(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);

  return {
    account,
    publicClient: createPublicClient({
      chain: base,
      transport: http(LOCAL_RPC_URL)
    }) as any,
    walletClient: createWalletClient({
      account,
      chain: base,
      transport: http(LOCAL_RPC_URL)
    }) as any,
    testClient: createTestClient({
      chain: base,
      mode: "anvil",
      transport: http(LOCAL_RPC_URL)
    }) as any
  };
}

function buildRepresentativeBorrowLookaheadConfig(
  poolAddress: `0x${string}`,
  borrowerAddress: `0x${string}`,
  overrides?: Partial<
    Pick<
      KeeperConfig,
      | "targetRateBps"
      | "toleranceBps"
      | "borrowSimulationLookaheadUpdates"
      | "enableSimulationBackedBorrowSynthesis"
      | "drawDebtLimitIndexes"
      | "drawDebtCollateralAmounts"
    >
  >
): KeeperConfig {
  return resolveKeeperConfig({
    chainId: 8453,
    poolAddress,
    poolId: `8453:${poolAddress.toLowerCase()}`,
    rpcUrl: LOCAL_RPC_URL,
    targetRateBps: overrides?.targetRateBps ?? REPRESENTATIVE_MULTI_CYCLE_BORROW_CONFIG.targetRateBps,
    toleranceBps: overrides?.toleranceBps ?? REPRESENTATIVE_MULTI_CYCLE_BORROW_CONFIG.toleranceBps,
    toleranceMode: "relative",
    completionPolicy: "next_move_would_overshoot",
    executionBufferBps: 0,
    maxQuoteTokenExposure: "1000000000000000000000000",
    maxBorrowExposure: "1000000000000000000000",
    snapshotAgeMaxSeconds: 3600,
    minTimeBeforeRateWindowSeconds: 120,
    minExecutableActionQuoteToken: "1",
    recheckBeforeSubmit: true,
    borrowerAddress,
    simulationSenderAddress: borrowerAddress,
    enableSimulationBackedBorrowSynthesis:
      overrides?.enableSimulationBackedBorrowSynthesis ?? true,
    drawDebtLimitIndexes: overrides?.drawDebtLimitIndexes ?? [3000],
    drawDebtCollateralAmounts:
      overrides?.drawDebtCollateralAmounts ?? ["10000000000000000000"],
    borrowSimulationLookaheadUpdates:
      overrides?.borrowSimulationLookaheadUpdates ??
      REPRESENTATIVE_MULTI_CYCLE_BORROW_CONFIG.lookaheadUpdates
  });
}

function buildRepresentativeBorrowAbortCandidate(
  snapshot: PoolSnapshot,
  config: KeeperConfig
): PlanCandidate {
  const collateralAmount =
    BigInt(String((snapshot.metadata?.borrowerCollateralWad as string | number | undefined) ?? "0")) >
    0n
      ? 0n
      : 10n * 10n ** 18n;

  return {
    id: "representative-manual-borrow",
    intent: "BORROW",
    minimumExecutionSteps: [
      {
        type: "DRAW_DEBT",
        amount: 1n * 10n ** 18n,
        limitIndex: 3000,
        collateralAmount
      }
    ],
    predictedOutcome: "STEP_UP",
    predictedRateBpsAfterNextUpdate: Math.max(
      snapshot.predictedNextRateBps,
      config.targetRateBps
    ),
    resultingDistanceToTargetBps: 0,
    quoteTokenDelta: 0n,
    explanation: "representative borrower-side steering plan for recheck invalidation coverage",
    planningRateBps: config.targetRateBps,
    planningLookaheadUpdates: config.borrowSimulationLookaheadUpdates ?? 1
  };
}

async function mintToken(
  walletClient: any,
  publicClient: any,
  artifact: { abi: unknown[] },
  tokenAddress: `0x${string}`,
  recipient: `0x${string}`,
  amount: bigint
): Promise<void> {
  const hash = await walletClient.writeContract({
    account: walletClient.account!,
    chain: undefined,
    address: tokenAddress,
    abi: artifact.abi,
    functionName: "mint",
    args: [recipient, amount]
  });

  await publicClient.waitForTransactionReceipt({ hash });
}

async function deployPoolThroughFactory(
  walletClient: any,
  publicClient: any,
  collateralToken: `0x${string}`,
  quoteToken: `0x${string}`
): Promise<`0x${string}`> {
  const deployHash = await walletClient.writeContract({
    account: walletClient.account!,
    chain: undefined,
    address: BASE_AJNA_DEPLOYMENT.erc20Factory,
    abi: ajnaErc20PoolFactoryAbi,
    functionName: "deployPool",
    args: [collateralToken, quoteToken, INITIAL_RATE_WAD]
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const poolCreatedLog = deployReceipt.logs
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
    .find((log: any) => log?.eventName === "PoolCreated");

  if (!poolCreatedLog) {
    throw new Error("PoolCreated event not found in factory receipt");
  }

  return poolCreatedLog.args.pool_ as `0x${string}`;
}

async function approveToken(
  walletClient: any,
  publicClient: any,
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
  abi: unknown[]
): Promise<void> {
  const hash = await walletClient.writeContract({
    account: walletClient.account!,
    chain: undefined,
    address: tokenAddress,
    abi,
    functionName: "approve",
    args: [spender, amount]
  });

  await publicClient.waitForTransactionReceipt({ hash });
}

async function readCurrentRateBps(
  publicClient: any,
  poolAddress: `0x${string}`
): Promise<number> {
  const [updatedRate] = await publicClient.readContract({
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "interestRateInfo"
  });

  return Number((updatedRate * 10_000n) / 1_000_000_000_000_000_000n);
}

function wmul(left: bigint, right: bigint): bigint {
  return (left * right + 500_000_000_000_000_000n) / 1_000_000_000_000_000_000n;
}

function wdiv(left: bigint, right: bigint): bigint {
  if (right === 0n) {
    return 0n;
  }

  return (left * 1_000_000_000_000_000_000n + right / 2n) / right;
}

function priceToFenwickIndex(priceWad: bigint): number {
  const price = Number(priceWad) / 1e18;
  const rawIndex = Math.log(price) / Math.log(AJNA_FLOAT_STEP);
  const ceilIndex = Math.ceil(rawIndex);
  const fenwickIndex =
    rawIndex < 0 && ceilIndex - rawIndex > 0.5 ? 4157 - ceilIndex : 4156 - ceilIndex;

  return Math.max(0, Math.min(7388, fenwickIndex));
}

async function readDwatpThresholdFenwickIndex(
  publicClient: any,
  poolAddress: `0x${string}`
): Promise<number | undefined> {
  const [[, , , rawT0Debt2ToCollateral], [rawInflator], rawTotalT0Debt, rawTotalT0DebtInAuction] =
    await Promise.all([
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
        functionName: "totalT0Debt"
      }),
      publicClient.readContract({
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "totalT0DebtInAuction"
      })
    ]);
  const inflator = BigInt(String(rawInflator));
  const t0Debt2ToCollateral = BigInt(String(rawT0Debt2ToCollateral));
  const totalT0Debt = BigInt(String(rawTotalT0Debt));
  const totalT0DebtInAuction = BigInt(String(rawTotalT0DebtInAuction));

  if (totalT0Debt <= totalT0DebtInAuction) {
    return undefined;
  }

  const nonAuctionedT0Debt = totalT0Debt - totalT0DebtInAuction;
  const dwatpWad = wdiv(
    wmul(wmul(inflator, t0Debt2ToCollateral), AJNA_COLLATERALIZATION_FACTOR_WAD),
    nonAuctionedT0Debt
  );

  return priceToFenwickIndex(dwatpWad);
}

async function advanceAndApplyEligibleUpdates(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  testClient: any,
  config: KeeperConfig,
  count: number
): Promise<{
  chainNow: number;
  currentRateBps: number;
}> {
  if (!config.poolAddress) {
    throw new Error("advanceAndApplyEligibleUpdates requires config.poolAddress");
  }

  let chainNow = Number((await publicClient.getBlock()).timestamp);

  for (let updateIndex = 0; updateIndex < count; updateIndex += 1) {
    const snapshot = await new AjnaRpcSnapshotSource(config, {
      publicClient,
      now: () => chainNow
    }).getSnapshot();

    if (snapshot.secondsUntilNextRateUpdate > 0) {
      await testClient.increaseTime({
        seconds: snapshot.secondsUntilNextRateUpdate
      });
      await testClient.mine({
        blocks: 1
      });
      chainNow = Number((await publicClient.getBlock()).timestamp);
    }

    const updateHash = await walletClient.writeContract({
      account,
      chain: undefined,
      address: config.poolAddress,
      abi: ajnaPoolAbi,
      functionName: "updateInterest"
    });
    await publicClient.waitForTransactionReceipt({ hash: updateHash });
    chainNow = Number((await publicClient.getBlock()).timestamp);
  }

  return {
    chainNow,
    currentRateBps: await readCurrentRateBps(publicClient, config.poolAddress)
  };
}

async function findManualPreWindowLendMatch(
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

async function findRealActiveBasePool(
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
        recheckBeforeSubmit: true
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

async function createQuoteOnlyBorrowFixture(
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

async function createExistingBorrowerSameCycleFixture(
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

async function createDeterministicPreWindowLendForecastFixture(
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

async function createComplexOngoingPreWindowLendFixture(
  account: { address: `0x${string}` },
  publicClient: any,
  walletClient: any,
  testClient: any,
  competing: ReturnType<typeof createClientsForPrivateKey>,
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

async function findRepresentativeBorrowedStepUpState(
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

    if (snapshot.currentRateBps > baselineConfig.targetRateBps && snapshot.predictedNextOutcome === "STEP_UP") {
      return {
        poolAddress,
        chainNow,
        baselineSnapshot: snapshot
      };
    }
  }

  return undefined;
}

function requireSnapshotMetadataValue(
  snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>,
  key: string
): string | number {
  const value = snapshot.metadata?.[key];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`snapshot metadata is missing ${key}`);
  }

  return value;
}

function extractAjnaRateState(
  snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>,
  chainNow: number
): AjnaRateState {
  return {
    currentRateWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "currentRateWad"))),
    currentDebtWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "currentDebtWad"))),
    debtEmaWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "debtEmaWad"))),
    depositEmaWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "depositEmaWad"))),
    debtColEmaWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "debtColEmaWad"))),
    lupt0DebtEmaWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "lupt0DebtEmaWad"))),
    lastInterestRateUpdateTimestamp: Number(requireSnapshotMetadataValue(snapshot, "lastInterestRateUpdateTimestamp")),
    nowTimestamp: chainNow
  };
}

function extractQuoteTokenScale(
  snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>
): bigint {
  return BigInt(String(requireSnapshotMetadataValue(snapshot, "quoteTokenScale")));
}

async function findExactDualCandidateFromSnapshot(
  publicClient: any,
  account: { address: `0x${string}` },
  poolAddress: `0x${string}`,
  chainNow: number,
  baselineSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>,
  options?: {
    maxValidationsWithPureMatch?: number;
    maxValidationsWithoutPureMatch?: number;
  }
): Promise<{
  attemptedConfigCount: number;
  match?: {
    config: KeeperConfig;
    baselineSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
    exactSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
    dualCandidate: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>["candidates"][number];
  };
}> {
  const rateState = extractAjnaRateState(baselineSnapshot, chainNow);
  const quoteTokenScale = extractQuoteTokenScale(baselineSnapshot);
  const baselinePrediction = forecastAjnaNextEligibleRate(rateState);
  const targetRateCandidates = Array.from(
    new Set(
      REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.dualSearch.targetOffsetsBps
        .map((offsetBps) => baselineSnapshot.currentRateBps + offsetBps)
        .filter((targetRateBps) => targetRateBps > baselineSnapshot.currentRateBps)
    )
  );
  const candidateConfigs = targetRateCandidates
    .flatMap((targetRateBps) =>
      REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.dualSearch.tolerancesBps.flatMap((toleranceBps) =>
        REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.dualSearch.lookaheadUpdates.flatMap((lookahead) =>
          REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.dualSearch.collateralAmounts.map((collateralAmount) => ({
            config: resolveKeeperConfig({
              chainId: 8453,
              poolAddress,
              poolId: `8453:${poolAddress.toLowerCase()}`,
              rpcUrl: LOCAL_RPC_URL,
              targetRateBps,
              toleranceBps,
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
              enableSimulationBackedLendSynthesis: true,
              enableSimulationBackedBorrowSynthesis: true,
              addQuoteBucketIndex: 3000,
              addQuoteBucketIndexes: [...STEERING_BUCKET_CANDIDATES],
              addQuoteExpirySeconds: 3600,
              drawDebtLimitIndexes: [3000],
              drawDebtCollateralAmounts: [collateralAmount],
              borrowSimulationLookaheadUpdates: lookahead
            })
          }))
        )
      )
    );
  const rankedConfigs = candidateConfigs
    .map(({ config }) => ({
      config,
      pureCandidate: synthesizeAjnaLendAndBorrowCandidate(rateState, config, {
        quoteTokenScale,
        nowTimestamp: chainNow,
        baselinePrediction
      })
    }))
    .sort((left, right) => {
      if (left.pureCandidate && right.pureCandidate) {
        if (
          left.pureCandidate.resultingDistanceToTargetBps !==
          right.pureCandidate.resultingDistanceToTargetBps
        ) {
          return (
            left.pureCandidate.resultingDistanceToTargetBps -
            right.pureCandidate.resultingDistanceToTargetBps
          );
        }

        if (left.pureCandidate.quoteTokenDelta !== right.pureCandidate.quoteTokenDelta) {
          return left.pureCandidate.quoteTokenDelta < right.pureCandidate.quoteTokenDelta ? -1 : 1;
        }
      }

      if (left.pureCandidate) {
        return -1;
      }

      if (right.pureCandidate) {
        return 1;
      }

      return left.config.targetRateBps - right.config.targetRateBps;
    });
  const configsToValidate = (() => {
    const pureMatches = rankedConfigs.filter(({ pureCandidate }) => pureCandidate !== undefined);
    if (pureMatches.length > 0) {
      return pureMatches.slice(
        0,
        options?.maxValidationsWithPureMatch ?? MAX_EXACT_DUAL_VALIDATIONS_WITH_PURE_MATCH
      );
    }

    return rankedConfigs.slice(
      0,
      options?.maxValidationsWithoutPureMatch ?? MAX_EXACT_DUAL_VALIDATIONS_WITHOUT_PURE_MATCH
    );
  })();
  let firstDualMatch:
    | {
        config: KeeperConfig;
        baselineSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
        exactSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
        dualCandidate: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>["candidates"][number];
      }
    | undefined;

  for (const { config } of configsToValidate) {
    const exactSnapshot = await new AjnaRpcSnapshotSource(config, {
      publicClient,
      now: () => chainNow
    }).getSnapshot();
    const dualCandidate = exactSnapshot.candidates.find(
      (candidate) => candidate.intent === "LEND_AND_BORROW"
    );
    if (dualCandidate) {
      const candidateMatch = {
        config,
        baselineSnapshot,
        exactSnapshot,
        dualCandidate
      };
      if (!firstDualMatch) {
        firstDualMatch = candidateMatch;
      }

      if (planCycle(exactSnapshot, config).intent === "LEND_AND_BORROW") {
        return {
          attemptedConfigCount: configsToValidate.length,
          match: candidateMatch
        };
      }

      continue;
    }
  }

  if (firstDualMatch) {
    return {
      attemptedConfigCount: configsToValidate.length,
      match: firstDualMatch
    };
  }

  return {
    attemptedConfigCount: configsToValidate.length
  };
}

async function findExactDualCandidateConfig(
  publicClient: any,
  account: { address: `0x${string}` },
  poolAddress: `0x${string}`,
  chainNow: number
): Promise<{
  config: KeeperConfig;
  baselineSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
  exactSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
  dualCandidate: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>["candidates"][number];
  attemptedConfigCount: number;
}> {
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
  const match = await findExactDualCandidateFromSnapshot(
    publicClient,
    account,
    poolAddress,
    chainNow,
    baselineSnapshot
  );
  if (match.match) {
    return {
      ...match.match,
      attemptedConfigCount: match.attemptedConfigCount
    };
  }

  throw new Error("failed to validate an exact dual candidate");
}

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
): Promise<
  | {
      poolAddress: `0x${string}`;
      chainNow: number;
      config: KeeperConfig;
      snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
      plan: ReturnType<typeof planCycle>;
    }
  | undefined
> {
  const scenarios =
    options.scenarios ?? REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_SCENARIOS;
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
    const { testClient } = createClients();
    outerSnapshotId = await testClient.snapshot();
  });

  afterEach(async () => {
    if (!outerSnapshotId) {
      return;
    }

    const { testClient } = createClients();
    await testClient.revert({ id: outerSnapshotId });
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

      const { quoteTokenAddress } = planningSnapshot.metadata as {
        quoteTokenAddress: `0x${string}`;
      };

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
        match.dualCandidate.minimumExecutionSteps.some((step) => step.type === "ADD_QUOTE")
      ).toBe(true);
      expect(
        match.dualCandidate.minimumExecutionSteps.some((step) => step.type === "DRAW_DEBT")
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
      expect(result.plan.requiredSteps.some((step) => step.type === "ADD_QUOTE")).toBe(true);
      expect(result.plan.requiredSteps.some((step) => step.type === "DRAW_DEBT")).toBe(true);
      expect(result.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")).toBe(
        false
      );
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
            selectedConfig: KeeperConfig;
            chainNow: number;
            exactSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
            heuristicSnapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
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
            (candidate) => candidate.intent === "LEND"
          );
          const heuristicHasLend = heuristicSnapshot.candidates.some(
            (candidate) => candidate.intent === "LEND"
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
        matched.exactSnapshot.candidates.some((candidate) => candidate.intent === "LEND") ||
          matched.heuristicSnapshot.candidates.some((candidate) => candidate.intent === "LEND")
      ).toBe(true);

      const snapshotSource = new AjnaRpcSnapshotSource(matched.selectedConfig, {
        publicClient,
        now: () => matched.chainNow
      });
      const result = await runCycle(matched.selectedConfig, {
        snapshotSource,
        executor: new DryRunExecutionBackend()
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("LEND");
      expect(result.plan.requiredSteps.some((step) => step.type === "ADD_QUOTE")).toBe(true);
      expect(result.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")).toBe(
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
      expect(exactSnapshot.candidates.some((candidate) => candidate.intent === "LEND")).toBe(false);

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
      expect(heuristicSnapshot.candidates.some((candidate) => candidate.intent === "LEND")).toBe(
        false
      );
      expect(
        heuristicSnapshot.candidates.some((candidate) => candidate.intent === "LEND_AND_BORROW")
      ).toBe(false);
    },
    120_000
  );

  itBaseExperimental(
    "does not surface pre-window lend plans across representative complex ongoing multi-actor fixtures",
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
      expect(exactSnapshot.candidates.some((candidate) => candidate.intent === "LEND")).toBe(false);
      expect(
        exactSnapshot.candidates.some((candidate) => candidate.intent === "LEND_AND_BORROW")
      ).toBe(false);

      const heuristicConfig = resolveKeeperConfig({
        ...matched.config,
        enableHeuristicLendSynthesis: true
      });
      const heuristicSnapshot = await new AjnaRpcSnapshotSource(heuristicConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      expect(
        heuristicSnapshot.candidates.some((candidate) => candidate.intent === "LEND")
      ).toBe(false);
      expect(
        heuristicSnapshot.candidates.some((candidate) => candidate.intent === "LEND_AND_BORROW")
      ).toBe(false);
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
      const lendCandidate = exactSnapshot.candidates.find((candidate) => candidate.intent === "LEND");

      expect(lendCandidate).toBeDefined();
      expect(lendCandidate?.planningLookaheadUpdates).toBe(2);
      expect(planCycle(exactSnapshot, exactConfig).intent).toBe("LEND");

      const result = await runCycle(exactConfig, {
        snapshotSource,
        executor: createAjnaExecutionBackend(exactConfig)
      });

      expect(result.status).toBe("EXECUTED");
      expect(result.plan.intent).toBe("LEND");
      expect(result.plan.requiredSteps.some((step) => step.type === "ADD_QUOTE")).toBe(true);
      expect(result.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")).toBe(
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
    "surfaces an exact multi-cycle pre-window lend plan from the deterministic fixture when the known-good bucket is pinned",
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
      const derivedBucketIndexes = Array.from(
        new Set(
          EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS.map((offset) =>
            Math.max(0, Math.min(7388, (thresholdIndex ?? 0) + offset))
          )
        )
      ).sort((left, right) => left - right);
      expect(derivedBucketIndexes).toContain(positiveMatch!.bucketIndex);

      const bucketPinnedConfig = resolveKeeperConfig({
        ...matched.config,
        addQuoteBucketIndex: positiveMatch!.bucketIndex,
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address
      });
      const exactSnapshot = await new AjnaRpcSnapshotSource(bucketPinnedConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      const lendCandidate = exactSnapshot.candidates.find((candidate) => candidate.intent === "LEND");

      expect(lendCandidate).toBeDefined();
      expect(lendCandidate?.planningLookaheadUpdates).toBe(2);
      expect(lendCandidate?.minimumExecutionSteps[0]).toMatchObject({
        type: "ADD_QUOTE",
        bucketIndex: positiveMatch!.bucketIndex
      });
    },
    240_000
  );

  itBaseExperimental(
    "does not yet surface an exact pre-window lend plan from the deterministic fixture with threshold-aware buckets",
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
        ...matched.config,
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address
      });
      const exactSnapshot = await new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      const lendCandidate = exactSnapshot.candidates.find((candidate) => candidate.intent === "LEND");

      expect(lendCandidate).toBeUndefined();
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

        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: config.poolAddress!,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });

        const updatedRateBps = await readCurrentRateBps(publicClient, config.poolAddress!);
        const allowedRateBps = new Set<number>([
          snapshot.currentRateBps,
          Math.round(snapshot.currentRateBps * 1.1),
          Math.round(snapshot.currentRateBps * 0.9),
          1000
        ]);
        expect(allowedRateBps.has(updatedRateBps)).toBe(true);

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
        expect(result.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")).toBe(true);
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
});

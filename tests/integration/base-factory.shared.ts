import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
  AjnaRpcSnapshotSource,
  type AjnaRateState,
  ajnaErc20PoolFactoryAbi,
  ajnaPoolAbi,
  BASE_AJNA_DEPLOYMENT,
  forecastAjnaNextEligibleRate,
  planCycle,
  resolveKeeperConfig,
  synthesizeAjnaLendAndBorrowCandidate,
  type KeeperConfig,
  type PlanCandidate,
  type PoolSnapshot
} from "../../src/index.js";
import {
  readSnapshotMetadataBigInt,
  requireSnapshotMetadataBigInt,
  requireSnapshotMetadataScalar
} from "../../src/snapshot-metadata.js";
import {
  AJNA_COLLATERALIZATION_FACTOR_WAD,
  TWELVE_HOURS_SECONDS,
  priceToFenwickIndex,
  wdiv,
  wmul
} from "./base-factory.protocol.js";
import {
  MAX_EXACT_DUAL_VALIDATIONS_WITHOUT_PURE_MATCH,
  MAX_EXACT_DUAL_VALIDATIONS_WITH_PURE_MATCH,
  REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST,
  REPRESENTATIVE_MULTI_CYCLE_BORROW_CONFIG,
  STEERING_BUCKET_CANDIDATES
} from "./base-factory.fixtures.js";

const execFile = promisify(execFileCallback);

export const RUN_BASE_FORK_TESTS = process.env.RUN_BASE_FORK_TESTS === "1";
export const RUN_BASE_FORK_SMOKE_TESTS = process.env.RUN_BASE_FORK_SMOKE_TESTS === "1";
export const RUN_BASE_FORK_SLOW_TESTS = process.env.RUN_BASE_FORK_SLOW_TESTS === "1";
export const RUN_BASE_FORK_STRESS_TESTS = process.env.RUN_BASE_FORK_STRESS_TESTS === "1";
export const RUN_BASE_FORK_EXPERIMENTAL_TESTS = process.env.RUN_BASE_FORK_EXPERIMENTAL_TESTS === "1";
export const RUN_BASE_FORK_ALL_TESTS = process.env.RUN_BASE_FORK_ALL_TESTS === "1";
export const TEST_PORT = 9545;
export const DEFAULT_LOCAL_ANVIL_URL = `http://127.0.0.1:${TEST_PORT}`;
export const EXTERNAL_LOCAL_ANVIL_URL = process.env.BASE_LOCAL_ANVIL_URL?.trim() || undefined;
export const LOCAL_RPC_URL = EXTERNAL_LOCAL_ANVIL_URL ?? DEFAULT_LOCAL_ANVIL_URL;
export const DEFAULT_ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const COMPETING_ANVIL_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945382dbf7f2e1a0d7f6c3b5b0c2cf4f1f7f94";
export const INITIAL_RATE_WAD = 100_000_000_000_000_000n;

export type MockArtifact = {
  abi: unknown[];
  bytecode: `0x${string}`;
};

export type TestAjnaSnapshot = Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;

let mockArtifactPromise: Promise<MockArtifact> | undefined;

export function currentBaseForkProfile():
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

export function describeForkHost(forkUrl: string): string {
  try {
    return new URL(forkUrl).host;
  } catch {
    return forkUrl;
  }
}

export function formatTokenAmount(amountWad: bigint): string {
  const sign = amountWad < 0n ? "-" : "";
  const absolute = amountWad < 0n ? -amountWad : amountWad;
  const whole = absolute / 10n ** 18n;
  const fractional = absolute % 10n ** 18n;
  const trimmedFractional = fractional.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");

  return trimmedFractional.length > 0
    ? `${sign}${whole.toString()}.${trimmedFractional}`
    : `${sign}${whole.toString()}`;
}

export function formatWeiAsEth(amountWei: bigint): string {
  return formatTokenAmount(amountWei);
}

export function distanceToTargetRateBps(rateBps: number, targetRateBps: number): number {
  return Math.abs(rateBps - targetRateBps);
}

export async function withRevertedBranch<T>(
  testClient: any,
  runBranch: () => Promise<T>
): Promise<T> {
  const branchId = await testClient.snapshot();

  try {
    return await runBranch();
  } finally {
    await testClient.revert({ id: branchId });
  }
}

export async function capturePassiveRateBranch<TPath extends { currentRateBps: number }>(
  testClient: any,
  targetRateBps: number,
  runPath: () => Promise<TPath>
): Promise<{
  passivePath: TPath;
  passiveDistanceToTargetBps: number;
}> {
  const passivePath = await withRevertedBranch(testClient, runPath);

  return {
    passivePath,
    passiveDistanceToTargetBps: distanceToTargetRateBps(
      passivePath.currentRateBps,
      targetRateBps
    )
  };
}

export async function executeRateProbeBranch<TPath extends { currentRateBps: number }>(options: {
  testClient: any;
  targetRateBps: number;
  observations: string[];
  label: string;
  runBranch: () => Promise<TPath>;
  passivePath?: { currentRateBps: number };
}): Promise<{
  activePath?: TPath;
  activeDistanceToTargetBps?: number;
  error?: string;
}> {
  const { observations, passivePath, targetRateBps, testClient } = options;

  return withRevertedBranch(testClient, async () => {
    try {
      const activePath = await options.runBranch();
      const activeDistanceToTargetBps = distanceToTargetRateBps(
        activePath.currentRateBps,
        targetRateBps
      );
      observations.push(
        [
          options.label,
          ...(passivePath === undefined ? [] : [`passive=${passivePath.currentRateBps}`]),
          ...(passivePath === undefined
            ? []
            : [
                `passiveDistance=${distanceToTargetRateBps(
                  passivePath.currentRateBps,
                  targetRateBps
                )}`
              ]),
          `active=${activePath.currentRateBps}`,
          `activeDistance=${activeDistanceToTargetBps}`
        ].join(" ")
      );

      return {
        activePath,
        activeDistanceToTargetBps
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observations.push(`${options.label} error=${message}`);
      return {
        error: message
      };
    }
  });
}

export function repoRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function artifactPath(): string {
  return join(repoRoot(), "out", "MockERC20.sol", "MockERC20.json");
}

export async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
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

export async function waitForRpcListener(rpcUrl: string, timeoutMs = 20_000): Promise<void> {
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

export async function ensureMockArtifact(): Promise<MockArtifact> {
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

export async function deployMockToken(
  walletClient: any,
  publicClient: any,
  artifact: MockArtifact,
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

export function createClients() {
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

export function createClientsForPrivateKey(privateKey: `0x${string}`) {
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

export function createRpcWalletClient() {
  return createWalletClient({
    chain: base,
    transport: http(LOCAL_RPC_URL)
  }) as any;
}

export async function listUnlockedRpcAccounts(publicClient: any): Promise<`0x${string}`[]> {
  return publicClient.request({
    method: "eth_accounts",
    params: []
  }) as Promise<`0x${string}`[]>;
}

async function waitForContractWrite(publicClient: any, transactionHash: Hex): Promise<void> {
  await publicClient.waitForTransactionReceipt({ hash: transactionHash });
}

export async function writePoolContractFromAddress(
  walletClient: any,
  publicClient: any,
  accountAddress: `0x${string}`,
  poolAddress: `0x${string}`,
  request:
    | {
        functionName: "addQuoteToken";
        args: [bigint, bigint, bigint];
      }
    | {
        functionName: "drawDebt";
        args: [`0x${string}`, bigint, bigint, bigint];
      }
    | {
        functionName: "updateInterest";
        args?: [];
      }
): Promise<void> {
  const hash = await walletClient.writeContract({
    account: accountAddress,
    chain: undefined,
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: request.functionName,
    args: request.args ?? []
  });
  await waitForContractWrite(publicClient, hash);
}

export async function writeTokenContractFromAddress(
  walletClient: any,
  publicClient: any,
  accountAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  request:
    | {
        functionName: "approve";
        args: [`0x${string}`, bigint];
      }
): Promise<void> {
  const hash = await walletClient.writeContract({
    account: accountAddress,
    chain: undefined,
    address: tokenAddress,
    abi: (await ensureMockArtifact()).abi,
    functionName: request.functionName,
    args: request.args
  });
  await waitForContractWrite(publicClient, hash);
}

export function buildRepresentativeBorrowLookaheadConfig(
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

export function buildRepresentativeBorrowAbortCandidate(
  snapshot: PoolSnapshot,
  config: KeeperConfig
): PlanCandidate {
  const collateralAmount =
    (readSnapshotMetadataBigInt(snapshot, "borrowerCollateral") ?? 0n) > 0n
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

export async function mintToken(
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

export async function deployPoolThroughFactory(
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

export async function approveToken(
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

export async function readCurrentRateBps(
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

export async function readCurrentRateInfo(
  publicClient: any,
  poolAddress: `0x${string}`
): Promise<{
  currentRateBps: number;
  lastInterestRateUpdateTimestamp: number;
}> {
  const [updatedRate, rawTimestamp] = await publicClient.readContract({
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "interestRateInfo"
  });

  return {
    currentRateBps: Number((updatedRate * 10_000n) / 1_000_000_000_000_000_000n),
    lastInterestRateUpdateTimestamp: Number(rawTimestamp)
  };
}

export async function readBorrowerDebtState(
  publicClient: any,
  poolAddress: `0x${string}`,
  borrowerAddress: `0x${string}`
): Promise<{
  t0Debt: bigint;
  collateral: bigint;
  currentDebtWad: bigint;
}> {
  const [borrowerInfo, inflatorInfo] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "borrowerInfo",
      args: [borrowerAddress]
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "inflatorInfo"
    })
  ]);
  const t0Debt = BigInt(String(borrowerInfo[0]));
  const collateral = BigInt(String(borrowerInfo[1]));
  const inflator = BigInt(String(inflatorInfo[0]));

  return {
    t0Debt,
    collateral,
    currentDebtWad: wmul(t0Debt, inflator)
  };
}

export async function readDwatpThresholdFenwickIndex(
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

export async function advanceAndApplyEligibleUpdates(
  account: { address: `0x${string}` } | `0x${string}`,
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

export async function advanceAndApplyEligibleUpdatesDirect(
  account: { address: `0x${string}` } | `0x${string}`,
  publicClient: any,
  walletClient: any,
  testClient: any,
  poolAddress: `0x${string}`,
  count: number
): Promise<{
  chainNow: number;
  currentRateBps: number;
}> {
  let chainNow = Number((await publicClient.getBlock()).timestamp);

  for (let updateIndex = 0; updateIndex < count; updateIndex += 1) {
    const { lastInterestRateUpdateTimestamp } = await readCurrentRateInfo(publicClient, poolAddress);
    const elapsedSeconds = Math.max(0, chainNow - lastInterestRateUpdateTimestamp);
    const secondsUntilNextRateUpdate =
      elapsedSeconds > TWELVE_HOURS_SECONDS ? 0 : TWELVE_HOURS_SECONDS + 1 - elapsedSeconds;

    if (secondsUntilNextRateUpdate > 0) {
      await testClient.increaseTime({
        seconds: secondsUntilNextRateUpdate
      });
      await testClient.mine({
        blocks: 1
      });
      chainNow = Number((await publicClient.getBlock()).timestamp);
    }

    const updateHash = await walletClient.writeContract({
      account,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "updateInterest"
    });
    await publicClient.waitForTransactionReceipt({ hash: updateHash });
    chainNow = Number((await publicClient.getBlock()).timestamp);
  }

  return {
    chainNow,
    currentRateBps: await readCurrentRateBps(publicClient, poolAddress)
  };
}

export function requireSnapshotMetadataValue(
  snapshot: TestAjnaSnapshot,
  key:
    | "currentRateWad"
    | "currentDebtWad"
    | "debtEmaWad"
    | "depositEmaWad"
    | "debtColEmaWad"
    | "lupt0DebtEmaWad"
    | "lastInterestRateUpdateTimestamp"
    | "quoteTokenScale"
): string | number {
  return requireSnapshotMetadataScalar(snapshot, key);
}

export function extractAjnaRateState(snapshot: TestAjnaSnapshot, chainNow: number): AjnaRateState {
  return {
    currentRateWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "currentRateWad"))),
    currentDebtWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "currentDebtWad"))),
    debtEmaWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "debtEmaWad"))),
    depositEmaWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "depositEmaWad"))),
    debtColEmaWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "debtColEmaWad"))),
    lupt0DebtEmaWad: BigInt(String(requireSnapshotMetadataValue(snapshot, "lupt0DebtEmaWad"))),
    lastInterestRateUpdateTimestamp: Number(
      requireSnapshotMetadataValue(snapshot, "lastInterestRateUpdateTimestamp")
    ),
    nowTimestamp: chainNow
  };
}

export function extractQuoteTokenScale(snapshot: TestAjnaSnapshot): bigint {
  return requireSnapshotMetadataBigInt(snapshot, "quoteTokenScale");
}

export function drawDebtIntoRateStateForTest(
  state: AjnaRateState,
  debtAmountWad: bigint,
  collateralAmountWad: bigint
): AjnaRateState {
  return {
    ...state,
    currentDebtWad: state.currentDebtWad + debtAmountWad,
    debtEmaWad: state.debtEmaWad + debtAmountWad,
    debtColEmaWad: state.debtColEmaWad + collateralAmountWad
  };
}

function squareWithProtocolScalingForTest(value: bigint): bigint {
  const scaled = value / 1_000_000_000n;
  return scaled * scaled;
}

export function computeStepUpMargin(state: AjnaRateState): bigint {
  const protocolWad = 1_000_000_000_000_000_000n;
  const mau = state.currentDebtWad === 0n ? 0n : wdiv(state.debtEmaWad, state.depositEmaWad);
  const mau102 = (mau * 102n) / 100n;
  const tu =
    state.lupt0DebtEmaWad !== 0n ? wdiv(state.debtColEmaWad, state.lupt0DebtEmaWad) : protocolWad;

  return squareWithProtocolScalingForTest(tu + mau102 - protocolWad) - protocolWad - 4n * (tu - mau102);
}

export async function findExactDualCandidateFromSnapshot(
  publicClient: any,
  account: { address: `0x${string}` },
  poolAddress: `0x${string}`,
  chainNow: number,
  baselineSnapshot: TestAjnaSnapshot,
  options?: {
    maxValidationsWithPureMatch?: number;
    maxValidationsWithoutPureMatch?: number;
  }
): Promise<{
  attemptedConfigCount: number;
  match?: {
    config: KeeperConfig;
    baselineSnapshot: TestAjnaSnapshot;
    exactSnapshot: TestAjnaSnapshot;
    dualCandidate: TestAjnaSnapshot["candidates"][number];
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
  const candidateConfigs = targetRateCandidates.flatMap((targetRateBps) =>
    REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.dualSearch.tolerancesBps.flatMap((toleranceBps) =>
      REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.dualSearch.lookaheadUpdates.flatMap(
        (lookahead) =>
          REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST.dualSearch.collateralAmounts.map(
            (collateralAmount) => ({
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
            })
          )
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
        baselineSnapshot: TestAjnaSnapshot;
        exactSnapshot: TestAjnaSnapshot;
        dualCandidate: TestAjnaSnapshot["candidates"][number];
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

export async function findExactDualCandidateConfig(
  publicClient: any,
  account: { address: `0x${string}` },
  poolAddress: `0x${string}`,
  chainNow: number
): Promise<{
  config: KeeperConfig;
  baselineSnapshot: TestAjnaSnapshot;
  exactSnapshot: TestAjnaSnapshot;
  dualCandidate: TestAjnaSnapshot["candidates"][number];
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

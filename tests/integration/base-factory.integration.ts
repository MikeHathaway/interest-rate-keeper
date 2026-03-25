import "dotenv/config";

import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import net from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  http
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import {
  ajnaErc20PoolFactoryAbi,
  ajnaPoolAbi,
  BASE_AJNA_DEPLOYMENT,
  AjnaRpcSnapshotSource,
  createAjnaExecutionBackend,
  DryRunExecutionBackend,
  resolveKeeperConfig,
  runCycle,
  type KeeperConfig
} from "../../src/index.js";

const execFile = promisify(execFileCallback);
const RUN_BASE_FORK_TESTS = process.env.RUN_BASE_FORK_TESTS === "1";
const TEST_PORT = 9545;
const LOCAL_RPC_URL = `http://127.0.0.1:${TEST_PORT}`;
const DEFAULT_ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const INITIAL_RATE_WAD = 100_000_000_000_000_000n;
const DECREASED_RATE_BPS = 900;
const FORK_TIME_SKIP_SECONDS = 12 * 60 * 60 + 5;
const STEERING_BUCKET_CANDIDATES = [2500, 2750, 3000, 3250, 3500] as const;
const BORROW_COLLATERAL_CANDIDATES = [1n, 2n, 5n, 10n, 20n, 50n, 100n] as const;
const STEERING_SCENARIOS = [
  { initialQuoteAmount: 500n, borrowAmount: 400n, collateralAmount: 600n },
  { initialQuoteAmount: 500n, borrowAmount: 450n, collateralAmount: 800n },
  { initialQuoteAmount: 500n, borrowAmount: 490n, collateralAmount: 1_000n },
  { initialQuoteAmount: 750n, borrowAmount: 650n, collateralAmount: 1_000n },
  { initialQuoteAmount: 1_000n, borrowAmount: 850n, collateralAmount: 1_200n },
  { initialQuoteAmount: 1_000n, borrowAmount: 950n, collateralAmount: 1_500n },
  { initialQuoteAmount: 1_000n, borrowAmount: 990n, collateralAmount: 2_000n }
] as const;

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

async function ensureMockArtifact(): Promise<{
  abi: unknown[];
  bytecode: `0x${string}`;
}> {
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
}

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

const describeIf = RUN_BASE_FORK_TESTS ? describe : describe.skip;

describeIf("Base factory fork integration", () => {
  let anvil: ChildProcess | undefined;

  beforeAll(async () => {
    const forkUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
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
        stdio: "pipe"
      }
    );

    await waitForPort(TEST_PORT);
  }, 30_000);

  afterAll(() => {
    anvil?.kill("SIGTERM");
  });

  it(
    "creates a new pool through the deployed Base factory and updates interest after fast-forwarding time",
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

  it(
    "does not yet find an exact same-cycle borrow steering candidate in a representative abandoned-pool state",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      const collateralToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        "Borrow Steering Collateral",
        "BSC"
      );
      const quoteToken = await deployMockToken(
        walletClient,
        publicClient,
        artifact,
        "Borrow Steering Quote",
        "BSQ"
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

      let matched:
        | {
            poolAddress: `0x${string}`;
            chainNow: number;
            config: KeeperConfig;
            snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
          }
        | undefined;
      let evaluatedEligibleState = false;

      for (let preUpdates = 0; preUpdates < 6; preUpdates += 1) {
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

        if (
          baselineSnapshot.currentRateBps < 1000 &&
          baselineSnapshot.predictedNextOutcome !== "STEP_UP"
        ) {
          evaluatedEligibleState = true;
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
            drawDebtLimitIndexes: [3000],
            drawDebtCollateralAmounts: ["10000000000000000000"]
          });
          const snapshot = await new AjnaRpcSnapshotSource(config, {
            publicClient,
            now: () => chainNow
          }).getSnapshot();

          if (snapshot.candidates.some((candidate) => candidate.intent === "BORROW")) {
            matched = {
              poolAddress,
              chainNow,
              config,
              snapshot
            };
          }

          break;
        }

        if (matched) {
          break;
        }

        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
      }

      expect(evaluatedEligibleState).toBe(true);
      expect(matched).toBeUndefined();
    },
    120_000
  );

  it(
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

      for (const [index, scenario] of STEERING_SCENARIOS.entries()) {
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
      expect(result.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")).toBe(true);
    },
    120_000
  );

  it(
    "forecasts the next-cycle rate from a post-update state and exact pre-window lend synthesis can pre-position ahead of the window",
    async () => {
      const { account, publicClient, walletClient, testClient } = createClients();
      const artifact = await ensureMockArtifact();
      process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

      let matched:
        | {
            poolAddress: `0x${string}`;
            chainNow: number;
            snapshot: Awaited<ReturnType<AjnaRpcSnapshotSource["getSnapshot"]>>;
          }
        | undefined;

      for (const [index, scenario] of STEERING_SCENARIOS.entries()) {
        const collateralToken = await deployMockToken(
          walletClient,
          publicClient,
          artifact,
          `Pre Position Collateral ${index}`,
          `PPC${index}`
        );
        const quoteToken = await deployMockToken(
          walletClient,
          publicClient,
          artifact,
          `Pre Position Quote ${index}`,
          `PPQ${index}`
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
        const config = resolveKeeperConfig({
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
          matched = {
            poolAddress,
            chainNow,
            snapshot
          };
          break;
        }
      }

      if (!matched) {
        throw new Error("failed to find a post-update not-due step-up forecast scenario");
      }

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
        addQuoteBucketIndex: STEERING_BUCKET_CANDIDATES[0],
        addQuoteExpirySeconds: 3600,
        enableSimulationBackedLendSynthesis: true,
        simulationSenderAddress: account.address
      });
      const exactSnapshot = await new AjnaRpcSnapshotSource(exactConfig, {
        publicClient,
        now: () => matched.chainNow
      }).getSnapshot();
      expect(exactSnapshot.candidates.some((candidate) => candidate.intent === "LEND")).toBe(true);

      const preWindowResult = await runCycle(exactConfig, {
        snapshotSource: new AjnaRpcSnapshotSource(exactConfig, {
          publicClient,
          now: () => matched.chainNow
        }),
        executor: new DryRunExecutionBackend()
      });
      expect(preWindowResult.status).toBe("EXECUTED");
      expect(preWindowResult.plan.intent).toBe("LEND");
      expect(preWindowResult.plan.requiredSteps.some((step) => step.type === "ADD_QUOTE")).toBe(
        true
      );
      expect(
        preWindowResult.plan.requiredSteps.some((step) => step.type === "UPDATE_INTEREST")
      ).toBe(false);

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
    120_000
  );

  it(
    "handles repeated update-only cycles across roughly a week until the target band is reached, then stops cleanly",
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

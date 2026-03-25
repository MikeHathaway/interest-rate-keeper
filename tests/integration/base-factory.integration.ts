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
      const account = privateKeyToAccount(DEFAULT_ANVIL_PRIVATE_KEY);
      const publicClient: any = createPublicClient({
        chain: base,
        transport: http(LOCAL_RPC_URL)
      });
      const walletClient: any = createWalletClient({
        account,
        chain: base,
        transport: http(LOCAL_RPC_URL)
      });
      const testClient: any = createTestClient({
        chain: base,
        mode: "anvil",
        transport: http(LOCAL_RPC_URL)
      });

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
        const mintHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: tokenAddress,
          abi: artifact.abi,
          functionName: "mint",
          args: [account.address, 10_000n * 10n ** 18n]
        });
        await publicClient.waitForTransactionReceipt({ hash: mintHash });
      }

      const deployHash = await walletClient.writeContract({
        account,
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

      const poolAddress = poolCreatedLog.args.pool_ as `0x${string}`;

      const approveHash = await walletClient.writeContract({
        account,
        chain: undefined,
        address: quoteToken,
        abi: artifact.abi,
        functionName: "approve",
        args: [poolAddress, 2_000n * 10n ** 18n]
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

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
      const [updatedRate] = await publicClient.readContract({
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "interestRateInfo"
      });

      expect(Number((updatedRate * 10_000n) / 1_000_000_000_000_000_000n)).toBe(
        DECREASED_RATE_BPS
      );
    },
    120_000
  );
});

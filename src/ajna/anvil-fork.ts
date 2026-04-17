import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

import {
  defineChain,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type PublicClient
} from "viem";

export interface TemporaryAnvilForkOptions {
  rpcUrl: string;
  chainId: number;
  blockNumber: bigint;
}

export interface TemporaryAnvilForkContext {
  rpcUrl?: string;
  publicClient: PublicClient;
  testClient: ReturnType<typeof createTestClient>;
  walletClient: ReturnType<typeof createWalletClient>;
}

interface TemporaryAnvilForkHandle extends TemporaryAnvilForkContext {
  rpcUrl: string;
  stop: () => Promise<void>;
}

async function findOpenPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a local port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
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

async function stopChildProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
    }, 2_000);

    process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    process.kill("SIGTERM");
  });
}

async function startTemporaryAnvilFork(
  options: TemporaryAnvilForkOptions
): Promise<TemporaryAnvilForkHandle> {
  const port = await findOpenPort();
  let stderrBuffer = "";

  const anvil = spawn(
    "anvil",
    [
      "--fork-url",
      options.rpcUrl,
      "--fork-block-number",
      options.blockNumber.toString(),
      "--port",
      String(port),
      "--chain-id",
      String(options.chainId),
      "--silent"
    ],
    {
      stdio: ["ignore", "ignore", "pipe"]
    }
  );

  anvil.stderr?.setEncoding("utf8");
  anvil.stderr?.on("data", (chunk: string) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4_096);
  });

  try {
    await waitForPort(port);

    const rpcUrl = `http://127.0.0.1:${port}`;
    const forkChain = defineChain({
      id: options.chainId,
      name: `fork-${options.chainId}`,
      nativeCurrency: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18
      },
      rpcUrls: {
        default: {
          http: [rpcUrl]
        }
      }
    });
    const publicClient = createPublicClient({
      transport: http(rpcUrl)
    });
    const testClient = createTestClient({
      mode: "anvil",
      transport: http(rpcUrl)
    });
    const walletClient = createWalletClient({
      chain: forkChain,
      transport: http(rpcUrl)
    });

    return {
      rpcUrl,
      publicClient,
      testClient,
      walletClient,
      stop: async () => {
        await stopChildProcess(anvil);
      }
    };
  } catch (error) {
    await stopChildProcess(anvil);

    if (stderrBuffer.trim().length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${redactRpcUrl(stderrBuffer.trim(), options.rpcUrl)}`
      );
    }

    throw error;
  }
}

function redactRpcUrl(message: string, rpcUrl: string): string {
  const redacted = "<rpc-url-redacted>";
  let sanitized = rpcUrl.length > 0 ? message.split(rpcUrl).join(redacted) : message;
  sanitized = sanitized.replace(/https?:\/\/\S+/g, redacted);
  return sanitized;
}

export async function withTemporaryAnvilFork<T>(
  options: TemporaryAnvilForkOptions,
  work: (context: TemporaryAnvilForkContext) => Promise<T>
): Promise<T> {
  return withLazyTemporaryAnvilFork(options, async (getContext) => {
    return work(await getContext());
  });
}

export async function withLazyTemporaryAnvilFork<T>(
  options: TemporaryAnvilForkOptions,
  work: (getContext: () => Promise<TemporaryAnvilForkContext>) => Promise<T>
): Promise<T> {
  let handlePromise: Promise<TemporaryAnvilForkHandle> | undefined;

  async function getHandle() {
    if (!handlePromise) {
      handlePromise = startTemporaryAnvilFork(options);
    }

    return handlePromise;
  }

  try {
    return await work(async () => {
      const handle = await getHandle();
      return {
        rpcUrl: handle.rpcUrl,
        publicClient: handle.publicClient,
        testClient: handle.testClient,
        walletClient: handle.walletClient
      };
    });
  } finally {
    if (handlePromise) {
      const handle = await handlePromise.catch(() => undefined);
      if (handle) {
        await handle.stop();
      }
    }
  }
}

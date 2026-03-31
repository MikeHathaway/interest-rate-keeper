#!/usr/bin/env node

import "dotenv/config";

import net from "node:net";
import { spawn } from "node:child_process";

const profile = process.argv[2] ?? "stress";
const forwardedVitestArgs = process.argv.slice(3);
const supportedProfiles = new Set(["smoke", "default", "slow", "stress", "experimental", "all"]);
const explicitLocalAnvilUrl = process.env.BASE_LOCAL_ANVIL_URL?.trim();
const DEFAULT_PORT_BY_PROFILE = {
  smoke: 9545,
  default: 9546,
  slow: 9547,
  stress: 9548,
  experimental: 9549,
  all: 9550
};

if (!supportedProfiles.has(profile)) {
  console.error(
    `[base-fork-runner] unsupported profile "${profile}". Expected one of: ${Array.from(
      supportedProfiles
    ).join(", ")}`
  );
  process.exit(1);
}

const localAnvilUrl = (
  explicitLocalAnvilUrl || `http://127.0.0.1:${DEFAULT_PORT_BY_PROFILE[profile]}`
).trim();
let parsedLocalUrl;

try {
  parsedLocalUrl = new URL(localAnvilUrl);
} catch {
  console.error(`[base-fork-runner] invalid BASE_LOCAL_ANVIL_URL: ${localAnvilUrl}`);
  process.exit(1);
}

const localHost = parsedLocalUrl.hostname;
const localPort =
  parsedLocalUrl.port.length > 0
    ? Number(parsedLocalUrl.port)
    : parsedLocalUrl.protocol === "https:"
      ? 443
      : 80;

if (!Number.isFinite(localPort) || localPort <= 0) {
  console.error(`[base-fork-runner] invalid local Anvil port in ${localAnvilUrl}`);
  process.exit(1);
}

async function waitForPort(host, port, timeoutMs = 60_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
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

async function isListening(host, port) {
  try {
    await waitForPort(host, port, 750);
    return true;
  } catch {
    return false;
  }
}

async function findAvailablePort(host, startPort, maxAttempts = 20) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidatePort = startPort + offset;
    if (!(await isListening(host, candidatePort))) {
      return candidatePort;
    }
  }

  throw new Error(
    `[base-fork-runner] failed to find a free local port starting at ${startPort} after ${maxAttempts} attempts`
  );
}

async function assertBaseChainId(rpcUrl) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: []
    })
  });

  if (!response.ok) {
    throw new Error(
      `[base-fork-runner] failed to query eth_chainId from ${rpcUrl}: ${response.status} ${response.statusText}`
    );
  }

  const payload = await response.json();
  if (payload?.result !== "0x2105") {
    throw new Error(
      `[base-fork-runner] expected Base chain id 8453 (0x2105) from ${rpcUrl}, got ${payload?.result ?? "unknown"}`
    );
  }
}

let managedAnvil;
let managedAnvilStderr = "";

async function stopManagedAnvil() {
  if (!managedAnvil || managedAnvil.exitCode !== null || managedAnvil.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      managedAnvil.kill("SIGKILL");
    }, 2_000);

    managedAnvil.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    managedAnvil.kill("SIGTERM");
  });
}

process.on("SIGINT", async () => {
  await stopManagedAnvil();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await stopManagedAnvil();
  process.exit(143);
});

let effectiveLocalAnvilUrl = localAnvilUrl;
let effectiveLocalHost = localHost;
let effectiveLocalPort = localPort;

if (explicitLocalAnvilUrl) {
  console.log(`[base-fork-runner] reusing external local Anvil at ${effectiveLocalAnvilUrl}`);
  try {
    await waitForPort(effectiveLocalHost, effectiveLocalPort, 60_000);
    await assertBaseChainId(effectiveLocalAnvilUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
} else {
  try {
    effectiveLocalPort = await findAvailablePort(localHost, localPort);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
  effectiveLocalAnvilUrl = `http://${localHost}:${effectiveLocalPort}`;

  const forkUrl = process.env.BASE_RPC_URL?.trim();
  if (!forkUrl) {
    console.error(
      "[base-fork-runner] BASE_RPC_URL is required when no explicit BASE_LOCAL_ANVIL_URL is provided"
    );
    process.exit(1);
  }

  console.log(
    `[base-fork-runner] starting managed local Anvil at ${effectiveLocalAnvilUrl} from ${new URL(forkUrl).host}`
  );
  managedAnvil = spawn(
    "anvil",
    [
      "--fork-url",
      forkUrl,
      "--port",
      String(effectiveLocalPort),
      "--chain-id",
      "8453",
      "--silent"
    ],
    {
      stdio: ["ignore", "inherit", "pipe"]
    }
  );

  managedAnvil.stderr?.setEncoding("utf8");
  managedAnvil.stderr?.on("data", (chunk) => {
    managedAnvilStderr = `${managedAnvilStderr}${chunk}`.slice(-8_000);
  });

  try {
    await waitForPort(effectiveLocalHost, effectiveLocalPort, 60_000);
    await assertBaseChainId(effectiveLocalAnvilUrl);
  } catch (error) {
    await stopManagedAnvil();
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      managedAnvilStderr.trim().length > 0
        ? `${message}\n${managedAnvilStderr.trim()}`
        : message
    );
    process.exit(1);
  }
}

const profileEnv = {
  RUN_BASE_FORK_TESTS: "1",
  RUN_BASE_FORK_SMOKE_TESTS: profile === "smoke" ? "1" : undefined,
  RUN_BASE_FORK_SLOW_TESTS: profile === "slow" ? "1" : undefined,
  RUN_BASE_FORK_ALL_TESTS: profile === "all" ? "1" : undefined,
  RUN_BASE_FORK_STRESS_TESTS: profile === "stress" ? "1" : undefined,
  RUN_BASE_FORK_EXPERIMENTAL_TESTS: profile === "experimental" ? "1" : undefined,
  BASE_LOCAL_ANVIL_URL: effectiveLocalAnvilUrl
};

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "vitest",
    "run",
    "--config",
    "vitest.integration.config.ts",
    "tests/integration/base-factory.integration.ts",
    ...forwardedVitestArgs
  ],
  {
    stdio: "inherit",
    env: Object.fromEntries(
      Object.entries({
        ...process.env,
        ...profileEnv
      }).filter(([, value]) => value !== undefined)
    )
  }
);

const exitCode = await new Promise((resolve) => {
  child.once("exit", (code, signal) => {
    if (signal) {
      resolve(1);
      return;
    }

    resolve(code ?? 0);
  });
});

await stopManagedAnvil();
process.exit(exitCode);

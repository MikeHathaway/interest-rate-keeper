#!/usr/bin/env node

import "dotenv/config";

import net from "node:net";
import { spawn } from "node:child_process";

const profile = process.argv[2] ?? "stress";
const forwardedVitestArgs = process.argv.slice(3);
const supportedProfiles = new Set(["stress", "experimental", "all"]);

if (!supportedProfiles.has(profile)) {
  console.error(
    `[base-fork-runner] unsupported profile "${profile}". Expected one of: ${Array.from(
      supportedProfiles
    ).join(", ")}`
  );
  process.exit(1);
}

const localAnvilUrl = (process.env.BASE_LOCAL_ANVIL_URL || "http://127.0.0.1:9545").trim();
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

const reusingExistingAnvil = await isListening(localHost, localPort);

if (reusingExistingAnvil) {
  console.log(`[base-fork-runner] reusing local Anvil at ${localAnvilUrl}`);
} else {
  const forkUrl = process.env.BASE_RPC_URL?.trim();
  if (!forkUrl) {
    console.error(
      "[base-fork-runner] BASE_RPC_URL is required when BASE_LOCAL_ANVIL_URL is not already serving a local Anvil fork"
    );
    process.exit(1);
  }

  console.log(
    `[base-fork-runner] starting managed local Anvil at ${localAnvilUrl} from ${new URL(forkUrl).host}`
  );
  managedAnvil = spawn(
    "anvil",
    [
      "--fork-url",
      forkUrl,
      "--port",
      String(localPort),
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
    await waitForPort(localHost, localPort, 60_000);
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
  RUN_BASE_FORK_ALL_TESTS: profile === "all" ? "1" : undefined,
  RUN_BASE_FORK_STRESS_TESTS: profile === "stress" ? "1" : undefined,
  RUN_BASE_FORK_EXPERIMENTAL_TESTS: profile === "experimental" ? "1" : undefined,
  BASE_LOCAL_ANVIL_URL: localAnvilUrl
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

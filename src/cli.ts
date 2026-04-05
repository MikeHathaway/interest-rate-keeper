#!/usr/bin/env node

import "dotenv/config";

import { readFile } from "node:fs/promises";

import { parseCliArgs, resolveKeeperConfig } from "./config.js";
import { DryRunExecutionBackend, type ExecutionBackend } from "./execute.js";
import { formatCycleCapitalSummary } from "./human-summary.js";
import {
  formatKeeperHubResponse,
  resolveKeeperHubPayload,
  runKeeperHubPayload
} from "./keeperhub.js";
import { runCycle } from "./run-cycle.js";
import { FileSnapshotSource } from "./snapshot.js";
import { createAjnaExecutionBackend } from "./ajna/executor.js";
import { AjnaRpcSnapshotSource } from "./ajna/snapshot.js";
import { safeJsonStringify } from "./json.js";
import { type KeeperConfig } from "./types.js";

function resolveBackend(config: KeeperConfig, dryRun: boolean): ExecutionBackend {
  return dryRun ? new DryRunExecutionBackend() : createAjnaExecutionBackend(config);
}

function resolveRuntimeConfig(config: KeeperConfig, dryRun: boolean): KeeperConfig {
  if (!dryRun || config.allowHeuristicExecution) {
    return config;
  }

  return {
    ...config,
    allowHeuristicExecution: true
  };
}

async function main(): Promise<void> {
  try {
    const command = parseCliArgs(process.argv.slice(2));

    if (command.mode === "run") {
      const loadedConfig = resolveKeeperConfig(
        JSON.parse(await readFile(command.configPath!, "utf8"))
      );
      const config = resolveRuntimeConfig(loadedConfig, command.dryRun);
      const backend = resolveBackend(config, command.dryRun);
      const snapshotSource = command.snapshotPath
        ? new FileSnapshotSource(command.snapshotPath)
        : new AjnaRpcSnapshotSource(config);
      const result = await runCycle(config, {
        snapshotSource,
        executor: backend
      });
      if (command.summary) {
        process.stderr.write(`${formatCycleCapitalSummary(result)}\n`);
      }
      process.stdout.write(`${safeJsonStringify(result, true)}\n`);
      process.exitCode = result.status === "EXECUTED" || result.status === "NO_OP" ? 0 : 1;
      return;
    }

    const payload = JSON.parse(await readFile(command.payloadPath!, "utf8"));
    const resolvedPayload = resolveKeeperHubPayload(payload);
    const config = resolveRuntimeConfig(resolvedPayload.config, command.dryRun);
    const backend = resolveBackend(config, command.dryRun);
    const result = await runKeeperHubPayload(payload, {
      executor: backend
    }, {
      config
    });
    if (command.summary) {
      process.stderr.write(`${formatCycleCapitalSummary(result)}\n`);
    }
    process.stdout.write(`${formatKeeperHubResponse(result)}\n`);
    process.exitCode = result.status === "EXECUTED" || result.status === "NO_OP" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

void main();

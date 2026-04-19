import { type PublicClient } from "viem";

import { type AjnaRatePrediction } from "../../math/rate-state.js";
import {
  type AjnaPoolStateRead,
  type SimulationAccountState,
  buildSnapshotFingerprint,
  resolveSimulationBorrowerAddress,
  resolveSimulationSenderAddress
} from "../../domain.js";
import { readSimulationAccountState } from "../../read/pool-state.js";
import { buildTargetBand, distanceToTargetBand } from "../../../core/planning/planner.js";
import {
  type HexAddress,
  type KeeperConfig,
  type TargetBand
} from "../../../core/types.js";

export interface SimulationPreambleOptions {
  poolAddress: HexAddress;
  accountState?: SimulationAccountState;
  baselinePrediction?: AjnaRatePrediction;
}

export interface SimulationPreamble {
  targetBand: TargetBand;
  baselinePrediction: AjnaRatePrediction;
  simulationSenderAddress: HexAddress;
  borrowerAddress: HexAddress;
  snapshotFingerprint: string;
  baselineInBand: boolean;
}

/**
 * Shared preamble for the three `synthesize*ViaSimulation` entrypoints:
 * resolves target band, baseline prediction, simulation sender/borrower
 * addresses, and snapshot fingerprint. Also reports whether the baseline
 * prediction already lands in-band, so callers can short-circuit.
 */
export function buildSimulationPreamble(
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: SimulationPreambleOptions
): SimulationPreamble {
  const targetBand = buildTargetBand(config);
  const baselinePrediction = options.baselinePrediction ?? readState.prediction;
  const simulationSenderAddress =
    options.accountState?.simulationSenderAddress ??
    resolveSimulationSenderAddress(config);
  const borrowerAddress =
    options.accountState?.borrowerAddress ??
    resolveSimulationBorrowerAddress(config, simulationSenderAddress);

  return {
    targetBand,
    baselinePrediction,
    simulationSenderAddress,
    borrowerAddress,
    snapshotFingerprint: buildSnapshotFingerprint(
      options.poolAddress,
      readState.blockNumber,
      readState.rateState
    ),
    baselineInBand:
      distanceToTargetBand(baselinePrediction.predictedNextRateBps, targetBand) === 0
  };
}

/**
 * Resolve the simulation account state, preferring the caller-supplied
 * `options.accountState` when present. Otherwise issues a live RPC read
 * parameterised by `needsQuoteState` / `needsCollateralState`.
 */
export async function resolveEffectiveAccountState(
  publicClient: PublicClient,
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    poolAddress: HexAddress;
    accountState?: SimulationAccountState;
    needsQuoteState: boolean;
    needsCollateralState: boolean;
    lenderQuoteBucketIndexes?: number[];
  }
): Promise<SimulationAccountState> {
  if (options.accountState) {
    return options.accountState;
  }

  return readSimulationAccountState(
    publicClient,
    options.poolAddress,
    readState,
    config,
    {
      needsQuoteState: options.needsQuoteState,
      needsCollateralState: options.needsCollateralState,
      ...(options.lenderQuoteBucketIndexes === undefined
        ? {}
        : { lenderQuoteBucketIndexes: options.lenderQuoteBucketIndexes })
    }
  );
}

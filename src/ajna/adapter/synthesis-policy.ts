import { resolveAjnaSignerAddress } from "./runtime.js";
import { clearAllRegisteredAjnaCaches } from "../read/cache.js";
import { type HexAddress, type KeeperConfig } from "../../core/types.js";

export {
  type AjnaRatePrediction,
  type AjnaRateState,
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate,
  hasUninitializedAjnaEmaState
} from "../math/rate-state.js";
export {
  synthesizeAjnaHeuristicCandidates,
  synthesizeAjnaLendAndBorrowCandidate
} from "../synthesize/dual/heuristic.js";
export { synthesizeAjnaBorrowCandidate } from "../synthesize/borrow/heuristic.js";
export { synthesizeAjnaLendCandidate } from "../synthesize/lend/heuristic.js";
export {
  resolveSimulationBorrowCollateralAmounts,
  resolveSimulationBorrowLimitIndexes,
  resolveBorrowSimulationLookaheadAttempts,
  resolveRemoveQuoteBucketIndexes,
  resolveManagedInventoryBucketIndexes,
  resolveProtocolApproximationBucketIndexes,
  resolveTimedBorrowSimulationLookaheadAttempts,
  resolveProtocolShapedPreWindowDualBucketIndexes,
  searchCoarseToFineDualSpace
} from "../search/index.js";
export { rankProtocolShapedDualBranches } from "../search/dual-prefilter.js";
export {
  AjnaRpcSnapshotSource,
  type AjnaSnapshotSourceDependencies
} from "./snapshot-source.js";

export interface AjnaSynthesisPolicy {
  simulationLend: boolean;
  simulationBorrow: boolean;
  heuristicLend: boolean;
  heuristicBorrow: boolean;
}

interface SimulationExecutionCompatibility {
  simulationSenderAddress?: HexAddress;
  liveSignerAddress?: HexAddress;
  executionCompatible?: boolean;
  reason?: string;
}

export function clearAjnaSnapshotCaches(): void {
  clearAllRegisteredAjnaCaches();
}

function hasExplicitSynthesisFlags(config: KeeperConfig): boolean {
  return (
    config.enableSimulationBackedLendSynthesis !== undefined ||
    config.enableSimulationBackedBorrowSynthesis !== undefined ||
    config.enableHeuristicLendSynthesis !== undefined ||
    config.enableHeuristicBorrowSynthesis !== undefined
  );
}

export function hasResolvableSimulationSenderAddress(
  config: KeeperConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (config.simulationSenderAddress) {
    return true;
  }

  return resolveAjnaSignerAddress(env) !== undefined;
}

export function resolveAjnaSynthesisPolicy(
  config: KeeperConfig,
  env: NodeJS.ProcessEnv = process.env
): AjnaSynthesisPolicy {
  if (hasExplicitSynthesisFlags(config)) {
    return {
      simulationLend: config.enableSimulationBackedLendSynthesis === true,
      simulationBorrow: config.enableSimulationBackedBorrowSynthesis === true,
      heuristicLend: config.enableHeuristicLendSynthesis === true,
      heuristicBorrow: config.enableHeuristicBorrowSynthesis === true
    };
  }

  const canSimulate = hasResolvableSimulationSenderAddress(config, env);

  return {
    simulationLend: canSimulate,
    simulationBorrow: canSimulate,
    heuristicLend: true,
    heuristicBorrow: true
  };
}

export function resolveSimulationExecutionCompatibility(
  config: KeeperConfig,
  env: NodeJS.ProcessEnv = process.env
): SimulationExecutionCompatibility {
  const simulationSenderAddress =
    config.simulationSenderAddress ?? resolveAjnaSignerAddress(env);
  const liveSignerAddress = resolveAjnaSignerAddress(env);

  if (!simulationSenderAddress || !liveSignerAddress) {
    return {
      ...(simulationSenderAddress === undefined ? {} : { simulationSenderAddress }),
      ...(liveSignerAddress === undefined ? {} : { liveSignerAddress })
    };
  }

  if (simulationSenderAddress.toLowerCase() !== liveSignerAddress.toLowerCase()) {
    return {
      simulationSenderAddress,
      liveSignerAddress,
      executionCompatible: false,
      reason:
        "simulation-backed synthesis used a different sender than the live execution signer"
    };
  }

  return {
    simulationSenderAddress,
    liveSignerAddress,
    executionCompatible: true
  };
}

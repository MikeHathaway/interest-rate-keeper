import {
  withLazyTemporaryAnvilFork,
  withTemporaryAnvilFork,
  type TemporaryAnvilForkContext,
  type TemporaryAnvilForkOptions
} from "./anvil-fork.js";
import { ajnaPoolAbi } from "./abi.js";
import {
  type AjnaPoolStateRead,
  type LendSimulationPathResult,
  deriveRateMoveOutcome
} from "./snapshot-internal.js";
import { toRateBps } from "./rate-state.js";
import { type HexAddress, type RateMoveOutcome } from "../types.js";

export async function withPreparedLazySimulationFork<T>(
  options: TemporaryAnvilForkOptions,
  simulationSenderAddress: HexAddress,
  work: (
    getPreparedContext: () => Promise<TemporaryAnvilForkContext>
  ) => Promise<T>
): Promise<T> {
  return withLazyTemporaryAnvilFork(options, async (getContext) => {
    let prepared = false;

    async function getPreparedContext(): Promise<TemporaryAnvilForkContext> {
      const context = await getContext();
      if (!prepared) {
        await context.testClient.impersonateAccount({
          address: simulationSenderAddress
        });
        await context.testClient.setBalance({
          address: simulationSenderAddress,
          value: 10n ** 24n
        });
        prepared = true;
      }

      return context;
    }

    try {
      return await work(getPreparedContext);
    } finally {
      if (prepared) {
        const context = await getContext();
        await context.testClient.stopImpersonatingAccount({
          address: simulationSenderAddress
        });
      }
    }
  });
}

export async function withPreparedSimulationFork<T>(
  options: TemporaryAnvilForkOptions,
  simulationSenderAddress: HexAddress,
  work: (context: TemporaryAnvilForkContext) => Promise<T>
): Promise<T> {
  return withTemporaryAnvilFork(options, async (context) => {
    await context.testClient.impersonateAccount({
      address: simulationSenderAddress
    });
    await context.testClient.setBalance({
      address: simulationSenderAddress,
      value: 10n ** 24n
    });

    try {
      return await work(context);
    } finally {
      await context.testClient.stopImpersonatingAccount({
        address: simulationSenderAddress
      });
    }
  });
}

export interface AjnaSimulationReplayActionContext extends TemporaryAnvilForkContext {
  readPoolState: () => Promise<AjnaPoolStateRead>;
  observeState: (stateAfterAction: AjnaPoolStateRead) => void;
}

export async function replayAjnaSimulationPath(
  context: TemporaryAnvilForkContext,
  options: {
    poolAddress: HexAddress;
    simulationSenderAddress: HexAddress;
    initialReadState: AjnaPoolStateRead;
    lookaheadUpdates: number;
    terminalDistanceFromRateBps: (rateBps: number) => number;
    readPoolState: () => Promise<AjnaPoolStateRead>;
    applyActions?: (context: AjnaSimulationReplayActionContext) => Promise<void>;
  }
): Promise<LendSimulationPathResult> {
  const { publicClient, testClient, walletClient } = context;
  const snapshotId = await testClient.snapshot();

  try {
    const initialLastInterestRateUpdateTimestamp =
      options.initialReadState.rateState.lastInterestRateUpdateTimestamp;
    let firstRateWadAfterNextUpdate = options.initialReadState.rateState.currentRateWad;
    let firstOutcome: RateMoveOutcome = "NO_CHANGE";
    let terminalRateWad = options.initialReadState.rateState.currentRateWad;
    let completedLookaheadUpdates = 0;
    let simulatedReadState = options.initialReadState;

    const observeState = (stateAfterAction: AjnaPoolStateRead): void => {
      simulatedReadState = stateAfterAction;
      terminalRateWad = stateAfterAction.rateState.currentRateWad;
      if (
        completedLookaheadUpdates > 0 ||
        stateAfterAction.rateState.lastInterestRateUpdateTimestamp ===
          initialLastInterestRateUpdateTimestamp
      ) {
        return;
      }

      completedLookaheadUpdates = 1;
      firstRateWadAfterNextUpdate = stateAfterAction.rateState.currentRateWad;
      firstOutcome = deriveRateMoveOutcome(
        options.initialReadState.rateState.currentRateWad,
        firstRateWadAfterNextUpdate
      );
    };

    const readPoolState = async (): Promise<AjnaPoolStateRead> => {
      const state = await options.readPoolState();
      simulatedReadState = state;
      terminalRateWad = state.rateState.currentRateWad;
      return state;
    };

    if (options.applyActions) {
      await options.applyActions({
        publicClient,
        testClient,
        walletClient,
        readPoolState,
        observeState
      });
    }

    for (; completedLookaheadUpdates < options.lookaheadUpdates; completedLookaheadUpdates += 1) {
      if (simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate > 0) {
        await testClient.increaseTime({
          seconds: simulatedReadState.immediatePrediction.secondsUntilNextRateUpdate
        });
        await testClient.mine({
          blocks: 1
        });
        simulatedReadState = await readPoolState();
      }

      const updateHash = await walletClient.writeContract({
        account: options.simulationSenderAddress,
        chain: undefined,
        address: options.poolAddress,
        abi: ajnaPoolAbi,
        functionName: "updateInterest",
        args: []
      });
      const updateReceipt = await publicClient.waitForTransactionReceipt({
        hash: updateHash
      });
      if (updateReceipt.status !== "success") {
        throw new Error("updateInterest simulation reverted");
      }

      const postUpdateReadState = await readPoolState();
      terminalRateWad = postUpdateReadState.rateState.currentRateWad;

      if (completedLookaheadUpdates === 0) {
        firstRateWadAfterNextUpdate = terminalRateWad;
        firstOutcome = deriveRateMoveOutcome(
          options.initialReadState.rateState.currentRateWad,
          terminalRateWad
        );
      }
    }

    const firstRateBpsAfterNextUpdate = toRateBps(firstRateWadAfterNextUpdate);
    const terminalRateBps = toRateBps(terminalRateWad);

    return {
      firstRateWadAfterNextUpdate,
      firstRateBpsAfterNextUpdate,
      firstOutcome,
      terminalRateBps,
      terminalDistanceToTargetBps: options.terminalDistanceFromRateBps(terminalRateBps)
    };
  } finally {
    await testClient.revert({ id: snapshotId });
  }
}

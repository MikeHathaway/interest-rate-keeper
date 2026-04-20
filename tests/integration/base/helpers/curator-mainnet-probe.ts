// One-off probe for Ajna mainnet archetypes. Given a pool + actor + block,
// fork Ethereum mainnet, run the keeper's snapshot source with dual mode
// enabled, and capture the dual-synthesis debug trace. Answers "does the
// dual code path produce a working candidate on mainnet" without requiring
// full multi-chain test-harness integration.

import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  resolveKeeperConfig
} from "../../../../src/index.js";
import { readPoolSnapshotMetadata } from "../../../../src/core/snapshot/metadata.js";
import {
  setDualSynthesisDebugTrace,
  type DualSynthesisEvaluationEvent
} from "../../../../src/ajna/synthesize/dual/exact.js";
import { withTemporaryAnvilFork } from "../../../../src/ajna/dev/anvil-fork.js";
import { DEFAULT_ANVIL_PRIVATE_KEY } from "./shared.js";

export interface MainnetArchetypeProbeInput {
  id: string;
  poolAddress: `0x${string}`;
  senderAddress: `0x${string}`;
  borrowerAddress: `0x${string}`;
  blockNumber: bigint;
  lenderBucketIndex: number;
  targetOffsetBps: number;
  toleranceBps: number;
  drawDebtLimitIndexes?: number[];
}

export interface MainnetArchetypeProbeResult {
  id: string;
  poolAddress: `0x${string}`;
  blockNumber: bigint;
  currentRateBps: number;
  targetRateBps: number;
  predictedNextRateBps: number;
  predictedNextOutcome: string;
  secondsUntilNextRateUpdate: number;
  lenderLpBalance: bigint;
  bucketDepositWad: bigint;
  bucketOwnershipFraction: number;
  managedInventoryUpwardEligible: boolean | undefined;
  managedInventoryIneligibilityReason: string | undefined;
  noOfLoans: number;
  singleActionSurfaced: boolean;
  singleActionTerminalDistance?: number;
  dualCandidateSurfaced: boolean;
  dualCandidate:
    | {
        predictedRateBpsAfterNextUpdate: number;
        planningRateBps?: number | undefined;
        planningLookaheadUpdates?: number | undefined;
        removeQuoteAmountWad: bigint;
        drawDebtAmountWad: bigint;
        limitIndex: number;
      }
    | undefined;
  dualEvaluations: {
    total: number;
    improving: number;
    failed: number;
    combinations: Array<{
      key: string;
      total: number;
      improving: number;
      failed: number;
      bestTerminalDistance: number | null;
      bestTerminalRateBps: number | null;
      comparisonTerminalDistance: number | null;
    }>;
  };
}

export async function probeMainnetArchetype(
  input: MainnetArchetypeProbeInput
): Promise<MainnetArchetypeProbeResult> {
  const mainnetRpcUrl = (() => {
    const explicit = process.env.ETHEREUM_RPC_URL?.trim();
    if (explicit) {
      return explicit;
    }
    // Derive from BASE_RPC_URL if it's an Alchemy URL — same API key usually
    // works across chains, just different subdomain.
    const baseRpc = process.env.BASE_RPC_URL?.trim();
    if (baseRpc && baseRpc.includes("alchemy.com")) {
      return baseRpc.replace("base-mainnet", "eth-mainnet");
    }
    return "https://eth.llamarpc.com";
  })();
  process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

  return withTemporaryAnvilFork(
    {
      rpcUrl: mainnetRpcUrl,
      chainId: 1,
      blockNumber: input.blockNumber
    },
    async ({ publicClient, rpcUrl, testClient }) => {
      const chainNow = Number((await publicClient.getBlock()).timestamp);

      const [currentRateInfo, lenderInfo, bucketInfo] = await Promise.all([
        publicClient.readContract({
          address: input.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "interestRateInfo"
        }),
        publicClient.readContract({
          address: input.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "lenderInfo",
          args: [BigInt(input.lenderBucketIndex), input.senderAddress]
        }),
        publicClient.readContract({
          address: input.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "bucketInfo",
          args: [BigInt(input.lenderBucketIndex)]
        })
      ]);
      const [currentRateWad] = currentRateInfo as readonly [bigint, bigint];
      const [lenderLpBalance] = lenderInfo as readonly [bigint, bigint];
      const [, , , bucketDepositWad] = bucketInfo as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint
      ];
      const currentRateBps = Number(
        (currentRateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n
      );
      const targetRateBps = currentRateBps + input.targetOffsetBps;
      const bucketOwnershipFraction =
        bucketDepositWad === 0n
          ? 0
          : Number((lenderLpBalance * 10_000n) / bucketDepositWad) / 10_000;

      await testClient.impersonateAccount({ address: input.senderAddress });
      await testClient.setBalance({
        address: input.senderAddress,
        value: 10n ** 22n
      });

      const config = resolveKeeperConfig({
        chainId: 1,
        poolAddress: input.poolAddress,
        poolId: `1:${input.poolAddress.toLowerCase()}`,
        rpcUrl,
        simulationSenderAddress: input.senderAddress,
        borrowerAddress: input.borrowerAddress,
        targetRateBps,
        toleranceBps: input.toleranceBps,
        toleranceMode: "absolute",
        completionPolicy: "next_move_would_overshoot",
        executionBufferBps: 0,
        removeQuoteBucketIndex: input.lenderBucketIndex,
        ...(input.drawDebtLimitIndexes === undefined
          ? {}
          : { drawDebtLimitIndexes: [...input.drawDebtLimitIndexes] }),
        borrowSimulationLookaheadUpdates: 2,
        maxQuoteTokenExposure: "1000000000000000000000000",
        maxBorrowExposure: "1000000000000000000000",
        snapshotAgeMaxSeconds: 3600,
        minTimeBeforeRateWindowSeconds: 120,
        minExecutableActionQuoteToken: "1",
        recheckBeforeSubmit: true,
        enableSimulationBackedLendSynthesis: true,
        enableSimulationBackedBorrowSynthesis: true,
        enableManagedInventoryUpwardControl: true,
        enableManagedDualUpwardControl: true,
        enableHeuristicLendSynthesis: false,
        enableHeuristicBorrowSynthesis: false
      });

      const dualEvents: DualSynthesisEvaluationEvent[] = [];
      setDualSynthesisDebugTrace((event) => {
        dualEvents.push(event);
      });

      let snapshot;
      try {
        snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
      } finally {
        setDualSynthesisDebugTrace(undefined);
        await testClient.stopImpersonatingAccount({
          address: input.senderAddress
        });
      }

      const metadata = readPoolSnapshotMetadata(snapshot);
      const noOfLoans = Number(metadata.noOfLoans ?? "0");

      const singleActionCandidate = snapshot.candidates.find(
        (c) =>
          c.candidateSource === "simulation" &&
          c.intent === "LEND" &&
          c.minimumExecutionSteps.some((s) => s.type === "REMOVE_QUOTE")
      );
      const dualCandidate = snapshot.candidates.find(
        (c) =>
          c.candidateSource === "simulation" &&
          c.intent === "LEND_AND_BORROW" &&
          c.minimumExecutionSteps.some((s) => s.type === "REMOVE_QUOTE") &&
          c.minimumExecutionSteps.some((s) => s.type === "DRAW_DEBT")
      );
      const dualCandidateSummary = (() => {
        if (dualCandidate === undefined) {
          return undefined;
        }
        const removeStep = dualCandidate.minimumExecutionSteps.find(
          (s): s is Extract<typeof s, { type: "REMOVE_QUOTE" }> =>
            s.type === "REMOVE_QUOTE"
        );
        const drawStep = dualCandidate.minimumExecutionSteps.find(
          (s): s is Extract<typeof s, { type: "DRAW_DEBT" }> =>
            s.type === "DRAW_DEBT"
        );
        if (removeStep === undefined || drawStep === undefined) {
          return undefined;
        }
        return {
          predictedRateBpsAfterNextUpdate:
            dualCandidate.predictedRateBpsAfterNextUpdate,
          ...(dualCandidate.planningRateBps === undefined
            ? {}
            : { planningRateBps: dualCandidate.planningRateBps }),
          ...(dualCandidate.planningLookaheadUpdates === undefined
            ? {}
            : {
                planningLookaheadUpdates:
                  dualCandidate.planningLookaheadUpdates
              }),
          removeQuoteAmountWad: removeStep.amount,
          drawDebtAmountWad: drawStep.amount,
          limitIndex: drawStep.limitIndex
        };
      })();

      const removeDrawEvents = dualEvents.filter(
        (e) => e.path === "remove_quote_plus_draw_debt"
      );
      const combinationMap = new Map<string, DualSynthesisEvaluationEvent[]>();
      for (const event of removeDrawEvents) {
        const key = `bucket=${event.bucketIndex}/limit=${event.limitIndex}/collateral=${event.collateralAmount.toString()}`;
        const bucket = combinationMap.get(key) ?? [];
        bucket.push(event);
        combinationMap.set(key, bucket);
      }
      const combinations = Array.from(combinationMap.entries()).map(
        ([key, events]) => {
          const evaluated = events.filter((e) => !e.evaluationFailed);
          const best = evaluated.reduce(
            (acc, e) =>
              e.candidateTerminalDistance < acc.candidateTerminalDistance
                ? e
                : acc,
            { candidateTerminalDistance: Number.POSITIVE_INFINITY } as DualSynthesisEvaluationEvent
          );
          return {
            key,
            total: events.length,
            improving: events.filter((e) => e.improvesConvergence).length,
            failed: events.filter((e) => e.evaluationFailed).length,
            bestTerminalDistance:
              best.candidateTerminalDistance === Number.POSITIVE_INFINITY
                ? null
                : best.candidateTerminalDistance,
            bestTerminalRateBps: best.candidateTerminalRateBps ?? null,
            comparisonTerminalDistance:
              events[0]?.comparisonTerminalDistance ?? null
          };
        }
      );

      return {
        id: input.id,
        poolAddress: input.poolAddress,
        blockNumber: input.blockNumber,
        currentRateBps,
        targetRateBps,
        predictedNextRateBps: snapshot.predictedNextRateBps,
        predictedNextOutcome: snapshot.predictedNextOutcome,
        secondsUntilNextRateUpdate: snapshot.secondsUntilNextRateUpdate,
        lenderLpBalance,
        bucketDepositWad,
        bucketOwnershipFraction,
        managedInventoryUpwardEligible: metadata.managedInventoryUpwardEligible,
        managedInventoryIneligibilityReason:
          metadata.managedInventoryIneligibilityReason,
        noOfLoans,
        singleActionSurfaced: singleActionCandidate !== undefined,
        ...(singleActionCandidate === undefined
          ? {}
          : {
              singleActionTerminalDistance:
                singleActionCandidate.resultingDistanceToTargetBps
            }),
        dualCandidateSurfaced: dualCandidate !== undefined,
        dualCandidate: dualCandidateSummary,
        dualEvaluations: {
          total: removeDrawEvents.length,
          improving: removeDrawEvents.filter((e) => e.improvesConvergence)
            .length,
          failed: removeDrawEvents.filter((e) => e.evaluationFailed).length,
          combinations
        }
      };
    }
  );
}

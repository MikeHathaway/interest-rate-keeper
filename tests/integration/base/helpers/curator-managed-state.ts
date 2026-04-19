import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  resolveKeeperConfig,
  type PlanCandidate,
  type RateMoveOutcome
} from "../../../../src/index.js";
import { readPoolSnapshotMetadata } from "../../../../src/core/snapshot/metadata.js";
import { withTemporaryAnvilFork } from "../../../../src/ajna/dev/anvil-fork.js";
import {
  buildMultiCycleBorrowSearchAmounts,
  resolvePoolAwareBorrowLimitIndexes
} from "../../../../src/ajna/search/index.js";
import { withPreparedSimulationFork } from "../../../../src/ajna/synthesize/sim/helpers.js";
import { calculateMaxWithdrawableQuoteAmountFromLp } from "../../../../src/ajna/read/pool-state.js";
import { fenwickIndexToPriceWad } from "./protocol.js";
import { EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES } from "./fixtures.js";
import {
  capturePassiveRateBranch,
  DEFAULT_ANVIL_PRIVATE_KEY,
  distanceToTargetRateBps,
  executeRateProbeBranch,
  formatTokenAmount,
  LOCAL_RPC_URL
} from "./shared.js";
import type { CuratorHelperDeps } from "./curator-types.js";

const MANUAL_REMOVE_QUOTE_SAMPLE_FRACTIONS = [
  [1n, 20n],
  [1n, 10n],
  [1n, 5n],
  [1n, 3n],
  [1n, 2n],
  [2n, 3n],
  [3n, 4n],
  [9n, 10n],
  [1n, 1n]
] as const;
const MANUAL_DUAL_AJNA_INFO_ARCHETYPE_IDS = new Set([
  "ajna-info-managed-2388-2024-04-08",
  "ajna-info-managed-prime-usdc-2025-10-17",
  "ajna-info-managed-weth-usdglo-2024-10-03",
  "ajna-info-managed-dog-usdc-2026-03-18"
]);

function deriveManualRemoveQuoteAmounts(maxWithdrawableQuoteAmount: bigint): bigint[] {
  if (maxWithdrawableQuoteAmount <= 0n) {
    return [];
  }

  const uniqueAmounts = new Set<string>();
  const amounts: bigint[] = [];

  for (const [numerator, denominator] of MANUAL_REMOVE_QUOTE_SAMPLE_FRACTIONS) {
    const amount = (maxWithdrawableQuoteAmount * numerator) / denominator;
    if (amount <= 0n || amount > maxWithdrawableQuoteAmount) {
      continue;
    }

    const key = amount.toString();
    if (uniqueAmounts.has(key)) {
      continue;
    }

    uniqueAmounts.add(key);
    amounts.push(amount);
  }

  amounts.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return amounts;
}

function greatestBigInt(...values: bigint[]): bigint {
  if (values.length === 0) {
    throw new Error("greatestBigInt requires at least one value");
  }

  return values.reduce((greatest, value) => (value > greatest ? value : greatest));
}

function selectRepresentativeAmounts(amounts: bigint[], maxCount: number): bigint[] {
  if (amounts.length <= maxCount) {
    return amounts;
  }

  const selected = new Set<bigint>([amounts[0]!, amounts[amounts.length - 1]!]);
  if (maxCount >= 3) {
    selected.add(amounts[Math.floor((amounts.length - 1) / 2)]!);
  }

  return Array.from(selected)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, maxCount);
}

export function createBaseFactoryCuratorManagedStateHelpers(_deps: CuratorHelperDeps) {
  async function inspectAjnaInfoManagedUsedPoolArchetypes(): Promise<{
    observations: string[];
    inspectedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      senderAddress: `0x${string}`;
      currentRateBps: number;
      targetRateBps: number;
      borrowerDebtWad: bigint;
      borrowerCollateralWad: bigint;
      lenderLpBalance: bigint;
      bucketDepositWad: bigint;
      candidateIntent?: "LEND" | "BORROW" | "LEND_AND_BORROW";
      predictedRateBpsAfterNextUpdate?: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
      executionMode?: string;
      inventoryCandidateIntent?: "LEND" | "LEND_AND_BORROW";
      inventoryCandidateIncludesBorrow?: boolean;
    }>;
  }> {
    const upstreamRpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
    process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;
    const observations: string[] = [];
    const inspectedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      senderAddress: `0x${string}`;
      currentRateBps: number;
      targetRateBps: number;
      borrowerDebtWad: bigint;
      borrowerCollateralWad: bigint;
      lenderLpBalance: bigint;
      bucketDepositWad: bigint;
      candidateIntent?: "LEND" | "BORROW" | "LEND_AND_BORROW";
      predictedRateBpsAfterNextUpdate?: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
      executionMode?: string;
      inventoryCandidateIntent?: "LEND" | "LEND_AND_BORROW";
      inventoryCandidateIncludesBorrow?: boolean;
    }> = [];

    for (const archetype of EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES) {
      const lenderBucketIndex = BigInt(archetype.lenderBucketIndex);
      await withTemporaryAnvilFork(
        {
          rpcUrl: upstreamRpcUrl,
          chainId: 8453,
          blockNumber: archetype.blockNumber
        },
        async ({ publicClient, rpcUrl }) => {
          const chainNow = Number((await publicClient.getBlock()).timestamp);
          const [[currentRateWad], [borrowerDebtWad, borrowerCollateralWad], [lenderLpBalance], bucketInfo] =
            await Promise.all([
              publicClient.readContract({
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "interestRateInfo"
              }),
              publicClient.readContract({
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "borrowerInfo",
                args: [archetype.borrowerAddress]
              }),
              publicClient.readContract({
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "lenderInfo",
                args: [lenderBucketIndex, archetype.senderAddress]
              }),
              publicClient.readContract({
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "bucketInfo",
                args: [lenderBucketIndex]
              })
            ]);
          const bucketDepositWad = bucketInfo[3];
          const currentRateBps = Number((currentRateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n);
          const targetRateBps = currentRateBps + archetype.targetOffsetBps;

          const config = resolveKeeperConfig({
            chainId: 8453,
            poolAddress: archetype.poolAddress,
            poolId: `8453:${archetype.poolAddress.toLowerCase()}`,
            rpcUrl,
            borrowerAddress: archetype.borrowerAddress,
            simulationSenderAddress: archetype.senderAddress,
            targetRateBps,
            toleranceBps: archetype.toleranceBps,
            toleranceMode: "absolute",
            completionPolicy: "next_move_would_overshoot",
            executionBufferBps: 0,
            maxQuoteTokenExposure: "1000000000000000000000000",
            maxBorrowExposure: "1000000000000000000000",
            snapshotAgeMaxSeconds: 3600,
            minTimeBeforeRateWindowSeconds: 120,
            minExecutableActionQuoteToken: "1",
            recheckBeforeSubmit: true,
            enableSimulationBackedLendSynthesis: true,
            enableSimulationBackedBorrowSynthesis: true,
            enableHeuristicLendSynthesis: false,
            enableHeuristicBorrowSynthesis: false
          });
          const snapshot = await new AjnaRpcSnapshotSource(config, {
            publicClient,
            now: () => chainNow
          }).getSnapshot();
          const candidate = snapshot.candidates.find(
            (
              currentCandidate
            ): currentCandidate is PlanCandidate & {
              intent: "LEND" | "BORROW" | "LEND_AND_BORROW";
            } =>
              (currentCandidate.intent === "LEND" ||
                currentCandidate.intent === "BORROW" ||
                currentCandidate.intent === "LEND_AND_BORROW") &&
              currentCandidate.candidateSource === "simulation"
          );
          const inventoryCandidate = snapshot.candidates.find(
            (
              currentCandidate
            ): currentCandidate is PlanCandidate & {
              intent: "LEND" | "LEND_AND_BORROW";
            } =>
              (currentCandidate.intent === "LEND" ||
                currentCandidate.intent === "LEND_AND_BORROW") &&
              currentCandidate.candidateSource === "simulation" &&
              currentCandidate.minimumExecutionSteps.some((step) => step.type === "REMOVE_QUOTE")
          );

          observations.push(
            [
              `archetype=${archetype.id}`,
              `pool=${archetype.poolAddress}`,
              `block=${archetype.blockNumber.toString()}`,
              `sender=${archetype.senderAddress}`,
              `bucket=${archetype.lenderBucketIndex}`,
              `current=${snapshot.currentRateBps}`,
              `target=${targetRateBps}`,
              `secondsUntil=${snapshot.secondsUntilNextRateUpdate}`,
              `next=${snapshot.predictedNextOutcome}`,
              `borrowerDebt=${formatTokenAmount(borrowerDebtWad)}`,
              `borrowerCollateral=${formatTokenAmount(borrowerCollateralWad)}`,
              `lenderLp=${formatTokenAmount(lenderLpBalance)}`,
              `bucketDeposit=${formatTokenAmount(bucketDepositWad)}`,
              `candidate=${candidate ? `${candidate.intent}:${candidate.predictedRateBpsAfterNextUpdate}/${candidate.planningRateBps ?? "-"}@${candidate.planningLookaheadUpdates ?? 1}:${candidate.executionMode ?? "-"}` : "none"}`,
              `inventory=${inventoryCandidate ? `${inventoryCandidate.intent}:${inventoryCandidate.minimumExecutionSteps.some((step) => step.type === "DRAW_DEBT") ? "dual" : "remove-only"}:${inventoryCandidate.predictedRateBpsAfterNextUpdate}/${inventoryCandidate.planningRateBps ?? "-"}@${inventoryCandidate.planningLookaheadUpdates ?? 1}:${inventoryCandidate.executionMode ?? "-"}` : "none"}`
            ].join(" ")
          );

          inspectedMatches.push({
            archetypeId: archetype.id,
            poolAddress: archetype.poolAddress,
            blockNumber: archetype.blockNumber,
            senderAddress: archetype.senderAddress,
            currentRateBps: snapshot.currentRateBps,
            targetRateBps,
            borrowerDebtWad,
            borrowerCollateralWad,
            lenderLpBalance,
            bucketDepositWad,
            ...(candidate === undefined
              ? {}
              : {
                  candidateIntent: candidate.intent,
                  predictedRateBpsAfterNextUpdate: candidate.predictedRateBpsAfterNextUpdate,
                  ...(candidate.planningRateBps === undefined
                    ? {}
                    : { planningRateBps: candidate.planningRateBps }),
                  ...(candidate.planningLookaheadUpdates === undefined
                    ? {}
                    : { planningLookaheadUpdates: candidate.planningLookaheadUpdates }),
                  ...(candidate.executionMode === undefined
                    ? {}
                    : { executionMode: candidate.executionMode })
                }),
            ...(inventoryCandidate === undefined
              ? {}
              : {
                  inventoryCandidateIntent: inventoryCandidate.intent,
                  inventoryCandidateIncludesBorrow: inventoryCandidate.minimumExecutionSteps.some(
                    (step) => step.type === "DRAW_DEBT"
                  )
                })
          });
        }
      );
    }

    return {
      observations,
      inspectedMatches
    };
  }

  async function findTargetedAjnaInfoManagedUsedPoolInventoryCandidate(
    archetypeId: string,
    options: {
      targetIntent: "LEND" | "LEND_AND_BORROW";
      drawDebtLimitIndexes?: readonly number[];
    } = {
      targetIntent: "LEND"
    }
  ): Promise<{
    archetypeId: string;
    candidate?: PlanCandidate;
    currentRateBps: number;
    targetRateBps: number;
    observations: string[];
  }> {
    const upstreamRpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
    const archetype = EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES.find(
      (candidate) => candidate.id === archetypeId
    );
    if (!archetype) {
      throw new Error(`unknown ajna.info managed archetype: ${archetypeId}`);
    }

    const observations: string[] = [];
    process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

    return withTemporaryAnvilFork(
      {
        rpcUrl: upstreamRpcUrl,
        chainId: 8453,
        blockNumber: archetype.blockNumber
      },
      async ({ publicClient, rpcUrl }) => {
        const chainNow = Number((await publicClient.getBlock()).timestamp);
        const [currentRateInfo, [lenderLpBalance], bucketInfo] = await Promise.all([
          publicClient.readContract({
            address: archetype.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "interestRateInfo"
          }),
          publicClient.readContract({
            address: archetype.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "lenderInfo",
            args: [BigInt(archetype.lenderBucketIndex), archetype.senderAddress]
          }),
          publicClient.readContract({
            address: archetype.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "bucketInfo",
            args: [BigInt(archetype.lenderBucketIndex)]
          })
        ]);
        const [currentRateWad] = currentRateInfo;
        const currentRateBps = Number((currentRateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n);
        const targetRateBps = currentRateBps + archetype.targetOffsetBps;
        const resolvedLimitIndexes =
          options.targetIntent !== "LEND_AND_BORROW"
            ? []
            : await resolvePoolAwareBorrowLimitIndexes(
                publicClient,
                archetype.poolAddress,
                archetype.blockNumber,
                resolveKeeperConfig({
                  chainId: 8453,
                  poolAddress: archetype.poolAddress,
                  poolId: `8453:${archetype.poolAddress.toLowerCase()}`,
                  rpcUrl,
                  borrowerAddress: archetype.borrowerAddress,
                  simulationSenderAddress: archetype.senderAddress,
                  targetRateBps,
                  toleranceBps: archetype.toleranceBps,
                  toleranceMode: "absolute",
                  completionPolicy: "next_move_would_overshoot",
                  executionBufferBps: 0,
                  removeQuoteBucketIndex: archetype.lenderBucketIndex,
                  ...(options.drawDebtLimitIndexes === undefined
                    ? {}
                    : { drawDebtLimitIndexes: [...options.drawDebtLimitIndexes] }),
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
                  enableManagedDualUpwardControl: options.targetIntent === "LEND_AND_BORROW",
                  enableHeuristicLendSynthesis: false,
                  enableHeuristicBorrowSynthesis: false
                })
              );
        const config = resolveKeeperConfig({
          chainId: 8453,
          poolAddress: archetype.poolAddress,
          poolId: `8453:${archetype.poolAddress.toLowerCase()}`,
          rpcUrl,
          borrowerAddress: archetype.borrowerAddress,
          simulationSenderAddress: archetype.senderAddress,
          targetRateBps,
          toleranceBps: archetype.toleranceBps,
          toleranceMode: "absolute",
          completionPolicy: "next_move_would_overshoot",
          executionBufferBps: 0,
          removeQuoteBucketIndex: archetype.lenderBucketIndex,
          ...(options.drawDebtLimitIndexes === undefined
            ? {}
            : { drawDebtLimitIndexes: [...options.drawDebtLimitIndexes] }),
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
          enableManagedDualUpwardControl: options.targetIntent === "LEND_AND_BORROW",
          enableHeuristicLendSynthesis: false,
          enableHeuristicBorrowSynthesis: false
        });
        const snapshot = await new AjnaRpcSnapshotSource(config, {
          publicClient,
          now: () => chainNow
        }).getSnapshot();
        const metadata = readPoolSnapshotMetadata(snapshot);
        const candidate = snapshot.candidates.find(
          (currentCandidate): currentCandidate is PlanCandidate =>
            currentCandidate.candidateSource === "simulation" &&
            currentCandidate.minimumExecutionSteps.some((step) => step.type === "REMOVE_QUOTE") &&
            (options.targetIntent === "LEND"
              ? currentCandidate.intent === "LEND"
              : currentCandidate.intent === "LEND_AND_BORROW" &&
                currentCandidate.minimumExecutionSteps.some((step) => step.type === "DRAW_DEBT"))
        );

        observations.push(
          [
            `targeted-archetype=${archetype.id}`,
            `intent=${options.targetIntent}`,
            `bucket=${archetype.lenderBucketIndex}`,
            `current=${snapshot.currentRateBps}`,
            `target=${targetRateBps}`,
            `secondsUntil=${snapshot.secondsUntilNextRateUpdate}`,
            `next=${snapshot.predictedNextOutcome}`,
            `noOfLoans=${String(metadata.noOfLoans ?? "unknown")}`,
            `debtEma=${String(metadata.debtEmaWad ?? "unknown")}`,
            `depositEma=${String(metadata.depositEmaWad ?? "unknown")}`,
            `debtColEma=${String(metadata.debtColEmaWad ?? "unknown")}`,
            `lupt0DebtEma=${String(metadata.lupt0DebtEmaWad ?? "unknown")}`,
            `resolvedLimits=${resolvedLimitIndexes.join(",") || "none"}`,
            `lenderLp=${formatTokenAmount(lenderLpBalance)}`,
            `bucketDeposit=${formatTokenAmount(bucketInfo[3])}`,
            `candidate=${
              candidate
                ? `${candidate.intent}:${candidate.predictedRateBpsAfterNextUpdate}/${candidate.planningRateBps ?? "-"}@${candidate.planningLookaheadUpdates ?? 1}`
                : "none"
            }`,
            `steps=${candidate ? candidate.minimumExecutionSteps.map((step) => step.type).join("+") : "none"}`,
            `allCandidates=${
              snapshot.candidates.length === 0
                ? "none"
                : snapshot.candidates
                    .map(
                      (currentCandidate) =>
                        `${currentCandidate.intent}:${currentCandidate.minimumExecutionSteps
                          .map((step) => step.type)
                          .join("+")}:${currentCandidate.candidateSource ?? "-"}:${currentCandidate.predictedRateBpsAfterNextUpdate}/${currentCandidate.planningRateBps ?? "-"}@${currentCandidate.planningLookaheadUpdates ?? 1}`
                    )
                    .join(",")
            }`
          ].join(" ")
        );

        return {
          archetypeId: archetype.id,
          ...(candidate === undefined ? {} : { candidate }),
          currentRateBps,
          targetRateBps,
          observations
        };
      }
    );
  }

  async function probeAjnaInfoManagedUsedPoolManualRemoveQuote(): Promise<{
    observations: string[];
    probedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      senderAddress: `0x${string}`;
      bucketIndex: number;
      currentRateBps: number;
      targetRateBps: number;
      secondsUntilNextRateUpdate: number;
      predictedNextOutcome: RateMoveOutcome;
      maxWithdrawableQuoteAmount: bigint;
      passiveRateBps: number;
      bestActiveRateBps?: number;
      bestRemoveQuoteAmount?: bigint;
      improved: boolean;
    }>;
  }> {
    const upstreamRpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
    process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;
    const observations: string[] = [];
    const probedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      senderAddress: `0x${string}`;
      bucketIndex: number;
      currentRateBps: number;
      targetRateBps: number;
      secondsUntilNextRateUpdate: number;
      predictedNextOutcome: RateMoveOutcome;
      maxWithdrawableQuoteAmount: bigint;
      passiveRateBps: number;
      bestActiveRateBps?: number;
      bestRemoveQuoteAmount?: bigint;
      improved: boolean;
    }> = [];

    for (const archetype of EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES.filter((candidate) =>
      MANUAL_DUAL_AJNA_INFO_ARCHETYPE_IDS.has(candidate.id)
    )) {
      await withPreparedSimulationFork(
        {
          rpcUrl: upstreamRpcUrl,
          chainId: 8453,
          blockNumber: archetype.blockNumber
        },
        archetype.senderAddress,
        async ({ publicClient, testClient, walletClient, rpcUrl }) => {
          const chainNow = Number((await publicClient.getBlock()).timestamp);
          const lenderBucketIndex = BigInt(archetype.lenderBucketIndex);
          const [[currentRateWad], [borrowerDebtWad, borrowerCollateralWad], [lenderLpBalance], bucketInfo] =
            await Promise.all([
              publicClient.readContract({
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "interestRateInfo"
              }),
              publicClient.readContract({
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "borrowerInfo",
                args: [archetype.borrowerAddress]
              }),
              publicClient.readContract({
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "lenderInfo",
                args: [lenderBucketIndex, archetype.senderAddress]
              }),
              publicClient.readContract({
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "bucketInfo",
                args: [lenderBucketIndex]
              })
            ]);
          const [
            lpAccumulator,
            availableCollateral,
            bankruptcyTime,
            bucketDeposit,
            bucketScale
          ] = bucketInfo;
          const maxWithdrawableQuoteAmount = calculateMaxWithdrawableQuoteAmountFromLp({
            bucketLPAccumulator: lpAccumulator,
            availableCollateral,
            bucketDeposit,
            lenderLpBalance,
            bucketPriceWad: fenwickIndexToPriceWad(archetype.lenderBucketIndex)
          });
          const currentRateBps = Number((currentRateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n);
          const targetRateBps = currentRateBps + archetype.targetOffsetBps;
          const config = resolveKeeperConfig({
            chainId: 8453,
            poolAddress: archetype.poolAddress,
            poolId: `8453:${archetype.poolAddress.toLowerCase()}`,
            rpcUrl,
            borrowerAddress: archetype.borrowerAddress,
            simulationSenderAddress: archetype.senderAddress,
            targetRateBps,
            toleranceBps: archetype.toleranceBps,
            toleranceMode: "absolute",
            completionPolicy: "next_move_would_overshoot",
            executionBufferBps: 0,
            maxQuoteTokenExposure: "1000000000000000000000000",
            maxBorrowExposure: "1000000000000000000000",
            snapshotAgeMaxSeconds: 3600,
            minTimeBeforeRateWindowSeconds: 120,
            minExecutableActionQuoteToken: "1",
            recheckBeforeSubmit: true,
            enableSimulationBackedLendSynthesis: true,
            enableSimulationBackedBorrowSynthesis: true,
            enableHeuristicLendSynthesis: false,
            enableHeuristicBorrowSynthesis: false
          });
          const snapshot = await new AjnaRpcSnapshotSource(config, {
            publicClient,
            now: () => chainNow
          }).getSnapshot();
          const amountCandidates = deriveManualRemoveQuoteAmounts(maxWithdrawableQuoteAmount);

          observations.push(
            [
              `manual-remove archetype=${archetype.id}`,
              `current=${snapshot.currentRateBps}`,
              `target=${targetRateBps}`,
              `secondsUntil=${snapshot.secondsUntilNextRateUpdate}`,
              `next=${snapshot.predictedNextOutcome}`,
              `lp=${lenderLpBalance.toString()}`,
              `bucketDeposit=${bucketDeposit.toString()}`,
              `maxWithdraw=${maxWithdrawableQuoteAmount.toString()}`,
              `borrowerDebt=${borrowerDebtWad.toString()}`,
              `borrowerCollateral=${borrowerCollateralWad.toString()}`,
              `bankruptcyTime=${bankruptcyTime.toString()}`,
              `bucketScale=${bucketScale.toString()}`
            ].join(" ")
          );

          const baseResult = {
            archetypeId: archetype.id,
            poolAddress: archetype.poolAddress,
            blockNumber: archetype.blockNumber,
            senderAddress: archetype.senderAddress,
            bucketIndex: archetype.lenderBucketIndex,
            currentRateBps: snapshot.currentRateBps,
            targetRateBps,
            secondsUntilNextRateUpdate: snapshot.secondsUntilNextRateUpdate,
            predictedNextOutcome: snapshot.predictedNextOutcome,
            maxWithdrawableQuoteAmount
          };

          if (
            borrowerDebtWad <= 0n ||
            borrowerCollateralWad <= 0n ||
            lenderLpBalance <= 0n ||
            bucketDeposit <= 0n ||
            maxWithdrawableQuoteAmount <= 0n ||
            amountCandidates.length === 0
          ) {
            probedMatches.push({
              ...baseResult,
              passiveRateBps: snapshot.currentRateBps,
              improved: false
            });
            return;
          }

          const { passivePath, passiveDistanceToTargetBps: passiveDistanceToTarget } =
            await capturePassiveRateBranch(testClient, targetRateBps, () =>
              _deps.advanceAndApplyEligibleUpdatesDirect(
                archetype.senderAddress,
                publicClient,
                walletClient,
                testClient,
                archetype.poolAddress,
                2
              )
            );
          let bestActiveRateBps: number | undefined;
          let bestRemoveQuoteAmount: bigint | undefined;

          for (const removeQuoteAmount of amountCandidates) {
            const probe = await executeRateProbeBranch({
              testClient,
              targetRateBps,
              observations,
              passivePath,
              label: `manual-remove archetype=${archetype.id} amount=${removeQuoteAmount.toString()}`,
              runBranch: async () => {
                const removeQuoteHash = await walletClient.writeContract({
                  account: archetype.senderAddress,
                  chain: undefined,
                  address: archetype.poolAddress,
                  abi: ajnaPoolAbi,
                  functionName: "removeQuoteToken",
                  args: [removeQuoteAmount, lenderBucketIndex]
                });
                await publicClient.waitForTransactionReceipt({ hash: removeQuoteHash });

                return _deps.advanceAndApplyEligibleUpdatesDirect(
                  archetype.senderAddress,
                  publicClient,
                  walletClient,
                  testClient,
                  archetype.poolAddress,
                  2
                );
              }
            });

            if (probe.activePath !== undefined) {
              const bestDistanceToTarget =
                bestActiveRateBps === undefined
                  ? Number.POSITIVE_INFINITY
                  : distanceToTargetRateBps(bestActiveRateBps, targetRateBps);
              if (
                (probe.activeDistanceToTargetBps ?? Number.POSITIVE_INFINITY) <
                  bestDistanceToTarget ||
                ((probe.activeDistanceToTargetBps ?? Number.POSITIVE_INFINITY) ===
                  bestDistanceToTarget &&
                  (bestActiveRateBps === undefined ||
                    probe.activePath.currentRateBps > bestActiveRateBps))
              ) {
                bestActiveRateBps = probe.activePath.currentRateBps;
                bestRemoveQuoteAmount = removeQuoteAmount;
              }
            }
          }

          probedMatches.push({
            ...baseResult,
            passiveRateBps: passivePath.currentRateBps,
            ...(bestActiveRateBps === undefined ? {} : { bestActiveRateBps }),
            ...(bestRemoveQuoteAmount === undefined ? {} : { bestRemoveQuoteAmount }),
            improved:
              bestActiveRateBps !== undefined &&
              Math.abs(bestActiveRateBps - targetRateBps) < passiveDistanceToTarget
          });
        }
      );
    }

    return {
      observations,
      probedMatches
    };
  }

  async function probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow(): Promise<{
    observations: string[];
    probedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      senderAddress: `0x${string}`;
      bucketIndex: number;
      currentRateBps: number;
      targetRateBps: number;
      maxWithdrawableQuoteAmount: bigint;
      maxBorrowSearchAmount: bigint;
      passiveRateBps: number;
      bestActiveRateBps?: number;
      bestRemoveQuoteAmount?: bigint;
      bestDrawDebtAmount?: bigint;
      bestLimitIndex?: number;
      improved: boolean;
    }>;
  }> {
    const upstreamRpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
    process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;
    const observations: string[] = [];
    const probedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      senderAddress: `0x${string}`;
      bucketIndex: number;
      currentRateBps: number;
      targetRateBps: number;
      maxWithdrawableQuoteAmount: bigint;
      maxBorrowSearchAmount: bigint;
      passiveRateBps: number;
      bestActiveRateBps?: number;
      bestRemoveQuoteAmount?: bigint;
      bestDrawDebtAmount?: bigint;
      bestLimitIndex?: number;
      improved: boolean;
    }> = [];

    for (const archetype of EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES.filter((candidate) =>
      MANUAL_DUAL_AJNA_INFO_ARCHETYPE_IDS.has(candidate.id)
    )) {
      await withPreparedSimulationFork(
        {
          rpcUrl: upstreamRpcUrl,
          chainId: 8453,
          blockNumber: archetype.blockNumber
        },
        archetype.senderAddress,
        async ({ publicClient, testClient, walletClient, rpcUrl }) => {
          const lenderBucketIndex = BigInt(archetype.lenderBucketIndex);
          const [
            [currentRateWad],
            [borrowerDebtWad, borrowerCollateralWad],
            [lenderLpBalance],
            bucketInfo,
            quoteTokenScale
          ] = await Promise.all([
            publicClient.readContract({
              address: archetype.poolAddress,
              abi: ajnaPoolAbi,
              functionName: "interestRateInfo"
            }),
            publicClient.readContract({
              address: archetype.poolAddress,
              abi: ajnaPoolAbi,
              functionName: "borrowerInfo",
              args: [archetype.borrowerAddress]
            }),
            publicClient.readContract({
              address: archetype.poolAddress,
              abi: ajnaPoolAbi,
              functionName: "lenderInfo",
              args: [lenderBucketIndex, archetype.senderAddress]
            }),
            publicClient.readContract({
              address: archetype.poolAddress,
              abi: ajnaPoolAbi,
              functionName: "bucketInfo",
              args: [lenderBucketIndex]
            }),
            publicClient.readContract({
              address: archetype.poolAddress,
              abi: ajnaPoolAbi,
              functionName: "quoteTokenScale"
            })
          ]);
          const [lpAccumulator, availableCollateral, , bucketDeposit] = bucketInfo;
          const maxWithdrawableQuoteAmount = calculateMaxWithdrawableQuoteAmountFromLp({
            bucketLPAccumulator: lpAccumulator,
            availableCollateral,
            bucketDeposit,
            lenderLpBalance,
            bucketPriceWad: fenwickIndexToPriceWad(archetype.lenderBucketIndex)
          });
          const currentRateBps = Number((currentRateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n);
          const targetRateBps = currentRateBps + archetype.targetOffsetBps;
          const maxBorrowSearchAmount = [
            maxWithdrawableQuoteAmount * 8n,
            borrowerDebtWad * 2n,
            quoteTokenScale * 10n
          ].reduce((candidate, value) => (value > candidate ? value : candidate), 1n);
          const minimumMeaningfulBorrowAmount = greatestBigInt(quoteTokenScale, 1n);
          const config = resolveKeeperConfig({
            chainId: 8453,
            poolAddress: archetype.poolAddress,
            poolId: `8453:${archetype.poolAddress.toLowerCase()}`,
            rpcUrl,
            borrowerAddress: archetype.borrowerAddress,
            simulationSenderAddress: archetype.senderAddress,
            targetRateBps,
            toleranceBps: archetype.toleranceBps,
            toleranceMode: "absolute",
            completionPolicy: "next_move_would_overshoot",
            executionBufferBps: 0,
            addQuoteBucketIndex: archetype.lenderBucketIndex,
            drawDebtLimitIndex: archetype.lenderBucketIndex,
            maxQuoteTokenExposure: "1000000000000000000000000",
            maxBorrowExposure: greatestBigInt(1n, maxBorrowSearchAmount).toString(),
            snapshotAgeMaxSeconds: 3600,
            minTimeBeforeRateWindowSeconds: 120,
            minExecutableActionQuoteToken: "1",
            recheckBeforeSubmit: true,
            enableSimulationBackedLendSynthesis: true,
            enableSimulationBackedBorrowSynthesis: true,
            enableHeuristicLendSynthesis: false,
            enableHeuristicBorrowSynthesis: false
          });
          const removeQuoteAnchors = deriveManualRemoveQuoteAmounts(maxWithdrawableQuoteAmount);

          const baseResult = {
            archetypeId: archetype.id,
            poolAddress: archetype.poolAddress,
            blockNumber: archetype.blockNumber,
            senderAddress: archetype.senderAddress,
            bucketIndex: archetype.lenderBucketIndex,
            currentRateBps,
            targetRateBps,
            maxWithdrawableQuoteAmount,
            maxBorrowSearchAmount
          };

          if (
            borrowerDebtWad <= 0n ||
            borrowerCollateralWad <= 0n ||
            lenderLpBalance <= 0n ||
            bucketDeposit <= 0n ||
            maxWithdrawableQuoteAmount <= 0n ||
            removeQuoteAnchors.length === 0
          ) {
            probedMatches.push({
              ...baseResult,
              passiveRateBps: currentRateBps,
              improved: false
            });
            return;
          }

          const limitIndexes = (
            await resolvePoolAwareBorrowLimitIndexes(
              publicClient,
              archetype.poolAddress,
              archetype.blockNumber,
              config,
              {
                seedIndexes: [archetype.lenderBucketIndex]
              }
            )
          ).slice(0, 3);
          const borrowAmountAnchors = buildMultiCycleBorrowSearchAmounts(
            minimumMeaningfulBorrowAmount,
            maxBorrowSearchAmount,
            quoteTokenScale,
            [borrowerDebtWad, maxWithdrawableQuoteAmount, quoteTokenScale]
          );
          const sampledRemoveQuoteAmounts = selectRepresentativeAmounts(removeQuoteAnchors, 3);
          const sampledBorrowAmounts = selectRepresentativeAmounts(borrowAmountAnchors, 3);

          observations.push(
            [
              `manual-dual archetype=${archetype.id}`,
              `current=${currentRateBps}`,
              `target=${targetRateBps}`,
              `bucket=${archetype.lenderBucketIndex}`,
              `maxWithdraw=${maxWithdrawableQuoteAmount.toString()}`,
              `maxBorrow=${maxBorrowSearchAmount.toString()}`,
              `minMeaningfulBorrow=${minimumMeaningfulBorrowAmount.toString()}`,
              `limitIndexes=${limitIndexes.join(",") || "none"}`,
              `borrowAnchors=${sampledBorrowAmounts.map((amount) => amount.toString()).join(",") || "none"}`,
              `removeAnchors=${sampledRemoveQuoteAmounts.map((amount) => amount.toString()).join(",") || "none"}`
            ].join(" ")
          );

          if (limitIndexes.length === 0 || sampledBorrowAmounts.length === 0) {
            probedMatches.push({
              ...baseResult,
              passiveRateBps: currentRateBps,
              improved: false
            });
            return;
          }

          const { passivePath, passiveDistanceToTargetBps: passiveDistanceToTarget } =
            await capturePassiveRateBranch(testClient, targetRateBps, () =>
              _deps.advanceAndApplyEligibleUpdatesDirect(
                archetype.senderAddress,
                publicClient,
                walletClient,
                testClient,
                archetype.poolAddress,
                2
              )
            );
          const removeOnlyPathsByAmount = new Map<
            string,
            {
              currentRateBps: number;
              distanceToTargetBps: number;
            }
          >();

          for (const removeQuoteAmount of sampledRemoveQuoteAmounts) {
            const probe = await executeRateProbeBranch({
              testClient,
              targetRateBps,
              observations,
              passivePath,
              label: `manual-dual-remove-only archetype=${archetype.id} remove=${removeQuoteAmount.toString()}`,
              runBranch: async () => {
                const removeQuoteHash = await walletClient.writeContract({
                  account: archetype.senderAddress,
                  chain: undefined,
                  address: archetype.poolAddress,
                  abi: ajnaPoolAbi,
                  functionName: "removeQuoteToken",
                  args: [removeQuoteAmount, lenderBucketIndex]
                });
                await publicClient.waitForTransactionReceipt({ hash: removeQuoteHash });

                return _deps.advanceAndApplyEligibleUpdatesDirect(
                  archetype.senderAddress,
                  publicClient,
                  walletClient,
                  testClient,
                  archetype.poolAddress,
                  2
                );
              }
            });

            if (probe.activePath !== undefined && probe.activeDistanceToTargetBps !== undefined) {
              removeOnlyPathsByAmount.set(removeQuoteAmount.toString(), {
                currentRateBps: probe.activePath.currentRateBps,
                distanceToTargetBps: probe.activeDistanceToTargetBps
              });
            }
          }

          let bestActiveRateBps: number | undefined;
          let bestRemoveQuoteAmount: bigint | undefined;
          let bestDrawDebtAmount: bigint | undefined;
          let bestLimitIndex: number | undefined;

          for (const limitIndex of limitIndexes.slice(0, 2)) {
            let limitImproved = false;

            for (const removeQuoteAmount of sampledRemoveQuoteAmounts) {
              for (const drawDebtAmount of sampledBorrowAmounts) {
                const probe = await executeRateProbeBranch({
                  testClient,
                  targetRateBps,
                  observations,
                  passivePath,
                  label: `manual-dual archetype=${archetype.id} limit=${limitIndex} remove=${removeQuoteAmount.toString()} draw=${drawDebtAmount.toString()}`,
                  runBranch: async () => {
                    const removeQuoteHash = await walletClient.writeContract({
                      account: archetype.senderAddress,
                      chain: undefined,
                      address: archetype.poolAddress,
                      abi: ajnaPoolAbi,
                      functionName: "removeQuoteToken",
                      args: [removeQuoteAmount, lenderBucketIndex]
                    });
                    await publicClient.waitForTransactionReceipt({ hash: removeQuoteHash });

                    const drawDebtHash = await walletClient.writeContract({
                      account: archetype.senderAddress,
                      chain: undefined,
                      address: archetype.poolAddress,
                      abi: ajnaPoolAbi,
                      functionName: "drawDebt",
                      args: [archetype.borrowerAddress, drawDebtAmount, BigInt(limitIndex), 0n]
                    });
                    await publicClient.waitForTransactionReceipt({ hash: drawDebtHash });

                    return _deps.advanceAndApplyEligibleUpdatesDirect(
                      archetype.senderAddress,
                      publicClient,
                      walletClient,
                      testClient,
                      archetype.poolAddress,
                      2
                    );
                  }
                });

                if (
                  probe.activePath === undefined ||
                  probe.activeDistanceToTargetBps === undefined
                ) {
                  continue;
                }

                const distanceToTargetBps = probe.activeDistanceToTargetBps;
                const removeOnlyPath = removeOnlyPathsByAmount.get(removeQuoteAmount.toString());
                const removeOnlyDistanceToTarget =
                  removeOnlyPath?.distanceToTargetBps ?? Number.POSITIVE_INFINITY;

                if (
                  probe.activePath.currentRateBps <= passivePath.currentRateBps ||
                  distanceToTargetBps >= passiveDistanceToTarget ||
                  distanceToTargetBps >= removeOnlyDistanceToTarget
                ) {
                  continue;
                }

                limitImproved = true;
                const currentBestDistance =
                  bestActiveRateBps === undefined
                    ? Number.POSITIVE_INFINITY
                    : distanceToTargetRateBps(bestActiveRateBps, targetRateBps);
                if (
                  bestActiveRateBps === undefined ||
                  distanceToTargetBps < currentBestDistance ||
                  (distanceToTargetBps === currentBestDistance &&
                    probe.activePath.currentRateBps > bestActiveRateBps)
                ) {
                  bestActiveRateBps = probe.activePath.currentRateBps;
                  bestRemoveQuoteAmount = removeQuoteAmount;
                  bestDrawDebtAmount = drawDebtAmount;
                  bestLimitIndex = limitIndex;
                }
              }
            }

            if (!limitImproved) {
              observations.push(`manual-dual archetype=${archetype.id} limit=${limitIndex} no-improvement`);
            }
          }

          probedMatches.push({
            ...baseResult,
            passiveRateBps: passivePath.currentRateBps,
            ...(bestActiveRateBps === undefined ? {} : { bestActiveRateBps }),
            ...(bestRemoveQuoteAmount === undefined ? {} : { bestRemoveQuoteAmount }),
            ...(bestDrawDebtAmount === undefined ? {} : { bestDrawDebtAmount }),
            ...(bestLimitIndex === undefined ? {} : { bestLimitIndex }),
            improved:
              bestActiveRateBps !== undefined &&
              Math.abs(bestActiveRateBps - targetRateBps) < passiveDistanceToTarget
          });
        }
      );
    }

    return {
      observations,
      probedMatches
    };
  }

  return {
    inspectAjnaInfoManagedUsedPoolArchetypes,
    findTargetedAjnaInfoManagedUsedPoolInventoryCandidate,
    probeAjnaInfoManagedUsedPoolManualRemoveQuote,
    probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow
  };
}

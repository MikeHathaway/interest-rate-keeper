import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  resolveKeeperConfig,
  type PlanCandidate,
  type RateMoveOutcome
} from "../../../../src/index.js";
import {
  readManagedControlSnapshotMetadata,
  readPoolSnapshotMetadata
} from "../../../../src/core/snapshot/metadata.js";
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
  advanceAndApplyEligibleUpdatesDirect,
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

  /**
   * End-to-end execution proof for curator-mode REMOVE_QUOTE on a pinned real
   * managed archetype. The production keeper cannot be exercised with the
   * curator's real private key, so this helper instead:
   *   1. Runs the exact same snapshot + planning path the keeper would run
   *      (AjnaRpcSnapshotSource + enableManagedInventoryUpwardControl).
   *   2. Asserts the REMOVE_QUOTE candidate surfaces.
   *   3. Impersonates the curator via anvil and submits the planned
   *      removeQuoteToken call directly on-chain against the fork.
   *   4. Verifies the call succeeded and the target bucket's deposit dropped
   *      by the planned amount, proving the planned action actually executes
   *      against real pool state.
   * This closes the gap between "candidate surfaces" and "candidate executes
   * without reverting on real fork state" for the curator-only path.
   */
  /**
   * Return shape for the probe-style helper that iterates across all pinned
   * managed archetypes. A discriminated union: either the archetype surfaced a
   * candidate and was executed (full rate-progression metrics), or no
   * simulation-backed REMOVE_QUOTE candidate surfaced and we record that fact
   * so the multi-archetype test can summarize which archetypes are supported
   * vs. which are not-yet-surfacing without aborting the loop.
   */
  type TargetedRemoveQuoteProbeResult =
    | {
        status: "executed_and_realized";
        archetypeId: string;
        candidate: PlanCandidate;
        currentRateBps: number;
        targetRateBps: number;
        removeQuoteAmount: bigint;
        lenderBucketIndex: number;
        bucketDepositBeforeWad: bigint;
        bucketDepositAfterWad: bigint;
        transactionHash: `0x${string}`;
        gasUsed: bigint;
        submissionDurationMs: number;
        quoteTokenAddress: `0x${string}`;
        quoteTokenScale: bigint;
        rateBpsAfterFirstUpdate: number;
        rateBpsAfterTerminalUpdate?: number;
        observations: string[];
      }
    | {
        status: "no_candidate";
        archetypeId: string;
        currentRateBps: number;
        targetRateBps: number;
        predictedNextRateBps: number;
        predictedNextOutcome: string;
        secondsUntilNextRateUpdate: number;
        lenderLpBalance: bigint;
        bucketDepositWad: bigint;
        managedInventoryUpwardEligible?: boolean;
        managedInventoryIneligibilityReason?: string;
        managedTotalWithdrawableQuoteAmount?: bigint;
        managedPerBucketWithdrawableQuoteAmount?: ReadonlyMap<number, bigint>;
        candidateCount: number;
        candidateSummaries: string[];
        observations: string[];
      };

  async function runTargetedManagedRemoveQuoteProbe(
    archetypeId: string
  ): Promise<TargetedRemoveQuoteProbeResult> {
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
      async ({ publicClient, testClient, walletClient, rpcUrl }) => {
        const chainNow = Number((await publicClient.getBlock()).timestamp);
        const [currentRateInfo, bucketInfoBefore] = await Promise.all([
          publicClient.readContract({
            address: archetype.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "interestRateInfo"
          }),
          publicClient.readContract({
            address: archetype.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "bucketInfo",
            args: [BigInt(archetype.lenderBucketIndex)]
          })
        ]);
        const [currentRateWad] = currentRateInfo;
        const currentRateBps = Number(
          (currentRateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n
        );
        const targetRateBps = currentRateBps + archetype.targetOffsetBps;
        const bucketDepositBeforeWad = bucketInfoBefore[3];

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
          enableManagedDualUpwardControl: false,
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
            currentCandidate.intent === "LEND" &&
            currentCandidate.minimumExecutionSteps.some((step) => step.type === "REMOVE_QUOTE")
        );

        if (candidate === undefined) {
          // Read raw pool state at the seeded bucket so we can tell apart
          // "operator has no LP here" vs "operator has LP but the search
          // found no improving amount." lenderInfo returns (lpBalance,
          // depositTime). bucketInfoBefore[3] is the bucket's total deposit.
          const [lenderLpBalance] = (await publicClient.readContract({
            address: archetype.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "lenderInfo",
            args: [BigInt(archetype.lenderBucketIndex), archetype.senderAddress]
          })) as readonly [bigint, bigint];

          const managedMetadata =
            readManagedControlSnapshotMetadata(snapshot);
          const candidateSummaries = snapshot.candidates.map(
            (c) =>
              `${c.intent}:${c.minimumExecutionSteps
                .map((s) => s.type)
                .join("+")}:${c.candidateSource ?? "-"}:next=${c.predictedRateBpsAfterNextUpdate}`
          );

          observations.push(
            [
              `archetype=${archetype.id}`,
              `status=no_candidate`,
              `block=${archetype.blockNumber.toString()}`,
              `bucket=${archetype.lenderBucketIndex}`,
              `lenderLp=${lenderLpBalance.toString()}`,
              `bucketDeposit=${bucketDepositBeforeWad.toString()}`,
              `managedEligible=${managedMetadata.managedInventoryUpwardEligible ?? "n/a"}`,
              `managedIneligibleReason=${managedMetadata.managedInventoryIneligibilityReason ?? "none"}`,
              `managedTotalWithdrawable=${managedMetadata.managedTotalWithdrawableQuoteAmount?.toString() ?? "n/a"}`,
              `candidates=${candidateSummaries.join(",") || "none"}`
            ].join(" ")
          );
          return {
            status: "no_candidate",
            archetypeId: archetype.id,
            currentRateBps,
            targetRateBps,
            predictedNextRateBps: snapshot.predictedNextRateBps,
            predictedNextOutcome: snapshot.predictedNextOutcome,
            secondsUntilNextRateUpdate: snapshot.secondsUntilNextRateUpdate,
            lenderLpBalance,
            bucketDepositWad: bucketDepositBeforeWad,
            ...(managedMetadata.managedInventoryUpwardEligible === undefined
              ? {}
              : {
                  managedInventoryUpwardEligible:
                    managedMetadata.managedInventoryUpwardEligible
                }),
            ...(managedMetadata.managedInventoryIneligibilityReason ===
            undefined
              ? {}
              : {
                  managedInventoryIneligibilityReason:
                    managedMetadata.managedInventoryIneligibilityReason
                }),
            ...(managedMetadata.managedTotalWithdrawableQuoteAmount ===
            undefined
              ? {}
              : {
                  managedTotalWithdrawableQuoteAmount:
                    managedMetadata.managedTotalWithdrawableQuoteAmount
                }),
            ...(managedMetadata.managedPerBucketWithdrawableQuoteAmount ===
            undefined
              ? {}
              : {
                  managedPerBucketWithdrawableQuoteAmount:
                    managedMetadata.managedPerBucketWithdrawableQuoteAmount
                }),
            candidateCount: snapshot.candidates.length,
            candidateSummaries,
            observations
          };
        }

        const removeQuoteStep = candidate.minimumExecutionSteps.find(
          (step): step is Extract<typeof step, { type: "REMOVE_QUOTE" }> =>
            step.type === "REMOVE_QUOTE"
        );
        if (removeQuoteStep === undefined) {
          throw new Error(
            `candidate ${candidate.id} unexpectedly omits a REMOVE_QUOTE step`
          );
        }

        const perBucketSerialized =
          metadata.managedPerBucketWithdrawableQuoteAmount;
        observations.push(
          [
            `archetype=${archetype.id}`,
            `block=${archetype.blockNumber.toString()}`,
            `bucket=${removeQuoteStep.bucketIndex}`,
            `amount=${removeQuoteStep.amount.toString()}`,
            `candidate=${candidate.id}`,
            `validationSignature=${candidate.validationSignature ?? "none"}`,
            `perBucketMetadata=${perBucketSerialized ?? "none"}`,
            `predictedRate=${candidate.predictedRateBpsAfterNextUpdate}`,
            `planningRate=${candidate.planningRateBps ?? "-"}`,
            `planningLookahead=${candidate.planningLookaheadUpdates ?? 1}`
          ].join(" ")
        );

        // Per-bucket metadata should include the target bucket for the plan
        // we just synthesized, proving the new per-bucket write path is live.
        if (perBucketSerialized === undefined) {
          throw new Error(
            `managedPerBucketWithdrawableQuoteAmount was not emitted for ${archetype.id}; per-bucket recheck would have nothing to validate`
          );
        }

        await testClient.impersonateAccount({ address: archetype.senderAddress });
        await testClient.setBalance({
          address: archetype.senderAddress,
          value: 10n ** 22n
        });

        const quoteTokenAddress = await publicClient.readContract({
          address: archetype.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "quoteTokenAddress"
        });
        const quoteTokenScale = await publicClient.readContract({
          address: archetype.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "quoteTokenScale"
        });

        const submissionStartedAtMs = Date.now();
        const transactionHash = await walletClient.writeContract({
          account: archetype.senderAddress,
          chain: undefined,
          address: archetype.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "removeQuoteToken",
          args: [removeQuoteStep.amount, BigInt(removeQuoteStep.bucketIndex)]
        });
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: transactionHash
        });
        const submissionDurationMs = Date.now() - submissionStartedAtMs;
        if (receipt.status !== "success") {
          throw new Error(
            `removeQuoteToken reverted on fork; archetype=${archetype.id} amount=${removeQuoteStep.amount.toString()} bucket=${removeQuoteStep.bucketIndex}`
          );
        }

        const bucketInfoAfter = await publicClient.readContract({
          address: archetype.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "bucketInfo",
          args: [BigInt(archetype.lenderBucketIndex)]
        });
        const bucketDepositAfterWad = bucketInfoAfter[3];

        observations.push(
          [
            `bucketDepositBefore=${bucketDepositBeforeWad.toString()}`,
            `bucketDepositAfter=${bucketDepositAfterWad.toString()}`,
            `receiptStatus=${receipt.status}`,
            `gasUsed=${receipt.gasUsed.toString()}`,
            `submissionMs=${submissionDurationMs}`,
            `txHash=${transactionHash}`
          ].join(" ")
        );

        // Warp to the next Ajna rate-update boundary + call updateInterest so
        // we observe the REALIZED rate, not just the simulator's prediction.
        // Ajna rate updates are 12h minimum intervals. If the candidate used a
        // multi-update lookahead (e.g. planningLookaheadUpdates=2), warp twice
        // so we can compare the terminal rate to candidate.planningRateBps.
        const rateProgressionStartedAtMs = Date.now();
        const firstUpdate = await advanceAndApplyEligibleUpdatesDirect(
          archetype.senderAddress,
          publicClient,
          walletClient,
          testClient,
          archetype.poolAddress,
          1
        );
        const rateBpsAfterFirstUpdate = firstUpdate.currentRateBps;

        let rateBpsAfterTerminalUpdate: number | undefined;
        const lookaheadUpdates = candidate.planningLookaheadUpdates ?? 1;
        if (lookaheadUpdates > 1) {
          const terminalUpdate = await advanceAndApplyEligibleUpdatesDirect(
            archetype.senderAddress,
            publicClient,
            walletClient,
            testClient,
            archetype.poolAddress,
            lookaheadUpdates - 1
          );
          rateBpsAfterTerminalUpdate = terminalUpdate.currentRateBps;
        }

        observations.push(
          [
            `rateAfterFirstUpdate=${rateBpsAfterFirstUpdate}`,
            `rateAfterTerminalUpdate=${rateBpsAfterTerminalUpdate ?? "n/a"}`,
            `rateProgressionMs=${Date.now() - rateProgressionStartedAtMs}`
          ].join(" ")
        );

        await testClient.stopImpersonatingAccount({
          address: archetype.senderAddress
        });

        return {
          status: "executed_and_realized",
          archetypeId: archetype.id,
          candidate,
          currentRateBps,
          targetRateBps,
          removeQuoteAmount: removeQuoteStep.amount,
          lenderBucketIndex: removeQuoteStep.bucketIndex,
          bucketDepositBeforeWad,
          bucketDepositAfterWad,
          transactionHash,
          gasUsed: receipt.gasUsed,
          submissionDurationMs,
          quoteTokenAddress,
          quoteTokenScale,
          rateBpsAfterFirstUpdate,
          ...(rateBpsAfterTerminalUpdate === undefined
            ? {}
            : { rateBpsAfterTerminalUpdate }),
          observations
        };
      }
    );
  }

  /**
   * Strict variant of the probe: throws if no REMOVE_QUOTE candidate surfaces
   * on the archetype. Used by the single-archetype dog/USDC test that expects
   * a known-good candidate to exist.
   */
  async function executeTargetedAjnaInfoManagedUsedPoolRemoveQuote(
    archetypeId: string
  ) {
    const result = await runTargetedManagedRemoveQuoteProbe(archetypeId);
    if (result.status !== "executed_and_realized") {
      throw new Error(
        `expected a simulation-backed REMOVE_QUOTE candidate for archetype ${archetypeId}, got status=${result.status}. observations=${result.observations.join(" | ")}`
      );
    }
    return result;
  }

  /**
   * Tolerant iterator across every pinned managed archetype. Each archetype
   * gets its own fresh fork. Returns an array of per-archetype results with
   * a status discriminator so the caller can decide which assertions to make.
   * Used by the multi-archetype E2E test to discover which archetypes surface
   * a candidate AND realize the predicted rate vs. which are not-yet-supported.
   */
  async function probeManagedRemoveQuoteAcrossAllArchetypes(): Promise<{
    results: TargetedRemoveQuoteProbeResult[];
  }> {
    const results: TargetedRemoveQuoteProbeResult[] = [];
    for (const archetype of EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES) {
      const result = await runTargetedManagedRemoveQuoteProbe(archetype.id);
      results.push(result);
    }
    return { results };
  }

  return {
    inspectAjnaInfoManagedUsedPoolArchetypes,
    findTargetedAjnaInfoManagedUsedPoolInventoryCandidate,
    probeAjnaInfoManagedUsedPoolManualRemoveQuote,
    probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow,
    executeTargetedAjnaInfoManagedUsedPoolRemoveQuote,
    probeManagedRemoveQuoteAcrossAllArchetypes
  };
}

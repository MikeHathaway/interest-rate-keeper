import { parseAbi } from "viem";

import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  erc20Abi,
  resolveKeeperConfig,
  type PlanCandidate,
  type RateMoveOutcome
} from "../../src/index.js";
import { withTemporaryAnvilFork } from "../../src/ajna/anvil-fork.js";
import {
  buildMultiCycleBorrowSearchAmounts,
  resolvePoolAwareBorrowLimitIndexes
} from "../../src/ajna/search-space.js";
import { withPreparedSimulationFork } from "../../src/ajna/snapshot-sim-helpers.js";
import { calculateMaxWithdrawableQuoteAmountFromLp } from "../../src/ajna/snapshot-read.js";
import { fenwickIndexToPriceWad, FORK_TIME_SKIP_SECONDS } from "./base-factory.protocol.js";
import {
  EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES,
  EXPERIMENTAL_PINNED_USED_POOL_UPWARD_ARCHETYPES,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS,
  EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES,
  EXPERIMENTAL_USED_POOL_UPWARD_ARCHETYPES
} from "./base-factory.fixtures.js";
import {
  DEFAULT_ANVIL_PRIVATE_KEY,
  LOCAL_RPC_URL
} from "./base-factory.shared.js";

type CuratorHelperDeps = {
  createExistingBorrowerSameCycleFixture: (...args: any[]) => Promise<`0x${string}` | undefined>;
  createExistingBorrowerMultiBucketFixture: (...args: any[]) => Promise<`0x${string}` | undefined>;
  readCurrentRateInfo: (
    publicClient: any,
    poolAddress: `0x${string}`
  ) => Promise<{ currentRateBps: number; lastInterestRateUpdateTimestamp: number }>;
  advanceAndApplyEligibleUpdatesDirect: (...args: any[]) => Promise<{
    chainNow: number;
    currentRateBps: number;
  }>;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const MAX_PINNED_LENDER_CANDIDATES = 6;
const PINNED_LENDER_LOOKBACK_WINDOWS = [500n, 5_000n, 50_000n] as const;
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
const ERC20_TRANSFER_EVENT_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)"
]);

function formatTokenAmount(amountWad: bigint): string {
  const sign = amountWad < 0n ? "-" : "";
  const absolute = amountWad < 0n ? -amountWad : amountWad;
  const whole = absolute / 10n ** 18n;
  const fractional = absolute % 10n ** 18n;
  const trimmedFractional = fractional.toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");

  return trimmedFractional.length > 0
    ? `${sign}${whole.toString()}.${trimmedFractional}`
    : `${sign}${whole.toString()}`;
}

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

export function createBaseFactoryCuratorHelpers(deps: CuratorHelperDeps) {
  const {
    createExistingBorrowerSameCycleFixture,
    createExistingBorrowerMultiBucketFixture,
    readCurrentRateInfo,
    advanceAndApplyEligibleUpdatesDirect
  } = deps;

  async function findSavedUsedPoolUpwardDualArchetypeMatches(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    artifact: { abi: unknown[]; bytecode: `0x${string}` }
  ): Promise<{
    observations: string[];
    positiveMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      chainNow: number;
      currentRateBps: number;
      targetRateBps: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
    }>;
  }> {
    const observations: string[] = [];
    const positiveMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      chainNow: number;
      currentRateBps: number;
      targetRateBps: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
    }> = [];

    for (const archetype of EXPERIMENTAL_USED_POOL_UPWARD_ARCHETYPES) {
      if (archetype.fixtureKind === "large-used-pool") {
        observations.push(
          `archetype=${archetype.id}: skipped multi-week fixture for single-snapshot dual probe`
        );
        continue;
      }

      const poolAddress =
        archetype.fixtureKind === "existing-borrower"
          ? await createExistingBorrowerSameCycleFixture(
              account,
              publicClient,
              walletClient,
              artifact,
              archetype.scenario
            )
          : await createExistingBorrowerMultiBucketFixture(
              account,
              publicClient,
              walletClient,
              artifact,
              archetype.scenario
            );
      if (!poolAddress) {
        observations.push(`archetype=${archetype.id}: fixture creation failed`);
        continue;
      }

      await testClient.increaseTime({
        seconds: FORK_TIME_SKIP_SECONDS
      });
      await testClient.mine({
        blocks: 1
      });

      try {
        const updateHash = await walletClient.writeContract({
          account,
          chain: undefined,
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "updateInterest"
        });
        await publicClient.waitForTransactionReceipt({ hash: updateHash });
      } catch (error) {
        observations.push(
          `archetype=${archetype.id}: initial updateInterest failed=${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }

      const chainNow = Number((await publicClient.getBlock()).timestamp);
      const [loansInfo, borrowerInfo, currentRateInfo] = await Promise.all([
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "loansInfo",
          args: []
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "borrowerInfo",
          args: [account.address]
        }),
        readCurrentRateInfo(publicClient, poolAddress)
      ]);
      const noOfLoans = loansInfo[2] as bigint;
      const borrowerT0Debt = borrowerInfo[0] as bigint;
      const borrowerCollateral = borrowerInfo[1] as bigint;
      if (noOfLoans === 0n || (borrowerT0Debt === 0n && borrowerCollateral === 0n)) {
        observations.push(`archetype=${archetype.id}: no live borrower remained`);
        continue;
      }

      const targetRateBps = currentRateInfo.currentRateBps + archetype.targetOffsetBps;
      const config = resolveKeeperConfig({
        chainId: 8453,
        poolAddress,
        poolId: `8453:${poolAddress.toLowerCase()}`,
        rpcUrl: LOCAL_RPC_URL,
        targetRateBps,
        toleranceBps: 50,
        toleranceMode: "absolute",
        completionPolicy: "next_move_would_overshoot",
        executionBufferBps: 0,
        maxQuoteTokenExposure: "1000000000000000000000000",
        maxBorrowExposure: "1000000000000000000000",
        snapshotAgeMaxSeconds: 3600,
        minTimeBeforeRateWindowSeconds: 120,
        minExecutableActionQuoteToken: "1",
        recheckBeforeSubmit: true,
        borrowerAddress: account.address,
        simulationSenderAddress: account.address,
        enableSimulationBackedLendSynthesis: true,
        enableSimulationBackedBorrowSynthesis: true,
        enableHeuristicLendSynthesis: false,
        enableHeuristicBorrowSynthesis: false,
        drawDebtLimitIndexes: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES],
        drawDebtCollateralAmounts: [...EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS]
      });
      const snapshot = await new AjnaRpcSnapshotSource(config, {
        publicClient,
        now: () => chainNow
      }).getSnapshot();
      if (
        snapshot.secondsUntilNextRateUpdate <= 0 ||
        snapshot.currentRateBps >= targetRateBps ||
        snapshot.predictedNextOutcome === "STEP_UP"
      ) {
        observations.push(
          `archetype=${archetype.id}: currentRate=${snapshot.currentRateBps} target=${targetRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} next=${snapshot.predictedNextOutcome}`
        );
        continue;
      }

      const dualCandidate = snapshot.candidates.find(
        (candidate) => candidate.intent === "LEND_AND_BORROW"
      );
      observations.push(
        `archetype=${archetype.id}: currentRate=${snapshot.currentRateBps} target=${targetRateBps} secondsUntil=${snapshot.secondsUntilNextRateUpdate} dual=${dualCandidate ? `${dualCandidate.predictedRateBpsAfterNextUpdate}/${dualCandidate.planningRateBps ?? "-"}@${dualCandidate.planningLookaheadUpdates ?? 1}` : "none"}`
      );
      if (!dualCandidate) {
        continue;
      }

      positiveMatches.push({
        archetypeId: archetype.id,
        poolAddress,
        chainNow,
        currentRateBps: snapshot.currentRateBps,
        targetRateBps,
        ...(dualCandidate.planningRateBps === undefined
          ? {}
          : { planningRateBps: dualCandidate.planningRateBps }),
        ...(dualCandidate.planningLookaheadUpdates === undefined
          ? {}
          : { planningLookaheadUpdates: dualCandidate.planningLookaheadUpdates })
      });
    }

    return {
      observations,
      positiveMatches
    };
  }

  async function findPinnedUsedPoolUpwardSimulationMatches(): Promise<{
    observations: string[];
    surfacedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      currentRateBps: number;
      targetRateBps: number;
      candidateIntent: "BORROW" | "LEND_AND_BORROW";
      predictedRateBpsAfterNextUpdate: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
      executionMode?: string;
    }>;
  }> {
    const upstreamRpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
    process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;
    const observations: string[] = [];
    const surfacedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      currentRateBps: number;
      targetRateBps: number;
      candidateIntent: "BORROW" | "LEND_AND_BORROW";
      predictedRateBpsAfterNextUpdate: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
      executionMode?: string;
    }> = [];

    for (const archetype of EXPERIMENTAL_PINNED_USED_POOL_UPWARD_ARCHETYPES) {
      await withTemporaryAnvilFork(
        {
          rpcUrl: upstreamRpcUrl,
          chainId: 8453,
          blockNumber: archetype.blockNumber
        },
        async ({ publicClient, rpcUrl }) => {
          const chainNow = Number((await publicClient.getBlock()).timestamp);
          const config = resolveKeeperConfig({
            chainId: 8453,
            poolAddress: archetype.poolAddress,
            poolId: `8453:${archetype.poolAddress.toLowerCase()}`,
            rpcUrl,
            borrowerAddress: archetype.borrowerAddress,
            simulationSenderAddress: archetype.borrowerAddress,
            targetRateBps: archetype.targetRateBps,
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
            enableManagedInventoryUpwardControl: true,
            enableManagedDualUpwardControl: true,
            enableHeuristicLendSynthesis: false,
            enableHeuristicBorrowSynthesis: false
          });
          const snapshot = await new AjnaRpcSnapshotSource(config, {
            publicClient,
            now: () => chainNow
          }).getSnapshot();
          const upwardCandidates = snapshot.candidates.filter(
            (
              candidate
            ): candidate is PlanCandidate & {
              intent: "BORROW" | "LEND_AND_BORROW";
            } =>
              (candidate.intent === "BORROW" || candidate.intent === "LEND_AND_BORROW") &&
              candidate.candidateSource === "simulation"
          );
          observations.push(
            [
              `archetype=${archetype.id}`,
              `pool=${archetype.poolAddress}`,
              `block=${archetype.blockNumber.toString()}`,
              `current=${snapshot.currentRateBps}`,
              `target=${archetype.targetRateBps}`,
              `secondsUntil=${snapshot.secondsUntilNextRateUpdate}`,
              `next=${snapshot.predictedNextOutcome}`,
              `upward=${upwardCandidates.length === 0 ? "none" : upwardCandidates.map((candidate) => `${candidate.intent}:${candidate.predictedRateBpsAfterNextUpdate}/${candidate.planningRateBps ?? "-"}@${candidate.planningLookaheadUpdates ?? 1}:${candidate.executionMode ?? "-"}`).join(",")}`
            ].join(" ")
          );

          const firstMatch = upwardCandidates[0];
          if (!firstMatch) {
            return;
          }

          surfacedMatches.push({
            archetypeId: archetype.id,
            poolAddress: archetype.poolAddress,
            blockNumber: archetype.blockNumber,
            currentRateBps: snapshot.currentRateBps,
            targetRateBps: archetype.targetRateBps,
            candidateIntent: firstMatch.intent,
            predictedRateBpsAfterNextUpdate: firstMatch.predictedRateBpsAfterNextUpdate,
            ...(firstMatch.planningRateBps === undefined
              ? {}
              : { planningRateBps: firstMatch.planningRateBps }),
            ...(firstMatch.planningLookaheadUpdates === undefined
              ? {}
              : { planningLookaheadUpdates: firstMatch.planningLookaheadUpdates }),
            ...(firstMatch.executionMode === undefined
              ? {}
              : { executionMode: firstMatch.executionMode })
          });
        }
      );
    }

    return {
      observations,
      surfacedMatches
    };
  }

  async function discoverPinnedPoolLenderCandidates(
    publicClient: any,
    poolAddress: `0x${string}`,
    quoteTokenAddress: `0x${string}`,
    blockNumber: bigint,
    borrowerAddress: `0x${string}`
  ): Promise<`0x${string}`[]> {
    const candidates: `0x${string}`[] = [];
    const seen = new Set<string>();

    for (const windowSize of PINNED_LENDER_LOOKBACK_WINDOWS) {
      const fromBlock = blockNumber > windowSize ? blockNumber - windowSize : 0n;
      let logs: any[] = [];

      try {
        logs = await publicClient.getLogs({
          address: quoteTokenAddress,
          event: ERC20_TRANSFER_EVENT_ABI[0],
          args: {
            to: poolAddress
          },
          fromBlock,
          toBlock: blockNumber
        });
      } catch {
        continue;
      }

      for (const log of [...logs].reverse()) {
        const from = log.args?.from as `0x${string}` | undefined;
        if (
          from === undefined ||
          from.toLowerCase() === ZERO_ADDRESS ||
          from.toLowerCase() === poolAddress.toLowerCase() ||
          from.toLowerCase() === borrowerAddress.toLowerCase() ||
          seen.has(from.toLowerCase())
        ) {
          continue;
        }
        seen.add(from.toLowerCase());

        const [code, balance] = await Promise.all([
          publicClient.getCode({
            address: from,
            blockNumber
          }),
          publicClient.readContract({
            address: quoteTokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [from],
            blockNumber
          })
        ]);
        if (code !== "0x" || balance <= 0n) {
          continue;
        }

        candidates.push(from);
        if (candidates.length >= MAX_PINNED_LENDER_CANDIDATES) {
          return candidates;
        }
      }
    }

    return candidates;
  }

  async function findPinnedUsedPoolUpwardPairedDualMatches(): Promise<{
    observations: string[];
    surfacedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      senderAddress: `0x${string}`;
      borrowerAddress: `0x${string}`;
      currentRateBps: number;
      targetRateBps: number;
      predictedRateBpsAfterNextUpdate: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
      executionMode?: string;
    }>;
  }> {
    const upstreamRpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
    process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;
    const observations: string[] = [];
    const surfacedMatches: Array<{
      archetypeId: string;
      poolAddress: `0x${string}`;
      blockNumber: bigint;
      senderAddress: `0x${string}`;
      borrowerAddress: `0x${string}`;
      currentRateBps: number;
      targetRateBps: number;
      predictedRateBpsAfterNextUpdate: number;
      planningRateBps?: number;
      planningLookaheadUpdates?: number;
      executionMode?: string;
    }> = [];

    for (const archetype of EXPERIMENTAL_PINNED_USED_POOL_UPWARD_ARCHETYPES) {
      await withTemporaryAnvilFork(
        {
          rpcUrl: upstreamRpcUrl,
          chainId: 8453,
          blockNumber: archetype.blockNumber
        },
        async ({ publicClient, walletClient, testClient, rpcUrl }) => {
          const quoteTokenAddress = await publicClient.readContract({
            address: archetype.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "quoteTokenAddress"
          });
          const lenderCandidates = await discoverPinnedPoolLenderCandidates(
            publicClient,
            archetype.poolAddress,
            quoteTokenAddress,
            archetype.blockNumber,
            archetype.borrowerAddress
          );
          if (lenderCandidates.length === 0) {
            observations.push(
              `archetype=${archetype.id} pool=${archetype.poolAddress} block=${archetype.blockNumber.toString()} lender=none`
            );
            return;
          }

          for (const senderAddress of lenderCandidates) {
            const senderQuoteBalance = await publicClient.readContract({
              address: quoteTokenAddress,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [senderAddress]
            });
            await testClient.impersonateAccount({
              address: senderAddress
            });
            await testClient.setBalance({
              address: senderAddress,
              value: 10n ** 24n
            });

            try {
              const approveHash = await walletClient.writeContract({
                account: senderAddress,
                chain: undefined,
                address: quoteTokenAddress,
                abi: erc20Abi,
                functionName: "approve",
                args: [archetype.poolAddress, 2n ** 256n - 1n]
              });
              await publicClient.waitForTransactionReceipt({ hash: approveHash });

              const chainNow = Number((await publicClient.getBlock()).timestamp);
              const config = resolveKeeperConfig({
                chainId: 8453,
                poolAddress: archetype.poolAddress,
                poolId: `8453:${archetype.poolAddress.toLowerCase()}`,
                rpcUrl: rpcUrl ?? LOCAL_RPC_URL,
                borrowerAddress: archetype.borrowerAddress,
                simulationSenderAddress: senderAddress,
                targetRateBps: archetype.targetRateBps,
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
              const dualCandidate = snapshot.candidates.find(
                (candidate) =>
                  candidate.intent === "LEND_AND_BORROW" &&
                  candidate.candidateSource === "simulation"
              );
              observations.push(
                [
                  `archetype=${archetype.id}`,
                  `pool=${archetype.poolAddress}`,
                  `block=${archetype.blockNumber.toString()}`,
                  `sender=${senderAddress}`,
                  `borrower=${archetype.borrowerAddress}`,
                  `sender_quote=${formatTokenAmount(senderQuoteBalance)}`,
                  `current=${snapshot.currentRateBps}`,
                  `target=${archetype.targetRateBps}`,
                  `secondsUntil=${snapshot.secondsUntilNextRateUpdate}`,
                  `next=${snapshot.predictedNextOutcome}`,
                  `dual=${dualCandidate ? `${dualCandidate.predictedRateBpsAfterNextUpdate}/${dualCandidate.planningRateBps ?? "-"}@${dualCandidate.planningLookaheadUpdates ?? 1}:${dualCandidate.executionMode ?? "-"}` : "none"}`
                ].join(" ")
              );

              if (!dualCandidate) {
                continue;
              }

              surfacedMatches.push({
                archetypeId: archetype.id,
                poolAddress: archetype.poolAddress,
                blockNumber: archetype.blockNumber,
                senderAddress,
                borrowerAddress: archetype.borrowerAddress,
                currentRateBps: snapshot.currentRateBps,
                targetRateBps: archetype.targetRateBps,
                predictedRateBpsAfterNextUpdate: dualCandidate.predictedRateBpsAfterNextUpdate,
                ...(dualCandidate.planningRateBps === undefined
                  ? {}
                  : { planningRateBps: dualCandidate.planningRateBps }),
                ...(dualCandidate.planningLookaheadUpdates === undefined
                  ? {}
                  : { planningLookaheadUpdates: dualCandidate.planningLookaheadUpdates }),
                ...(dualCandidate.executionMode === undefined
                  ? {}
                  : { executionMode: dualCandidate.executionMode })
              });
              break;
            } finally {
              await testClient.stopImpersonatingAccount({
                address: senderAddress
              });
            }
          }
        }
      );
    }

    return {
      observations,
      surfacedMatches
    };
  }

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
            `noOfLoans=${String(snapshot.metadata?.noOfLoans ?? "unknown")}`,
            `debtEma=${String(snapshot.metadata?.debtEmaWad ?? "unknown")}`,
            `depositEma=${String(snapshot.metadata?.depositEmaWad ?? "unknown")}`,
            `debtColEma=${String(snapshot.metadata?.debtColEmaWad ?? "unknown")}`,
            `lupt0DebtEma=${String(snapshot.metadata?.lupt0DebtEmaWad ?? "unknown")}`,
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

          const passiveBranchId = await testClient.snapshot();
          const passivePath = await advanceAndApplyEligibleUpdatesDirect(
            archetype.senderAddress,
            publicClient,
            walletClient,
            testClient,
            archetype.poolAddress,
            2
          );
          await testClient.revert({ id: passiveBranchId });

          const passiveDistanceToTarget = Math.abs(passivePath.currentRateBps - targetRateBps);
          let bestActiveRateBps: number | undefined;
          let bestRemoveQuoteAmount: bigint | undefined;

          for (const removeQuoteAmount of amountCandidates) {
            const branchId = await testClient.snapshot();

            try {
              const removeQuoteHash = await walletClient.writeContract({
                account: archetype.senderAddress,
                chain: undefined,
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "removeQuoteToken",
                args: [removeQuoteAmount, lenderBucketIndex]
              });
              await publicClient.waitForTransactionReceipt({ hash: removeQuoteHash });

              const activePath = await advanceAndApplyEligibleUpdatesDirect(
                archetype.senderAddress,
                publicClient,
                walletClient,
                testClient,
                archetype.poolAddress,
                2
              );
              const activeDistanceToTarget = Math.abs(activePath.currentRateBps - targetRateBps);

              observations.push(
                [
                  `manual-remove archetype=${archetype.id}`,
                  `amount=${removeQuoteAmount.toString()}`,
                  `passive=${passivePath.currentRateBps}`,
                  `active=${activePath.currentRateBps}`,
                  `passiveDistance=${passiveDistanceToTarget}`,
                  `activeDistance=${activeDistanceToTarget}`
                ].join(" ")
              );

              const bestDistanceToTarget =
                bestActiveRateBps === undefined
                  ? Number.POSITIVE_INFINITY
                  : Math.abs(bestActiveRateBps - targetRateBps);
              if (
                bestActiveRateBps === undefined ||
                activeDistanceToTarget < bestDistanceToTarget ||
                (activeDistanceToTarget === bestDistanceToTarget &&
                  activePath.currentRateBps > bestActiveRateBps)
              ) {
                bestActiveRateBps = activePath.currentRateBps;
                bestRemoveQuoteAmount = removeQuoteAmount;
              }
            } catch (error) {
              observations.push(
                `manual-remove archetype=${archetype.id} amount=${removeQuoteAmount.toString()} error=${error instanceof Error ? error.message : String(error)}`
              );
            } finally {
              await testClient.revert({ id: branchId });
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

          const passiveBranchId = await testClient.snapshot();
          const passivePath = await advanceAndApplyEligibleUpdatesDirect(
            archetype.senderAddress,
            publicClient,
            walletClient,
            testClient,
            archetype.poolAddress,
            2
          );
          await testClient.revert({ id: passiveBranchId });

          const passiveDistanceToTarget = Math.abs(passivePath.currentRateBps - targetRateBps);
          const removeOnlyPathsByAmount = new Map<
            string,
            {
              currentRateBps: number;
              distanceToTargetBps: number;
            }
          >();

          for (const removeQuoteAmount of sampledRemoveQuoteAmounts) {
            const branchId = await testClient.snapshot();

            try {
              const removeQuoteHash = await walletClient.writeContract({
                account: archetype.senderAddress,
                chain: undefined,
                address: archetype.poolAddress,
                abi: ajnaPoolAbi,
                functionName: "removeQuoteToken",
                args: [removeQuoteAmount, lenderBucketIndex]
              });
              await publicClient.waitForTransactionReceipt({ hash: removeQuoteHash });

              const removeOnlyPath = await advanceAndApplyEligibleUpdatesDirect(
                archetype.senderAddress,
                publicClient,
                walletClient,
                testClient,
                archetype.poolAddress,
                2
              );
              const removeOnlyDistanceToTarget = Math.abs(
                removeOnlyPath.currentRateBps - targetRateBps
              );

              removeOnlyPathsByAmount.set(removeQuoteAmount.toString(), {
                currentRateBps: removeOnlyPath.currentRateBps,
                distanceToTargetBps: removeOnlyDistanceToTarget
              });

              observations.push(
                [
                  `manual-dual-remove-only archetype=${archetype.id}`,
                  `remove=${removeQuoteAmount.toString()}`,
                  `passive=${passivePath.currentRateBps}`,
                  `removeOnly=${removeOnlyPath.currentRateBps}`
                ].join(" ")
              );
            } catch (error) {
              observations.push(
                `manual-dual-remove-only archetype=${archetype.id} amount=${removeQuoteAmount.toString()} error=${error instanceof Error ? error.message : String(error)}`
              );
            } finally {
              await testClient.revert({ id: branchId });
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
                const branchId = await testClient.snapshot();

                try {
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

                  const activePath = await advanceAndApplyEligibleUpdatesDirect(
                    archetype.senderAddress,
                    publicClient,
                    walletClient,
                    testClient,
                    archetype.poolAddress,
                    2
                  );
                  const distanceToTargetBps = Math.abs(activePath.currentRateBps - targetRateBps);
                  const removeOnlyPath = removeOnlyPathsByAmount.get(removeQuoteAmount.toString());
                  const removeOnlyDistanceToTarget =
                    removeOnlyPath?.distanceToTargetBps ?? Number.POSITIVE_INFINITY;

                  observations.push(
                    [
                      `manual-dual archetype=${archetype.id}`,
                      `limit=${limitIndex}`,
                      `remove=${removeQuoteAmount.toString()}`,
                      `draw=${drawDebtAmount.toString()}`,
                      `passive=${passivePath.currentRateBps}`,
                      `removeOnly=${removeOnlyPath?.currentRateBps ?? "-"}`,
                      `active=${activePath.currentRateBps}`
                    ].join(" ")
                  );

                  if (
                    activePath.currentRateBps <= passivePath.currentRateBps ||
                    distanceToTargetBps >= passiveDistanceToTarget ||
                    distanceToTargetBps >= removeOnlyDistanceToTarget
                  ) {
                    continue;
                  }

                  limitImproved = true;
                  const currentBestDistance =
                    bestActiveRateBps === undefined
                      ? Number.POSITIVE_INFINITY
                      : Math.abs(bestActiveRateBps - targetRateBps);
                  if (
                    bestActiveRateBps === undefined ||
                    distanceToTargetBps < currentBestDistance ||
                    (distanceToTargetBps === currentBestDistance &&
                      activePath.currentRateBps > bestActiveRateBps)
                  ) {
                    bestActiveRateBps = activePath.currentRateBps;
                    bestRemoveQuoteAmount = removeQuoteAmount;
                    bestDrawDebtAmount = drawDebtAmount;
                    bestLimitIndex = limitIndex;
                  }
                } catch {
                  // ignore non-viable exact branches in the bounded manual probe
                } finally {
                  await testClient.revert({ id: branchId });
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
    findSavedUsedPoolUpwardDualArchetypeMatches,
    findPinnedUsedPoolUpwardSimulationMatches,
    findPinnedUsedPoolUpwardPairedDualMatches,
    inspectAjnaInfoManagedUsedPoolArchetypes,
    findTargetedAjnaInfoManagedUsedPoolInventoryCandidate,
    probeAjnaInfoManagedUsedPoolManualRemoveQuote,
    probeAjnaInfoManagedUsedPoolManualRemoveQuoteAndBorrow
  };
}

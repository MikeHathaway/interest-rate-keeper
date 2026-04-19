import { parseAbi } from "viem";

import {
  AjnaRpcSnapshotSource,
  ajnaPoolAbi,
  erc20Abi,
  resolveKeeperConfig,
  type PlanCandidate
} from "../../../../src/index.js";
import { withTemporaryAnvilFork } from "../../../../src/ajna/dev/anvil-fork.js";
import { FORK_TIME_SKIP_SECONDS } from "./protocol.js";
import {
  EXPERIMENTAL_PINNED_USED_POOL_UPWARD_ARCHETYPES,
  EXPERIMENTAL_USED_POOL_UPWARD_ARCHETYPES
} from "./fixtures.js";
import {
  DEFAULT_ANVIL_PRIVATE_KEY,
  formatTokenAmount,
  LOCAL_RPC_URL
} from "./shared.js";
import type { CuratorHelperDeps } from "./curator-types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const MAX_PINNED_LENDER_CANDIDATES = 6;
const PINNED_LENDER_LOOKBACK_WINDOWS = [500n, 5_000n, 50_000n] as const;
const ERC20_TRANSFER_EVENT_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)"
]);

export function createBaseFactoryCuratorDiscoveryHelpers(deps: CuratorHelperDeps) {
  const {
    createExistingBorrowerSameCycleFixture,
    createExistingBorrowerMultiBucketFixture,
    readCurrentRateInfo
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
        enableHeuristicBorrowSynthesis: false
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

  return {
    findSavedUsedPoolUpwardDualArchetypeMatches,
    findPinnedUsedPoolUpwardSimulationMatches,
    findPinnedUsedPoolUpwardPairedDualMatches
  };
}

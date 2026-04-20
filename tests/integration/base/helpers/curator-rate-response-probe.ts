// Empirical rate-response probe: for a given withdrawal fraction of the
// operator's maxWithdrawable LP on dog/USDC, realise the REMOVE_QUOTE on a
// fresh fork, warp to the next two Ajna rate-update boundaries, and record
// the realized current rate after each update. This tells us directly which
// fractions produce STEP_UP / NO_CHANGE / STEP_DOWN on updates 1 and 2 —
// i.e. where the action-space threshold actually sits — independent of the
// keeper's search grid.

import { ajnaPoolAbi } from "../../../../src/index.js";
import { withTemporaryAnvilFork } from "../../../../src/ajna/dev/anvil-fork.js";
import { EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES } from "./fixtures.js";
import {
  advanceAndApplyEligibleUpdatesDirect,
  DEFAULT_ANVIL_PRIVATE_KEY
} from "./shared.js";

export interface RateResponseRow {
  fractionBps: number;
  withdrawalFraction: number;
  withdrawAmountWad: bigint;
  bucketDepositBeforeWad: bigint;
  bucketDepositAfterRemoveWad: bigint;
  currentRateBpsBefore: number;
  currentRateBpsAfterFirstUpdate: number;
  currentRateBpsAfterSecondUpdate: number;
  firstUpdateMoveBps: number;
  secondUpdateMoveBps: number;
  totalMoveBps: number;
}

export interface RateResponseProbeInput {
  archetypeId: string;
  fractions: readonly number[];
}

export async function probeRateResponseAcrossWithdrawalFractions(
  input: RateResponseProbeInput
): Promise<{
  archetypeId: string;
  bucketIndex: number;
  maxWithdrawableAtStartWad: bigint;
  rows: RateResponseRow[];
}> {
  const archetype = EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES.find(
    (candidate) => candidate.id === input.archetypeId
  );
  if (!archetype) {
    throw new Error(`unknown ajna.info managed archetype: ${input.archetypeId}`);
  }

  const upstreamRpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
  process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

  // Run one reconnaissance fork first to read the operator's actual
  // maxWithdrawable and the bucket's initial state. Each per-fraction trial
  // then spins up its own fresh fork so trials do not contaminate each other.
  const { maxWithdrawableWad, bucketDepositBeforeWad } = await withTemporaryAnvilFork(
    {
      rpcUrl: upstreamRpcUrl,
      chainId: 8453,
      blockNumber: archetype.blockNumber
    },
    async ({ publicClient }) => {
      const [lenderInfo, bucketInfo] = await Promise.all([
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
      const [lenderLp] = lenderInfo as readonly [bigint, bigint];
      const [
        _lpAccumulator,
        _availableCollateral,
        _bankruptcyTime,
        bucketDeposit,
        _bucketScale
      ] = bucketInfo as readonly [bigint, bigint, bigint, bigint, bigint];
      // For dog/USDC the operator owns essentially the entire bucket, so
      // maxWithdrawable ≈ min(lenderLp, bucketDeposit). We use the min for
      // safety; exact LP→deposit conversion depends on the bucket's LP
      // accumulator, but for a 100%-owned bucket the two quantities coincide.
      return {
        maxWithdrawableWad: lenderLp < bucketDeposit ? lenderLp : bucketDeposit,
        bucketDepositBeforeWad: bucketDeposit
      };
    }
  );

  const rows: RateResponseRow[] = [];

  for (const fraction of input.fractions) {
    if (fraction <= 0 || fraction > 1) {
      throw new Error(
        `withdrawal fraction must be in (0, 1]; got ${fraction}`
      );
    }
    const fractionBps = Math.round(fraction * 10_000);
    const withdrawAmountWad =
      (maxWithdrawableWad * BigInt(fractionBps)) / 10_000n;

    const row = await withTemporaryAnvilFork(
      {
        rpcUrl: upstreamRpcUrl,
        chainId: 8453,
        blockNumber: archetype.blockNumber
      },
      async ({ publicClient, walletClient, testClient }) => {
        const rateBefore = await readInterestRateBps(
          publicClient,
          archetype.poolAddress
        );

        await testClient.impersonateAccount({
          address: archetype.senderAddress
        });
        await testClient.setBalance({
          address: archetype.senderAddress,
          value: 10n ** 22n
        });

        await publicClient.waitForTransactionReceipt({
          hash: await walletClient.writeContract({
            account: archetype.senderAddress,
            chain: undefined,
            address: archetype.poolAddress,
            abi: ajnaPoolAbi,
            functionName: "removeQuoteToken",
            args: [withdrawAmountWad, BigInt(archetype.lenderBucketIndex)]
          })
        });

        const bucketInfoAfterRemove = await publicClient.readContract({
          address: archetype.poolAddress,
          abi: ajnaPoolAbi,
          functionName: "bucketInfo",
          args: [BigInt(archetype.lenderBucketIndex)]
        });
        const bucketDepositAfterRemoveWad = bucketInfoAfterRemove[3];

        const firstUpdate = await advanceAndApplyEligibleUpdatesDirect(
          archetype.senderAddress,
          publicClient,
          walletClient,
          testClient,
          archetype.poolAddress,
          1
        );
        const rateAfterFirst = firstUpdate.currentRateBps;

        const secondUpdate = await advanceAndApplyEligibleUpdatesDirect(
          archetype.senderAddress,
          publicClient,
          walletClient,
          testClient,
          archetype.poolAddress,
          1
        );
        const rateAfterSecond = secondUpdate.currentRateBps;

        await testClient.stopImpersonatingAccount({
          address: archetype.senderAddress
        });

        return {
          fractionBps,
          withdrawalFraction: fraction,
          withdrawAmountWad,
          bucketDepositBeforeWad,
          bucketDepositAfterRemoveWad,
          currentRateBpsBefore: rateBefore,
          currentRateBpsAfterFirstUpdate: rateAfterFirst,
          currentRateBpsAfterSecondUpdate: rateAfterSecond,
          firstUpdateMoveBps: rateAfterFirst - rateBefore,
          secondUpdateMoveBps: rateAfterSecond - rateAfterFirst,
          totalMoveBps: rateAfterSecond - rateBefore
        } satisfies RateResponseRow;
      }
    );

    rows.push(row);
  }

  return {
    archetypeId: archetype.id,
    bucketIndex: archetype.lenderBucketIndex,
    maxWithdrawableAtStartWad: maxWithdrawableWad,
    rows
  };
}

async function readInterestRateBps(
  publicClient: any,
  poolAddress: `0x${string}`
): Promise<number> {
  const [rateWad] = (await publicClient.readContract({
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "interestRateInfo"
  })) as readonly [bigint, bigint];
  return Number((rateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n);
}

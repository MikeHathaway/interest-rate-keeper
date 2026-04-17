import { type PublicClient } from "viem";

import { ajnaPoolAbi, erc20Abi } from "./abi.js";
import {
  type AjnaPoolRateSnapshot,
  type AjnaPoolStateRead,
  type SimulationAccountState,
  type SimulationLenderBucketState,
  buildSnapshotFingerprint,
  resolveSimulationBorrowerAddress,
  resolveSimulationSenderAddress
} from "./snapshot-internal.js";
import {
  type AjnaRateState,
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate,
  WAD
} from "./rate-state.js";
import { AJNA_FENWICK_ZERO_INDEX, AJNA_FLOAT_STEP } from "./protocol-constants.js";
import { deriveMeaningfulDepositThresholdFenwickIndex } from "./search-space.js";
import { buildSimulationCacheKey, setBoundedCacheEntry } from "./snapshot-cache.js";
import { type HexAddress, type KeeperConfig } from "../types.js";

const MAX_SIMULATION_ACCOUNT_STATE_CACHE_ENTRIES = 256;

const simulationAccountStateCache = new Map<string, SimulationAccountState>();

interface AjnaPoolImmutableMetadata {
  quoteTokenAddress: HexAddress;
  collateralAddress: HexAddress;
  poolType: number;
  quoteTokenScale: bigint;
}

const poolImmutableMetadataCache = new Map<
  string,
  Promise<AjnaPoolImmutableMetadata>
>();

function poolMetadataCacheKey(publicClient: PublicClient, poolAddress: HexAddress): string {
  // Include chainId if available so test-forks with pool-address reuse do not collide
  const chainId = publicClient.chain?.id ?? "no-chain";
  return `${String(chainId)}:${poolAddress.toLowerCase()}`;
}

async function readAjnaPoolImmutableMetadata(
  publicClient: PublicClient,
  poolAddress: HexAddress
): Promise<AjnaPoolImmutableMetadata> {
  const cacheKey = poolMetadataCacheKey(publicClient, poolAddress);
  const cached = poolImmutableMetadataCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const [quoteTokenAddress, collateralAddress, quoteTokenScale, poolType] =
      await Promise.all([
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "quoteTokenAddress"
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "collateralAddress"
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "quoteTokenScale"
        }),
        publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "poolType"
        })
      ]);
    return { quoteTokenAddress, collateralAddress, quoteTokenScale, poolType };
  })();

  poolImmutableMetadataCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    // Evict failed fetches so later calls can retry
    poolImmutableMetadataCache.delete(cacheKey);
    throw error;
  }
}

export function clearAjnaPoolImmutableMetadataCache(): void {
  poolImmutableMetadataCache.clear();
}

export function clearAjnaSimulationAccountStateCache(): void {
  simulationAccountStateCache.clear();
}

function fenwickIndexToPriceWad(index: number): bigint {
  const bucketIndex = AJNA_FENWICK_ZERO_INDEX - index;
  const price = AJNA_FLOAT_STEP ** bucketIndex;
  return BigInt(Math.round(price * 1e18));
}

export function calculateMaxWithdrawableQuoteAmountFromLp(options: {
  bucketLPAccumulator: bigint;
  availableCollateral: bigint;
  bucketDeposit: bigint;
  lenderLpBalance: bigint;
  bucketPriceWad: bigint;
}): bigint {
  if (
    options.bucketLPAccumulator <= 0n ||
    options.bucketDeposit <= 0n ||
    options.lenderLpBalance <= 0n
  ) {
    return 0n;
  }

  const bucketValue =
    options.bucketDeposit * WAD + options.availableCollateral * options.bucketPriceWad;
  const quoteAmount =
    (bucketValue * options.lenderLpBalance) / (options.bucketLPAccumulator * WAD);

  return quoteAmount > options.bucketDeposit ? options.bucketDeposit : quoteAmount;
}

function serializeLenderBucketStates(states: readonly SimulationLenderBucketState[]): string {
  return states
    .map((state) =>
      [
        state.bucketIndex,
        state.lpBalance.toString(),
        state.depositTime.toString(),
        state.lpAccumulator.toString(),
        state.availableCollateral.toString(),
        state.bankruptcyTime.toString(),
        state.bucketDeposit.toString(),
        state.bucketScale.toString(),
        state.maxWithdrawableQuoteAmount.toString()
      ].join(":")
    )
    .join("|");
}

export async function readAjnaPoolState(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  nowSeconds?: number,
  blockNumber?: bigint,
  borrowerAddress?: HexAddress
): Promise<AjnaPoolStateRead> {
  const block = await publicClient.getBlock(
    blockNumber === undefined ? { blockTag: "latest" } : { blockNumber }
  );
  const effectiveBlockNumber = block.number;
  const effectiveNowSeconds = nowSeconds ?? Number(block.timestamp);

  const [
    immutableMetadata,
    [currentRateWad, interestRateUpdateTimestamp],
    [currentDebtWad, , , t0Debt2ToCollateralWad],
    [debtColEmaWad, lupt0DebtEmaWad, debtEmaWad, depositEmaWad],
    [inflatorWad],
    totalT0Debt,
    totalT0DebtInAuction,
    loansInfo,
    borrowerInfo
  ] = await Promise.all([
    readAjnaPoolImmutableMetadata(publicClient, poolAddress),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "interestRateInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "debtInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "emasInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "inflatorInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "totalT0Debt",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "totalT0DebtInAuction",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "loansInfo",
      blockNumber: effectiveBlockNumber
    }),
    borrowerAddress === undefined
      ? Promise.resolve(undefined)
      : publicClient.readContract({
          address: poolAddress,
          abi: ajnaPoolAbi,
          functionName: "borrowerInfo",
          args: [borrowerAddress],
          blockNumber: effectiveBlockNumber
        })
  ]);
  const { quoteTokenAddress, collateralAddress, quoteTokenScale, poolType } =
    immutableMetadata;

  const rateState: AjnaRateState = {
    currentRateWad,
    currentDebtWad,
    debtEmaWad,
    depositEmaWad,
    debtColEmaWad,
    lupt0DebtEmaWad,
    lastInterestRateUpdateTimestamp: Number(interestRateUpdateTimestamp),
    nowTimestamp: effectiveNowSeconds
  };
  const meaningfulDepositThresholdFenwickIndex = deriveMeaningfulDepositThresholdFenwickIndex(
    inflatorWad,
    totalT0Debt,
    totalT0DebtInAuction,
    t0Debt2ToCollateralWad
  );

  return {
    blockNumber: effectiveBlockNumber,
    blockTimestamp: Number(block.timestamp),
    rateState,
    prediction: forecastAjnaNextEligibleRate(rateState),
    immediatePrediction: classifyAjnaNextRate(rateState),
    inflatorWad,
    totalT0Debt,
    totalT0DebtInAuction,
    t0Debt2ToCollateralWad,
    ...(meaningfulDepositThresholdFenwickIndex === undefined
      ? {}
      : { meaningfulDepositThresholdFenwickIndex }),
    quoteTokenAddress,
    collateralAddress,
    quoteTokenScale,
    poolType,
    ...(borrowerInfo === undefined
      ? {}
      : {
          borrowerState: {
            borrowerAddress: borrowerAddress!,
            t0Debt: borrowerInfo[0],
            collateral: borrowerInfo[1],
            npTpRatio: borrowerInfo[2]
          }
        }),
    loansState: {
      maxBorrower: loansInfo[0] as HexAddress,
      maxT0DebtToCollateral: loansInfo[1],
      noOfLoans: loansInfo[2]
    }
  };
}

/**
 * Lightweight pool read for simulation replay loops.
 * Returns only the fields needed to classify the next rate move and observe rate
 * transitions after a mutating action. Costs 3 readContract calls (interestRateInfo,
 * debtInfo, emasInfo) + 1 getBlock, vs 12 readContract + 1 getBlock for the full
 * readAjnaPoolState. Safe for any caller that only reads `rateState`,
 * `immediatePrediction`, `prediction`, `blockNumber`, or `blockTimestamp`.
 */
export async function readAjnaPoolRateStateOnly(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  nowSeconds?: number,
  blockNumber?: bigint
): Promise<AjnaPoolRateSnapshot> {
  const block = await publicClient.getBlock(
    blockNumber === undefined ? { blockTag: "latest" } : { blockNumber }
  );
  const effectiveBlockNumber = block.number;
  const effectiveNowSeconds = nowSeconds ?? Number(block.timestamp);

  const [
    [currentRateWad, interestRateUpdateTimestamp],
    [currentDebtWad],
    [debtColEmaWad, lupt0DebtEmaWad, debtEmaWad, depositEmaWad]
  ] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "interestRateInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "debtInfo",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "emasInfo",
      blockNumber: effectiveBlockNumber
    })
  ]);

  const rateState: AjnaRateState = {
    currentRateWad,
    currentDebtWad,
    debtEmaWad,
    depositEmaWad,
    debtColEmaWad,
    lupt0DebtEmaWad,
    lastInterestRateUpdateTimestamp: Number(interestRateUpdateTimestamp),
    nowTimestamp: effectiveNowSeconds
  };

  return {
    blockNumber: effectiveBlockNumber,
    blockTimestamp: Number(block.timestamp),
    rateState,
    prediction: forecastAjnaNextEligibleRate(rateState),
    immediatePrediction: classifyAjnaNextRate(rateState)
  };
}

export async function readSimulationAccountState(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    needsQuoteState: boolean;
    needsCollateralState: boolean;
    lenderQuoteBucketIndexes?: number[];
  }
): Promise<SimulationAccountState> {
  const simulationSenderAddress = resolveSimulationSenderAddress(config);
  const borrowerAddress = resolveSimulationBorrowerAddress(config, simulationSenderAddress);
  const lenderQuoteBucketIndexes = Array.from(
    new Set(options.lenderQuoteBucketIndexes ?? [])
  ).sort((left, right) => left - right);
  const snapshotFingerprint = buildSnapshotFingerprint(
    poolAddress,
    readState.blockNumber,
    readState.rateState
  );
  const cacheKey = buildSimulationCacheKey([
    "account-state",
    snapshotFingerprint,
    simulationSenderAddress,
    borrowerAddress,
    options.needsQuoteState ? "quote" : "no-quote",
    options.needsCollateralState ? "collateral" : "no-collateral",
    lenderQuoteBucketIndexes.length === 0
      ? "no-lender-buckets"
      : lenderQuoteBucketIndexes.join(",")
  ]);
  const cached = simulationAccountStateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const [
    quoteTokenBalance,
    quoteTokenAllowance,
    collateralBalance,
    collateralAllowance,
    lenderBucketStates
  ] = await Promise.all([
    options.needsQuoteState
      ? publicClient.readContract({
          address: readState.quoteTokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [simulationSenderAddress],
          blockNumber: readState.blockNumber
        })
      : Promise.resolve(undefined),
    options.needsQuoteState
      ? publicClient.readContract({
          address: readState.quoteTokenAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [simulationSenderAddress, poolAddress],
          blockNumber: readState.blockNumber
        })
      : Promise.resolve(undefined),
    options.needsCollateralState
      ? publicClient.readContract({
          address: readState.collateralAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [simulationSenderAddress],
          blockNumber: readState.blockNumber
        })
      : Promise.resolve(undefined),
    options.needsCollateralState
      ? publicClient.readContract({
          address: readState.collateralAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [simulationSenderAddress, poolAddress],
          blockNumber: readState.blockNumber
        })
      : Promise.resolve(undefined),
    lenderQuoteBucketIndexes.length === 0
      ? Promise.resolve(undefined)
      : Promise.all(
          lenderQuoteBucketIndexes.map(async (bucketIndex) => {
            const [[lpBalance, depositTime], bucketState] = await Promise.all([
              publicClient.readContract({
                address: poolAddress,
                abi: ajnaPoolAbi,
                functionName: "lenderInfo",
                args: [BigInt(bucketIndex), simulationSenderAddress],
                blockNumber: readState.blockNumber
              }),
              publicClient.readContract({
                address: poolAddress,
                abi: ajnaPoolAbi,
                functionName: "bucketInfo",
                args: [BigInt(bucketIndex)],
                blockNumber: readState.blockNumber
              })
            ]);
            const [
              lpAccumulator,
              availableCollateral,
              bankruptcyTime,
              bucketDeposit,
              bucketScale
            ] = bucketState;

            return {
              bucketIndex,
              lpBalance,
              depositTime,
              lpAccumulator,
              availableCollateral,
              bankruptcyTime,
              bucketDeposit,
              bucketScale,
              maxWithdrawableQuoteAmount: calculateMaxWithdrawableQuoteAmountFromLp({
                bucketLPAccumulator: lpAccumulator,
                availableCollateral,
                bucketDeposit,
                lenderLpBalance: lpBalance,
                bucketPriceWad: fenwickIndexToPriceWad(bucketIndex)
              })
            } satisfies SimulationLenderBucketState;
          })
        )
  ]);

  const accountState: SimulationAccountState = {
    simulationSenderAddress,
    borrowerAddress,
    ...(quoteTokenBalance === undefined ? {} : { quoteTokenBalance }),
    ...(quoteTokenAllowance === undefined ? {} : { quoteTokenAllowance }),
    ...(collateralBalance === undefined ? {} : { collateralBalance }),
    ...(collateralAllowance === undefined ? {} : { collateralAllowance }),
    ...(lenderBucketStates === undefined ? {} : { lenderBucketStates }),
    ...(lenderBucketStates === undefined
      ? {}
      : {
          lenderBucketStateSignature: serializeLenderBucketStates(lenderBucketStates)
        })
  };
  setBoundedCacheEntry(
    simulationAccountStateCache,
    cacheKey,
    accountState,
    MAX_SIMULATION_ACCOUNT_STATE_CACHE_ENTRIES
  );
  return accountState;
}

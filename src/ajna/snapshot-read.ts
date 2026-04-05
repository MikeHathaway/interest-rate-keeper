import { type PublicClient } from "viem";

import { ajnaPoolAbi, erc20Abi } from "./abi.js";
import {
  type AjnaPoolStateRead,
  type SimulationAccountState,
  buildSnapshotFingerprint,
  resolveSimulationBorrowerAddress,
  resolveSimulationSenderAddress
} from "./snapshot-internal.js";
import {
  type AjnaRateState,
  classifyAjnaNextRate,
  forecastAjnaNextEligibleRate
} from "./rate-state.js";
import { deriveMeaningfulDepositThresholdFenwickIndex } from "./search-space.js";
import { buildSimulationCacheKey, setBoundedCacheEntry } from "./snapshot-cache.js";
import { type HexAddress, type KeeperConfig } from "../types.js";

const MAX_SIMULATION_ACCOUNT_STATE_CACHE_ENTRIES = 256;

const simulationAccountStateCache = new Map<string, SimulationAccountState>();

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
    [currentRateWad, interestRateUpdateTimestamp],
    [currentDebtWad, , , t0Debt2ToCollateralWad],
    [debtColEmaWad, lupt0DebtEmaWad, debtEmaWad, depositEmaWad],
    [inflatorWad],
    totalT0Debt,
    totalT0DebtInAuction,
    quoteTokenAddress,
    collateralAddress,
    quoteTokenScale,
    poolType,
    loansInfo,
    borrowerInfo
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
      functionName: "quoteTokenAddress",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "collateralAddress",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "quoteTokenScale",
      blockNumber: effectiveBlockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "poolType",
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

export async function readSimulationAccountState(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  readState: AjnaPoolStateRead,
  config: KeeperConfig,
  options: {
    needsQuoteState: boolean;
    needsCollateralState: boolean;
  }
): Promise<SimulationAccountState> {
  const simulationSenderAddress = resolveSimulationSenderAddress(config);
  const borrowerAddress = resolveSimulationBorrowerAddress(config, simulationSenderAddress);
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
    options.needsCollateralState ? "collateral" : "no-collateral"
  ]);
  const cached = simulationAccountStateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const [
    quoteTokenBalance,
    quoteTokenAllowance,
    collateralBalance,
    collateralAllowance
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
      : Promise.resolve(undefined)
  ]);

  const accountState: SimulationAccountState = {
    simulationSenderAddress,
    borrowerAddress,
    ...(quoteTokenBalance === undefined ? {} : { quoteTokenBalance }),
    ...(quoteTokenAllowance === undefined ? {} : { quoteTokenAllowance }),
    ...(collateralBalance === undefined ? {} : { collateralBalance }),
    ...(collateralAllowance === undefined ? {} : { collateralAllowance })
  };
  setBoundedCacheEntry(
    simulationAccountStateCache,
    cacheKey,
    accountState,
    MAX_SIMULATION_ACCOUNT_STATE_CACHE_ENTRIES
  );
  return accountState;
}

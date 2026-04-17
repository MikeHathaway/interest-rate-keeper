import "dotenv/config";

import { createPublicClient, decodeFunctionData, decodeEventLog, http, parseAbi } from "viem";
import { base } from "viem/chains";

const RPC_URL =
  process.env.BASE_LOCAL_ANVIL_URL ?? process.env.BASE_RPC_URL ?? "http://127.0.0.1:9545";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_POOLS = 80;
const ACTOR_POOL_DISCOVERY_LIMIT = 300;
const MAX_MATCHES = 12;
const MAX_LOOKBACK_BLOCKS = 40_000_000n;
const LOG_CHUNK = 200_000n;
const BLOCK_OFFSETS = [0n, 1_000n, 5_000n, 20_000n, 50_000n];
const BORROWER_LENDER_LOOKBACK_WINDOWS = [5_000n, 50_000n, 250_000n, 1_000_000n];
const MAX_MANAGED_BUCKETS = 12;
const MAX_MANAGED_BORROWER_CANDIDATES = 8;
const MAX_POOL_ACTIVITY_TRANSACTIONS = 500;
const FOCUSED_POOL_LOOKBACK_BLOCKS = 6_000_000n;
const FOCUSED_ACTIVITY_CHUNK = 200_000n;
const MAX_FOCUSED_ACTIVITY_TRANSACTIONS = 1_500;
const MAX_FOCUSED_CANDIDATE_BLOCKS = 10;
const CURATED_MANAGED_ACTORS = [
  "0x31aFDdBE7977a82BAbce5b80D0A6B91918A7804b",
  "0x7ba01460ab4829223325d6ed1e8681f7366dF646"
];
const CURATED_ACTOR_LOOKBACK_BLOCKS = 6_000_000n;
const CURATED_ACTOR_MAX_TRANSACTIONS_PER_POOL = 600;
const CURATED_ACTOR_MAX_CANDIDATE_BLOCKS = 8;
const AJNA_INFO_API_BASE = "https://ajna-api.blockanalitica.com";
const AJNA_INFO_POOL_PAGE_LIMIT = 5;
const AJNA_INFO_POOL_PAGE_SIZE = 25;
const AJNA_INFO_POSITIONS_PAGE_SIZE = 200;
const AJNA_INFO_EVENTS_PAGE_SIZE = 50;
const AJNA_INFO_MAX_MANAGED_MATCHES = 12;
const AJNA_INFO_ONLY = process.argv.includes("--ajna-info-only");
const FOCUSED_PINNED_POOLS = [
  {
    id: "pinned-used-pool-ac58",
    poolAddress: "0xAc58D4f94f9b77e47cd59B80b64790Af23cB084b"
  },
  {
    id: "pinned-used-pool-0014",
    poolAddress: "0x0014D130E17197e609fd1509A1366249d0100E77"
  },
  {
    id: "pinned-used-pool-903c",
    poolAddress: "0x903C2E9e9ff3820cAa93AfA4121872CbB280371B"
  }
];
const POOL_CREATED_ABI = [
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { indexed: false, name: "pool_", type: "address" },
      { indexed: false, name: "subsetHash_", type: "bytes32" }
    ],
    anonymous: false
  }
];
const POOL_ABI = parseAbi([
  "function addQuoteToken(uint256, uint256, uint256)",
  "function drawDebt(address, uint256, uint256, uint256)",
  "function interestRateInfo() view returns (uint256, uint256)",
  "function debtInfo() view returns (uint256, uint256, uint256, uint256)",
  "function emasInfo() view returns (uint256, uint256, uint256, uint256)",
  "function inflatorInfo() view returns (uint256, uint256)",
  "function totalT0Debt() view returns (uint256)",
  "function totalT0DebtInAuction() view returns (uint256)",
  "function loansInfo() view returns (address, uint256, uint256)",
  "function borrowerInfo(address) view returns (uint256, uint256, uint256)",
  "function bucketInfo(uint256) view returns (uint256, uint256, uint256, uint256, uint256)",
  "function lenderInfo(uint256, address) view returns (uint256, uint256)"
]);
const FACTORY = "0x214f62B5836D83f3D6c4f71F174209097B1A779C";

function toRateBps(rateWad) {
  return Number((rateWad * 10_000n + 10n ** 17n / 2n) / 10n ** 18n);
}

function wmul(left, right) {
  return (left * right + 500_000_000_000_000_000n) / 1_000_000_000_000_000_000n;
}

function wdiv(left, right) {
  if (right === 0n) {
    return 0n;
  }

  return (left * 1_000_000_000_000_000_000n + right / 2n) / right;
}

function priceToFenwickIndex(priceWad) {
  const price = Number(priceWad) / 1e18;
  if (!Number.isFinite(price) || price <= 0) {
    return undefined;
  }

  const rawIndex = Math.log(price) / Math.log(1.005);
  const ceilIndex = Math.ceil(rawIndex);
  const fenwickIndex =
    rawIndex < 0 && ceilIndex - rawIndex > 0.5 ? 4157 - ceilIndex : 4156 - ceilIndex;

  if (!Number.isFinite(fenwickIndex)) {
    return undefined;
  }

  return Math.max(0, Math.min(7388, fenwickIndex));
}

function fenwickIndexToPriceWad(index) {
  const bucketIndex = 4156 - index;
  const price = 1.005 ** bucketIndex;
  return BigInt(Math.round(price * 1e18));
}

function deriveMeaningfulDepositThresholdFenwickIndex(
  inflatorWad,
  totalT0Debt,
  totalT0DebtInAuction,
  t0Debt2ToCollateralWad
) {
  if (totalT0Debt <= totalT0DebtInAuction) {
    return undefined;
  }

  const nonAuctionedT0Debt = totalT0Debt - totalT0DebtInAuction;
  const dwatpWad = wdiv(
    wmul(wmul(inflatorWad, t0Debt2ToCollateralWad), 1_040_000_000_000_000_000n),
    nonAuctionedT0Debt
  );

  return priceToFenwickIndex(dwatpWad);
}

function calculateMaxWithdrawableQuoteAmountFromLp({
  bucketLPAccumulator,
  availableCollateral,
  bucketDeposit,
  lenderLpBalance,
  bucketPriceWad
}) {
  if (bucketLPAccumulator <= 0n || bucketDeposit <= 0n || lenderLpBalance <= 0n) {
    return 0n;
  }

  const bucketValue =
    bucketDeposit * 1_000_000_000_000_000_000n + availableCollateral * bucketPriceWad;
  const quoteAmount =
    (bucketValue * lenderLpBalance) /
    (bucketLPAccumulator * 1_000_000_000_000_000_000n);

  return quoteAmount > bucketDeposit ? bucketDeposit : quoteAmount;
}

function resolveThresholdBucketIndexes(thresholdIndex) {
  if (thresholdIndex === undefined) {
    return [];
  }

  const offsets = [0, -5, -10, -20, -50, -100, -250, -500, -1000];
  return Array.from(
    new Set(
      offsets
        .map((offset) => thresholdIndex + offset)
        .filter((bucketIndex) => bucketIndex >= 0 && bucketIndex <= 7388)
    )
  ).sort((left, right) => left - right);
}

function secondsUntilNextRateUpdate(rateUpdateTimestamp, nowTimestamp) {
  const elapsed = nowTimestamp - rateUpdateTimestamp;
  const step = 12 * 60 * 60;
  if (elapsed < 0) {
    return 0;
  }
  const remainder = elapsed % step;
  return remainder === 0 ? 0 : step - remainder;
}

function isStrictlyPositiveDecimalString(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  return !/^0+(?:\.0+)?(?:e[+-]?\d+)?$/.test(normalized);
}

function decimalStringMagnitude(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

async function fetchAjnaInfoJson(path, query = {}) {
  const url = new URL(path, AJNA_INFO_API_BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ajna.info request failed: ${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function readPoolState(publicClient, poolAddress, blockNumber, borrowerAddress) {
  const block = await publicClient.getBlock({ blockNumber });
  const [
    [currentRateWad, lastInterestRateUpdateTimestamp],
    [currentDebtWad, , , t0Debt2ToCollateralWad],
    [debtColEmaWad, lupt0DebtEmaWad, debtEmaWad, depositEmaWad],
    [inflatorWad],
    totalT0Debt,
    totalT0DebtInAuction,
    [maxBorrower, , noOfLoans],
    borrowerInfo
  ] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "interestRateInfo",
      blockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "debtInfo",
      blockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "emasInfo",
      blockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "inflatorInfo",
      blockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "totalT0Debt",
      blockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "totalT0DebtInAuction",
      blockNumber
    }),
    publicClient.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: "loansInfo",
      blockNumber
    }),
    borrowerAddress === undefined
      ? Promise.resolve(undefined)
      : publicClient.readContract({
          address: poolAddress,
          abi: POOL_ABI,
          functionName: "borrowerInfo",
          args: [borrowerAddress],
          blockNumber
        })
  ]);

  return {
    poolAddress,
    blockNumber,
    blockTimestamp: Number(block.timestamp),
    currentRateWad,
    currentRateBps: toRateBps(currentRateWad),
    currentDebtWad,
    t0Debt2ToCollateralWad,
    debtColEmaWad,
    lupt0DebtEmaWad,
    debtEmaWad,
    depositEmaWad,
    inflatorWad,
    totalT0Debt,
    totalT0DebtInAuction,
    lastInterestRateUpdateTimestamp: Number(lastInterestRateUpdateTimestamp),
    secondsUntilNextRateUpdate: secondsUntilNextRateUpdate(
      Number(lastInterestRateUpdateTimestamp),
      Number(block.timestamp)
    ),
    maxBorrower,
    noOfLoans,
    borrowerInfo
  };
}

async function listRecentPools(publicClient, limit = MAX_POOLS) {
  const latestBlock = await publicClient.getBlockNumber();
  const seen = new Set();
  const pools = [];

  for (
    let scanned = 0n;
    scanned < MAX_LOOKBACK_BLOCKS && pools.length < limit;
    scanned += LOG_CHUNK
  ) {
    const toBlock = latestBlock > scanned ? latestBlock - scanned : 0n;
    const fromBlock = toBlock > LOG_CHUNK ? toBlock - LOG_CHUNK + 1n : 0n;
    const logs = await publicClient.getLogs({
      address: FACTORY,
      fromBlock,
      toBlock
    });

    const poolAddresses = logs
      .map((log) => {
        try {
          return decodeEventLog({
            abi: POOL_CREATED_ABI,
            data: log.data,
            topics: log.topics
          });
        } catch {
          return undefined;
        }
      })
      .filter((log) => log?.eventName === "PoolCreated")
      .map((log) => log.args.pool_)
      .reverse();

    for (const poolAddress of poolAddresses) {
      const normalized = poolAddress.toLowerCase();
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      pools.push(poolAddress);
      if (pools.length >= limit) {
        break;
      }
    }
  }

  return pools;
}

async function discoverManagedBorrowerCandidates(publicClient, poolAddress, blockNumber) {
  const candidates = new Map();
  const seenTransactions = new Set();

  for (const windowSize of BORROWER_LENDER_LOOKBACK_WINDOWS) {
    const fromBlock = blockNumber > windowSize ? blockNumber - windowSize : 0n;
    let logs = [];

    try {
      logs = await publicClient.getLogs({
        address: poolAddress,
        fromBlock,
        toBlock: blockNumber
      });
    } catch {
      continue;
    }

    for (const log of [...logs].reverse()) {
      if (log.transactionHash === undefined || seenTransactions.has(log.transactionHash)) {
        continue;
      }
      seenTransactions.add(log.transactionHash);
      if (seenTransactions.size > MAX_POOL_ACTIVITY_TRANSACTIONS) {
        break;
      }

      let transaction;
      try {
        transaction = await publicClient.getTransaction({
          hash: log.transactionHash
        });
      } catch {
        continue;
      }

      if (
        transaction.to === undefined ||
        transaction.to.toLowerCase() !== poolAddress.toLowerCase() ||
        transaction.input === undefined ||
        transaction.input === "0x"
      ) {
        continue;
      }

      let decoded;
      try {
        decoded = decodeFunctionData({
          abi: POOL_ABI,
          data: transaction.input
        });
      } catch {
        continue;
      }

      if (decoded.functionName !== "addQuoteToken" && decoded.functionName !== "drawDebt") {
        continue;
      }

      const normalizedSender = transaction.from.toLowerCase();
      const candidate =
        candidates.get(normalizedSender) ?? {
          address: transaction.from,
          sawDrawDebt: false,
          bucketIndexes: new Set()
        };

      if (decoded.functionName === "drawDebt") {
        candidate.sawDrawDebt = true;
      }

      if (decoded.functionName === "addQuoteToken") {
        const bucketIndex = Number(decoded.args[1]);
        if (Number.isInteger(bucketIndex) && bucketIndex >= 0 && bucketIndex <= 7388) {
          candidate.bucketIndexes.add(bucketIndex);
        }
      }

      candidates.set(normalizedSender, candidate);
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.sawDrawDebt && candidate.bucketIndexes.size > 0)
    .sort((left, right) => right.bucketIndexes.size - left.bucketIndexes.size)
    .slice(0, MAX_MANAGED_BORROWER_CANDIDATES)
    .map((candidate) => ({
      address: candidate.address,
      bucketIndexes: [...candidate.bucketIndexes]
        .sort((left, right) => left - right)
        .slice(0, MAX_MANAGED_BUCKETS)
    }));
}

async function discoverFocusedHistoricalManagedMatches(publicClient, latestBlock) {
  const focusedManagedMatches = [];

  for (const focusedPool of FOCUSED_PINNED_POOLS) {
    const candidates = new Map();
    const seenTransactions = new Set();
    const fromBlock =
      latestBlock > FOCUSED_POOL_LOOKBACK_BLOCKS ? latestBlock - FOCUSED_POOL_LOOKBACK_BLOCKS : 0n;

    for (
      let chunkStart = latestBlock;
      chunkStart >= fromBlock && seenTransactions.size < MAX_FOCUSED_ACTIVITY_TRANSACTIONS;
      chunkStart = chunkStart > FOCUSED_ACTIVITY_CHUNK ? chunkStart - FOCUSED_ACTIVITY_CHUNK : 0n
    ) {
      const chunkEnd = chunkStart;
      const chunkFrom = chunkEnd > FOCUSED_ACTIVITY_CHUNK ? chunkEnd - FOCUSED_ACTIVITY_CHUNK + 1n : 0n;
      const boundedChunkFrom = chunkFrom < fromBlock ? fromBlock : chunkFrom;
      let logs = [];

      try {
        logs = await publicClient.getLogs({
          address: focusedPool.poolAddress,
          fromBlock: boundedChunkFrom,
          toBlock: chunkEnd
        });
      } catch {
        continue;
      }

      for (const log of [...logs].reverse()) {
        if (log.transactionHash === undefined || seenTransactions.has(log.transactionHash)) {
          continue;
        }
        seenTransactions.add(log.transactionHash);
        if (seenTransactions.size > MAX_FOCUSED_ACTIVITY_TRANSACTIONS) {
          break;
        }

        let transaction;
        try {
          transaction = await publicClient.getTransaction({
            hash: log.transactionHash
          });
        } catch {
          continue;
        }

        if (
          transaction.to === undefined ||
          transaction.to.toLowerCase() !== focusedPool.poolAddress.toLowerCase() ||
          transaction.input === undefined ||
          transaction.input === "0x"
        ) {
          continue;
        }

        let decoded;
        try {
          decoded = decodeFunctionData({
            abi: POOL_ABI,
            data: transaction.input
          });
        } catch {
          continue;
        }

        if (decoded.functionName !== "addQuoteToken" && decoded.functionName !== "drawDebt") {
          continue;
        }

        const normalizedSender = transaction.from.toLowerCase();
        const candidate =
          candidates.get(normalizedSender) ?? {
            address: transaction.from,
            sawDrawDebt: false,
            bucketIndexes: new Set(),
            candidateBlocks: new Set()
          };

        if (decoded.functionName === "drawDebt") {
          candidate.sawDrawDebt = true;
          candidate.candidateBlocks.add(transaction.blockNumber);
        }

        if (decoded.functionName === "addQuoteToken") {
          const bucketIndex = Number(decoded.args[1]);
          if (Number.isInteger(bucketIndex) && bucketIndex >= 0 && bucketIndex <= 7388) {
            candidate.bucketIndexes.add(bucketIndex);
            candidate.candidateBlocks.add(transaction.blockNumber);
          }
        }

        candidates.set(normalizedSender, candidate);
      }

      if (chunkStart === 0n || boundedChunkFrom === 0n) {
        break;
      }
    }

    const managedCandidates = [...candidates.values()]
      .filter((candidate) => candidate.sawDrawDebt && candidate.bucketIndexes.size > 0)
      .sort(
        (left, right) =>
          right.bucketIndexes.size - left.bucketIndexes.size ||
          right.candidateBlocks.size - left.candidateBlocks.size
      )
      .slice(0, MAX_MANAGED_BORROWER_CANDIDATES);

    for (const candidate of managedCandidates) {
      const candidateBlocks = [...candidate.candidateBlocks]
        .sort((left, right) => Number(right - left))
        .slice(0, MAX_FOCUSED_CANDIDATE_BLOCKS);

      for (const blockNumber of candidateBlocks) {
        let baseState;
        let borrowerState;
        try {
          baseState = await readPoolState(publicClient, focusedPool.poolAddress, blockNumber);
          borrowerState = await readPoolState(
            publicClient,
            focusedPool.poolAddress,
            blockNumber,
            candidate.address
          );
        } catch {
          continue;
        }

        const borrowerInfo = borrowerState.borrowerInfo;
        if (
          !borrowerInfo ||
          baseState.currentDebtWad <= 0n ||
          baseState.depositEmaWad <= 0n ||
          baseState.noOfLoans === 0n ||
          baseState.secondsUntilNextRateUpdate <= 0
        ) {
          continue;
        }

        const [borrowerT0Debt, borrowerCollateral] = borrowerInfo;
        if (borrowerT0Debt <= 0n || borrowerCollateral <= 0n) {
          continue;
        }

        const thresholdIndex = deriveMeaningfulDepositThresholdFenwickIndex(
          borrowerState.inflatorWad,
          borrowerState.totalT0Debt,
          borrowerState.totalT0DebtInAuction,
          borrowerState.t0Debt2ToCollateralWad
        );
        const candidateBucketIndexes = new Set([
          ...resolveThresholdBucketIndexes(thresholdIndex),
          ...candidate.bucketIndexes
        ]);

        for (const bucketIndex of [...candidateBucketIndexes].sort((left, right) => left - right)) {
          try {
            const [[lpBalance], bucketState] = await Promise.all([
              publicClient.readContract({
                address: focusedPool.poolAddress,
                abi: POOL_ABI,
                functionName: "lenderInfo",
                args: [BigInt(bucketIndex), candidate.address],
                blockNumber
              }),
              publicClient.readContract({
                address: focusedPool.poolAddress,
                abi: POOL_ABI,
                functionName: "bucketInfo",
                args: [BigInt(bucketIndex)],
                blockNumber
              })
            ]);
            const [lpAccumulator, availableCollateral, bankruptcyTime, bucketDeposit] = bucketState;
            if (bankruptcyTime !== 0n || lpBalance <= 0n || bucketDeposit <= 0n) {
              continue;
            }

            const maxWithdrawableQuoteAmount = calculateMaxWithdrawableQuoteAmountFromLp({
              bucketLPAccumulator: lpAccumulator,
              availableCollateral,
              bucketDeposit,
              lenderLpBalance: lpBalance,
              bucketPriceWad: fenwickIndexToPriceWad(bucketIndex)
            });
            if (maxWithdrawableQuoteAmount <= 0n) {
              continue;
            }

            focusedManagedMatches.push({
              archetypeId: focusedPool.id,
              poolAddress: focusedPool.poolAddress,
              blockNumber: blockNumber.toString(),
              blockTimestamp: borrowerState.blockTimestamp,
              currentRateBps: borrowerState.currentRateBps,
              targetRateBps: borrowerState.currentRateBps + 100,
              secondsUntilNextRateUpdate: borrowerState.secondsUntilNextRateUpdate,
              noOfLoans: borrowerState.noOfLoans.toString(),
              borrowerAddress: candidate.address,
              managedAddress: candidate.address,
              lenderBucketIndex: bucketIndex,
              thresholdBucketIndex: thresholdIndex,
              candidateBucketIndexes: [...candidateBucketIndexes].sort((left, right) => left - right),
              wasMaxBorrower:
                candidate.address.toLowerCase() === baseState.maxBorrower.toLowerCase(),
              maxWithdrawableQuoteAmount: maxWithdrawableQuoteAmount.toString(),
              borrowerT0Debt: borrowerT0Debt.toString(),
              borrowerCollateral: borrowerCollateral.toString()
            });
            break;
          } catch {
            continue;
          }
        }
      }
    }
  }

  return focusedManagedMatches;
}

async function discoverCuratedActorManagedMatches(publicClient, actorFocusedPools, latestBlock) {
  const curatedActorMatches = [];
  const fromBlock =
    latestBlock > CURATED_ACTOR_LOOKBACK_BLOCKS ? latestBlock - CURATED_ACTOR_LOOKBACK_BLOCKS : 0n;

  for (const actorAddress of CURATED_MANAGED_ACTORS) {
    const pools = actorFocusedPools.get(actorAddress.toLowerCase()) ?? [];
    for (const poolAddress of pools) {
      const candidateBlocks = new Set();
      const bucketIndexes = new Set();
      const seenTransactions = new Set();

      for (
        let chunkStart = latestBlock;
        chunkStart >= fromBlock && seenTransactions.size < CURATED_ACTOR_MAX_TRANSACTIONS_PER_POOL;
        chunkStart = chunkStart > FOCUSED_ACTIVITY_CHUNK ? chunkStart - FOCUSED_ACTIVITY_CHUNK : 0n
      ) {
        const chunkEnd = chunkStart;
        const chunkFrom = chunkEnd > FOCUSED_ACTIVITY_CHUNK ? chunkEnd - FOCUSED_ACTIVITY_CHUNK + 1n : 0n;
        const boundedChunkFrom = chunkFrom < fromBlock ? fromBlock : chunkFrom;
        let logs = [];

        try {
          logs = await publicClient.getLogs({
            address: poolAddress,
            fromBlock: boundedChunkFrom,
            toBlock: chunkEnd
          });
        } catch {
          continue;
        }

        for (const log of [...logs].reverse()) {
          if (log.transactionHash === undefined || seenTransactions.has(log.transactionHash)) {
            continue;
          }
          seenTransactions.add(log.transactionHash);
          if (seenTransactions.size > CURATED_ACTOR_MAX_TRANSACTIONS_PER_POOL) {
            break;
          }

          let transaction;
          try {
            transaction = await publicClient.getTransaction({
              hash: log.transactionHash
            });
          } catch {
            continue;
          }

          if (
            transaction.to === undefined ||
            transaction.to.toLowerCase() !== poolAddress.toLowerCase() ||
            transaction.from.toLowerCase() !== actorAddress.toLowerCase() ||
            transaction.input === undefined ||
            transaction.input === "0x"
          ) {
            continue;
          }

          let decoded;
          try {
            decoded = decodeFunctionData({
              abi: POOL_ABI,
              data: transaction.input
            });
          } catch {
            continue;
          }

          if (decoded.functionName === "drawDebt") {
            candidateBlocks.add(transaction.blockNumber);
          }

          if (decoded.functionName === "addQuoteToken") {
            const bucketIndex = Number(decoded.args[1]);
            if (Number.isInteger(bucketIndex) && bucketIndex >= 0 && bucketIndex <= 7388) {
              bucketIndexes.add(bucketIndex);
              candidateBlocks.add(transaction.blockNumber);
            }
          }
        }

        if (chunkStart === 0n || boundedChunkFrom === 0n) {
          break;
        }
      }

      if (bucketIndexes.size === 0 || candidateBlocks.size === 0) {
        continue;
      }

      const candidateBlockList = [...candidateBlocks]
        .sort((left, right) => Number(right - left))
        .slice(0, CURATED_ACTOR_MAX_CANDIDATE_BLOCKS);
      for (const blockNumber of candidateBlockList) {
        let baseState;
        let borrowerState;
        try {
          baseState = await readPoolState(publicClient, poolAddress, blockNumber);
          borrowerState = await readPoolState(publicClient, poolAddress, blockNumber, actorAddress);
        } catch {
          continue;
        }

        const borrowerInfo = borrowerState.borrowerInfo;
        if (
          !borrowerInfo ||
          baseState.currentDebtWad <= 0n ||
          baseState.depositEmaWad <= 0n ||
          baseState.noOfLoans === 0n ||
          baseState.secondsUntilNextRateUpdate <= 0
        ) {
          continue;
        }

        const [borrowerT0Debt, borrowerCollateral] = borrowerInfo;
        if (borrowerT0Debt <= 0n || borrowerCollateral <= 0n) {
          continue;
        }

        const thresholdIndex = deriveMeaningfulDepositThresholdFenwickIndex(
          borrowerState.inflatorWad,
          borrowerState.totalT0Debt,
          borrowerState.totalT0DebtInAuction,
          borrowerState.t0Debt2ToCollateralWad
        );
        const candidateBucketIndexes = new Set([
          ...resolveThresholdBucketIndexes(thresholdIndex),
          ...bucketIndexes
        ]);

        for (const bucketIndex of [...candidateBucketIndexes].sort((left, right) => left - right)) {
          try {
            const [[lpBalance], bucketState] = await Promise.all([
              publicClient.readContract({
                address: poolAddress,
                abi: POOL_ABI,
                functionName: "lenderInfo",
                args: [BigInt(bucketIndex), actorAddress],
                blockNumber
              }),
              publicClient.readContract({
                address: poolAddress,
                abi: POOL_ABI,
                functionName: "bucketInfo",
                args: [BigInt(bucketIndex)],
                blockNumber
              })
            ]);
            const [lpAccumulator, availableCollateral, bankruptcyTime, bucketDeposit] = bucketState;
            if (bankruptcyTime !== 0n || lpBalance <= 0n || bucketDeposit <= 0n) {
              continue;
            }

            const maxWithdrawableQuoteAmount = calculateMaxWithdrawableQuoteAmountFromLp({
              bucketLPAccumulator: lpAccumulator,
              availableCollateral,
              bucketDeposit,
              lenderLpBalance: lpBalance,
              bucketPriceWad: fenwickIndexToPriceWad(bucketIndex)
            });
            if (maxWithdrawableQuoteAmount <= 0n) {
              continue;
            }

            curatedActorMatches.push({
              actorAddress,
              poolAddress,
              blockNumber: blockNumber.toString(),
              blockTimestamp: borrowerState.blockTimestamp,
              currentRateBps: borrowerState.currentRateBps,
              targetRateBps: borrowerState.currentRateBps + 100,
              secondsUntilNextRateUpdate: borrowerState.secondsUntilNextRateUpdate,
              noOfLoans: borrowerState.noOfLoans.toString(),
              wasMaxBorrower: actorAddress.toLowerCase() === baseState.maxBorrower.toLowerCase(),
              lenderBucketIndex: bucketIndex,
              thresholdBucketIndex: thresholdIndex,
              candidateBucketIndexes: [...candidateBucketIndexes].sort((left, right) => left - right),
              maxWithdrawableQuoteAmount: maxWithdrawableQuoteAmount.toString(),
              borrowerT0Debt: borrowerT0Debt.toString(),
              borrowerCollateral: borrowerCollateral.toString()
            });
            break;
          } catch {
            continue;
          }
        }
      }
    }
  }

  return curatedActorMatches;
}

async function discoverActorFocusedPools(publicClient, latestBlock) {
  const pools = await listRecentPools(publicClient, ACTOR_POOL_DISCOVERY_LIMIT);
  const actorFocusedPools = new Map(
    CURATED_MANAGED_ACTORS.map((actorAddress) => [actorAddress.toLowerCase(), []])
  );

  for (const poolAddress of pools) {
    let loansInfo;
    try {
      loansInfo = await publicClient.readContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: "loansInfo",
        blockNumber: latestBlock
      });
    } catch {
      continue;
    }

    const [maxBorrower] = loansInfo;
    const focusedPools = actorFocusedPools.get(maxBorrower.toLowerCase());
    if (focusedPools !== undefined) {
      focusedPools.push(poolAddress);
    }
  }

  return actorFocusedPools;
}

async function discoverAjnaInfoManagedMatches() {
  const managedMatches = [];
  const seen = new Set();

  for (let page = 1; page <= AJNA_INFO_POOL_PAGE_LIMIT; page += 1) {
    let poolPage;
    try {
      poolPage = await fetchAjnaInfoJson("/v4/base/pools/", {
        p: page,
        p_size: AJNA_INFO_POOL_PAGE_SIZE,
        order: "-tvl"
      });
    } catch {
      continue;
    }

    for (const pool of poolPage.results ?? []) {
      if (!pool?.address || !isStrictlyPositiveDecimalString(pool.debt)) {
        continue;
      }

      let borrowerPositions;
      let depositorPositions;
      try {
        [borrowerPositions, depositorPositions] = await Promise.all([
          fetchAjnaInfoJson(`/v4/base/pools/${pool.address}/positions/`, {
            p: 1,
            p_size: AJNA_INFO_POSITIONS_PAGE_SIZE,
            order: "-debt",
            type: "borrower"
          }),
          fetchAjnaInfoJson(`/v4/base/pools/${pool.address}/positions/`, {
            p: 1,
            p_size: AJNA_INFO_POSITIONS_PAGE_SIZE,
            order: "-supply",
            type: "depositor"
          })
        ]);
      } catch {
        continue;
      }

      const borrowerByAddress = new Map(
        (borrowerPositions.results ?? [])
          .filter((position) => isStrictlyPositiveDecimalString(position.debt))
          .map((position) => [position.wallet_address.toLowerCase(), position])
      );
      const depositorByAddress = new Map(
        (depositorPositions.results ?? [])
          .filter((position) => isStrictlyPositiveDecimalString(position.supply))
          .map((position) => [position.wallet_address.toLowerCase(), position])
      );
      const overlapAddresses = [...borrowerByAddress.keys()].filter((address) =>
        depositorByAddress.has(address)
      );

      for (const overlapAddress of overlapAddresses) {
        const borrowerPosition = borrowerByAddress.get(overlapAddress);
        const depositorPosition = depositorByAddress.get(overlapAddress);
        if (!borrowerPosition || !depositorPosition) {
          continue;
        }

        let poolPosition;
        let bucketPage;
        let eventPage;
        try {
          [poolPosition, bucketPage, eventPage] = await Promise.all([
            fetchAjnaInfoJson(`/v4/base/wallets/${overlapAddress}/pools/${pool.address}/`),
            fetchAjnaInfoJson(`/v4/base/wallets/${overlapAddress}/pools/${pool.address}/buckets/`, {
              p: 1,
              p_size: 50
            }),
            fetchAjnaInfoJson(`/v4/base/wallets/${overlapAddress}/pools/${pool.address}/events/`, {
              p: 1,
              p_size: AJNA_INFO_EVENTS_PAGE_SIZE,
              order: "-order_index"
            })
          ]);
        } catch {
          continue;
        }

        if (
          !isStrictlyPositiveDecimalString(poolPosition.debt) ||
          !isStrictlyPositiveDecimalString(poolPosition.supply)
        ) {
          continue;
        }

        const drawDebtEvent = (eventPage.results ?? []).find((event) => event.name === "DrawDebt");
        const firstBucket = (bucketPage.results ?? []).find((bucket) =>
          isStrictlyPositiveDecimalString(bucket.deposit)
        );
        if (!drawDebtEvent || !firstBucket) {
          continue;
        }

        const key = `${pool.address.toLowerCase()}:${overlapAddress}:${drawDebtEvent.block_number}:${firstBucket.bucket_index}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        managedMatches.push({
          poolAddress: pool.address,
          senderAddress: overlapAddress,
          borrowerAddress: overlapAddress,
          blockNumber: String(drawDebtEvent.block_number),
          lenderBucketIndex: firstBucket.bucket_index,
          currentRateBps: Math.round(Number(pool.borrow_rate ?? 0) * 10_000),
          targetRateBps: Math.round(Number(pool.borrow_rate ?? 0) * 10_000) + 200,
          supply: poolPosition.supply,
          debt: poolPosition.debt,
          collateral: poolPosition.collateral,
          supplyShare: poolPosition.supply_share,
          debtShare: poolPosition.debt_share,
          lenderBucketDeposit: firstBucket.deposit,
          lenderBucketPrice: firstBucket.bucket_price,
          drawDebtBlockNumber: drawDebtEvent.block_number,
          drawDebtTimestamp: drawDebtEvent.block_datetime,
          borrowerFirstActivity: borrowerPosition.first_activity,
          borrowerLastActivity: borrowerPosition.last_activity,
          depositorFirstActivity: depositorPosition.first_activity,
          depositorLastActivity: depositorPosition.last_activity,
          eventNames: (eventPage.results ?? []).map((event) => event.name)
        });

        if (managedMatches.length >= AJNA_INFO_MAX_MANAGED_MATCHES) {
          return managedMatches.sort(
            (left, right) =>
              decimalStringMagnitude(right.debt) +
              decimalStringMagnitude(right.supply) -
              (decimalStringMagnitude(left.debt) + decimalStringMagnitude(left.supply))
          );
        }
      }
    }
  }

  return managedMatches.sort(
    (left, right) =>
      decimalStringMagnitude(right.debt) +
      decimalStringMagnitude(right.supply) -
      (decimalStringMagnitude(left.debt) + decimalStringMagnitude(left.supply))
  );
}

async function main() {
  if (AJNA_INFO_ONLY) {
    const ajnaInfoManagedMatches = await discoverAjnaInfoManagedMatches();
    console.log(
      JSON.stringify(
        {
          mode: "ajna-info-only",
          ajnaInfoManagedMatches
        },
        null,
        2
      )
    );
    return;
  }

  const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL, { batch: true })
  });
  const latestBlock = await publicClient.getBlockNumber();
  const pools = await listRecentPools(publicClient);
  const actorFocusedPools = await discoverActorFocusedPools(publicClient, latestBlock);
  const matches = [];
  const managedMatches = [];
  const focusedManagedMatches = await discoverFocusedHistoricalManagedMatches(
    publicClient,
    latestBlock
  );
  const ajnaInfoManagedMatches = await discoverAjnaInfoManagedMatches();
  const curatedActorManagedMatches = await discoverCuratedActorManagedMatches(
    publicClient,
    actorFocusedPools,
    latestBlock
  );
  const diagnostics = [];

  for (const poolAddress of pools) {
    if (diagnostics.length < 10) {
      try {
        const diagnosticState = await readPoolState(publicClient, poolAddress, latestBlock);
        diagnostics.push({
          poolAddress,
          currentRateBps: diagnosticState.currentRateBps,
          currentDebtWad: diagnosticState.currentDebtWad.toString(),
          depositEmaWad: diagnosticState.depositEmaWad.toString(),
          noOfLoans: diagnosticState.noOfLoans.toString(),
          secondsUntilNextRateUpdate: diagnosticState.secondsUntilNextRateUpdate,
          maxBorrower: diagnosticState.maxBorrower
        });
      } catch (error) {
        diagnostics.push({
          poolAddress,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    for (const offset of BLOCK_OFFSETS) {
      const blockNumber = latestBlock > offset ? latestBlock - offset : 0n;
      try {
        const baseState = await readPoolState(publicClient, poolAddress, blockNumber);
        if (
          baseState.currentDebtWad <= 0n ||
          baseState.depositEmaWad <= 0n ||
          baseState.noOfLoans === 0n ||
          baseState.secondsUntilNextRateUpdate <= 0 ||
          baseState.maxBorrower.toLowerCase() === ZERO_ADDRESS
        ) {
          continue;
        }

        const borrowerState = await readPoolState(
          publicClient,
          poolAddress,
          blockNumber,
          baseState.maxBorrower
        );
        const borrowerInfo = borrowerState.borrowerInfo;
        if (!borrowerInfo) {
          continue;
        }
        const [borrowerT0Debt, borrowerCollateral] = borrowerInfo;
        if (borrowerT0Debt <= 0n || borrowerCollateral <= 0n) {
          continue;
        }
        matches.push({
          poolAddress,
          blockNumber: blockNumber.toString(),
          blockTimestamp: borrowerState.blockTimestamp,
          currentRateBps: borrowerState.currentRateBps,
          targetRateBps: borrowerState.currentRateBps + 100,
          secondsUntilNextRateUpdate: borrowerState.secondsUntilNextRateUpdate,
          noOfLoans: borrowerState.noOfLoans.toString(),
          borrowerAddress: baseState.maxBorrower,
          borrowerT0Debt: borrowerT0Debt.toString(),
          borrowerCollateral: borrowerCollateral.toString()
        });

        const thresholdIndex = deriveMeaningfulDepositThresholdFenwickIndex(
          borrowerState.inflatorWad,
          borrowerState.totalT0Debt,
          borrowerState.totalT0DebtInAuction,
          borrowerState.t0Debt2ToCollateralWad
        );
        const managedBorrowerCandidates = await discoverManagedBorrowerCandidates(
          publicClient,
          poolAddress,
          blockNumber
        ).catch(() => []);

        for (const managedCandidate of managedBorrowerCandidates) {
          let managedBorrowerInfo;
          try {
            managedBorrowerInfo = await publicClient.readContract({
              address: poolAddress,
              abi: POOL_ABI,
              functionName: "borrowerInfo",
              args: [managedCandidate.address],
              blockNumber
            });
          } catch {
            continue;
          }

          const [managedBorrowerT0Debt, managedBorrowerCollateral] = managedBorrowerInfo;
          if (managedBorrowerT0Debt <= 0n || managedBorrowerCollateral <= 0n) {
            continue;
          }

          const managedBucketIndexes = new Set([
            ...resolveThresholdBucketIndexes(thresholdIndex),
            ...managedCandidate.bucketIndexes
          ]);

          for (const bucketIndex of [...managedBucketIndexes].sort((left, right) => left - right)) {
            try {
              const [[lpBalance], bucketState] = await Promise.all([
                publicClient.readContract({
                  address: poolAddress,
                  abi: POOL_ABI,
                  functionName: "lenderInfo",
                  args: [BigInt(bucketIndex), managedCandidate.address],
                  blockNumber
                }),
                publicClient.readContract({
                  address: poolAddress,
                  abi: POOL_ABI,
                  functionName: "bucketInfo",
                  args: [BigInt(bucketIndex)],
                  blockNumber
                })
              ]);
              const [
                lpAccumulator,
                availableCollateral,
                bankruptcyTime,
                bucketDeposit
              ] = bucketState;
              if (bankruptcyTime !== 0n || lpBalance <= 0n || bucketDeposit <= 0n) {
                continue;
              }

              const maxWithdrawableQuoteAmount = calculateMaxWithdrawableQuoteAmountFromLp({
                bucketLPAccumulator: lpAccumulator,
                availableCollateral,
                bucketDeposit,
                lenderLpBalance: lpBalance,
                bucketPriceWad: fenwickIndexToPriceWad(bucketIndex)
              });
              if (maxWithdrawableQuoteAmount <= 0n) {
                continue;
              }

              managedMatches.push({
                poolAddress,
                blockNumber: blockNumber.toString(),
                blockTimestamp: borrowerState.blockTimestamp,
                currentRateBps: borrowerState.currentRateBps,
                targetRateBps: borrowerState.currentRateBps + 100,
                secondsUntilNextRateUpdate: borrowerState.secondsUntilNextRateUpdate,
                noOfLoans: borrowerState.noOfLoans.toString(),
                borrowerAddress: managedCandidate.address,
                managedAddress: managedCandidate.address,
                lenderBucketIndex: bucketIndex,
                thresholdBucketIndex: thresholdIndex,
                candidateBucketIndexes: [...managedBucketIndexes].sort((left, right) => left - right),
                wasMaxBorrower:
                  managedCandidate.address.toLowerCase() === baseState.maxBorrower.toLowerCase(),
                maxWithdrawableQuoteAmount: maxWithdrawableQuoteAmount.toString(),
                borrowerT0Debt: managedBorrowerT0Debt.toString(),
                borrowerCollateral: managedBorrowerCollateral.toString()
              });
              break;
            } catch {
              // ignore unsupported historical bucket/lender reads
            }
          }
        }

        if (matches.length >= MAX_MATCHES) {
          break;
        }
      } catch {
        // Ignore blocks before pool creation or unsupported historical state.
      }
    }

    if (matches.length >= MAX_MATCHES) {
      break;
    }
  }

  console.log(
    JSON.stringify(
      {
        rpcUrl: RPC_URL,
        latestBlock: latestBlock.toString(),
        scannedPoolCount: pools.length,
        firstPools: pools.slice(0, 10),
        actorFocusedPools: Object.fromEntries(actorFocusedPools),
        diagnostics,
        matches,
        managedMatches,
        focusedManagedMatches,
        ajnaInfoManagedMatches,
        curatedActorManagedMatches
      },
      null,
      2
    )
  );
}

await main();

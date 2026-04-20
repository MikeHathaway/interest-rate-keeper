// Mirrors the `ajna-info-only` path of scripts/discover-pinned-used-pools.mjs
// but targets Ethereum mainnet (`/v4/ethereum/` endpoints) instead of Base.
// Outputs the same JSON shape so results can be fed into the existing
// archetype pipeline.
//
// Run: `node scripts/discover-mainnet-managed-archetypes.mjs`

import "dotenv/config";

const AJNA_INFO_API_BASE = "https://ajna-api.blockanalitica.com";
const AJNA_INFO_POOL_PAGE_LIMIT = 6; // mainnet has 232 pools vs base's ~100, scan more pages
const AJNA_INFO_POOL_PAGE_SIZE = 25;
const AJNA_INFO_POSITIONS_PAGE_SIZE = 200;
const AJNA_INFO_EVENTS_PAGE_SIZE = 50;
const AJNA_INFO_MAX_MANAGED_MATCHES = 20;

function isStrictlyPositiveDecimalString(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const cleaned = value.replace(/^[-+]/, "");
  if (!/^\d*\.?\d+$/.test(cleaned)) {
    return false;
  }
  return !/^[-]/.test(value) && !/^0+(\.0+)?$/.test(value);
}

function decimalStringMagnitude(value) {
  if (typeof value !== "string" || value.length === 0) {
    return 0;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchJson(path, params = {}) {
  const url = new URL(path, AJNA_INFO_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ajna-api request failed: ${response.status} ${url}`);
  }
  return response.json();
}

async function discoverMainnetManagedMatches() {
  const managedMatches = [];
  const seen = new Set();
  const diagnostics = {
    poolsScanned: 0,
    poolsWithDebt: 0,
    overlapAddressesFound: 0,
    positionFetchErrors: 0
  };

  for (let page = 1; page <= AJNA_INFO_POOL_PAGE_LIMIT; page += 1) {
    let poolPage;
    try {
      poolPage = await fetchJson("/v4/ethereum/pools/", {
        p: page,
        p_size: AJNA_INFO_POOL_PAGE_SIZE,
        order: "-tvl"
      });
    } catch {
      diagnostics.positionFetchErrors += 1;
      continue;
    }

    for (const pool of poolPage.results ?? []) {
      diagnostics.poolsScanned += 1;
      if (!pool?.address || !isStrictlyPositiveDecimalString(pool.debt)) {
        continue;
      }
      diagnostics.poolsWithDebt += 1;

      let borrowerPositions;
      let depositorPositions;
      try {
        [borrowerPositions, depositorPositions] = await Promise.all([
          fetchJson(`/v4/ethereum/pools/${pool.address}/positions/`, {
            p: 1,
            p_size: AJNA_INFO_POSITIONS_PAGE_SIZE,
            order: "-debt",
            type: "borrower"
          }),
          fetchJson(`/v4/ethereum/pools/${pool.address}/positions/`, {
            p: 1,
            p_size: AJNA_INFO_POSITIONS_PAGE_SIZE,
            order: "-supply",
            type: "depositor"
          })
        ]);
      } catch {
        diagnostics.positionFetchErrors += 1;
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
      diagnostics.overlapAddressesFound += overlapAddresses.length;

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
            fetchJson(`/v4/ethereum/wallets/${overlapAddress}/pools/${pool.address}/`),
            fetchJson(`/v4/ethereum/wallets/${overlapAddress}/pools/${pool.address}/buckets/`, {
              p: 1,
              p_size: 50
            }),
            fetchJson(`/v4/ethereum/wallets/${overlapAddress}/pools/${pool.address}/events/`, {
              p: 1,
              p_size: AJNA_INFO_EVENTS_PAGE_SIZE,
              order: "-order_index"
            })
          ]);
        } catch {
          diagnostics.positionFetchErrors += 1;
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
          poolCollateralSymbol: pool.collateral_token_symbol,
          poolQuoteSymbol: pool.quote_token_symbol,
          poolTvl: pool.tvl,
          eventNames: (eventPage.results ?? []).map((event) => event.name)
        });

        if (managedMatches.length >= AJNA_INFO_MAX_MANAGED_MATCHES) {
          return { managedMatches: sortBySize(managedMatches), diagnostics };
        }
      }
    }
  }

  return { managedMatches: sortBySize(managedMatches), diagnostics };
}

function sortBySize(matches) {
  return matches.sort(
    (left, right) =>
      decimalStringMagnitude(right.debt) +
      decimalStringMagnitude(right.supply) -
      (decimalStringMagnitude(left.debt) + decimalStringMagnitude(left.supply))
  );
}

async function main() {
  const { managedMatches, diagnostics } = await discoverMainnetManagedMatches();
  console.log(
    JSON.stringify(
      {
        chain: "ethereum",
        diagnostics,
        matchCount: managedMatches.length,
        managedMatches
      },
      null,
      2
    )
  );
}

await main();

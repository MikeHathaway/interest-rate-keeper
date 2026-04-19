import { type PublicClient } from "viem";

import { ajnaPoolAbi } from "../adapter/abi.js";
import {
  AJNA_COLLATERALIZATION_FACTOR_WAD,
  MAX_AJNA_LIMIT_INDEX,
  priceToFenwickIndex
} from "../math/protocol-constants.js";
import { wdiv, wmul } from "../math/rate-state.js";
import { type HexAddress, type KeeperConfig } from "../../core/types.js";
const EXACT_BORROW_LIMIT_INDEX_OFFSETS = [-500, -250, 0, 250, 500] as const;
const EXACT_BORROW_PROTOCOL_SAMPLE_POINTS = [
  500,
  1_000,
  1_500,
  2_000,
  2_500,
  3_000,
  3_500,
  4_000,
  5_000,
  6_000,
  7_000
] as const;
const BORROW_BUCKET_PROBE_OFFSETS = [-250, -100, -50, 0, 50, 100, 250] as const;
const PREWINDOW_LEND_BUCKET_OFFSETS = [0, -5, -10, -20, -50, -100, -250, -500, -1_000] as const;
const MAX_SIMULATION_BORROW_COLLATERAL_SAMPLES = 12;

export interface SnapshotWindowState {
  immediatePrediction: {
    secondsUntilNextRateUpdate: number;
  };
  meaningfulDepositThresholdFenwickIndex?: number;
}

function buildThresholdDerivedBucketIndexes(thresholdIndex: number): number[] {
  const resolvedIndexes: number[] = [];
  const seen = new Set<number>();

  for (const offset of PREWINDOW_LEND_BUCKET_OFFSETS) {
    const bucketIndex = thresholdIndex + offset;
    if (bucketIndex < 0 || bucketIndex > MAX_AJNA_LIMIT_INDEX || seen.has(bucketIndex)) {
      continue;
    }

    seen.add(bucketIndex);
    resolvedIndexes.push(bucketIndex);
  }

  return resolvedIndexes;
}

function resolveMinimumCollateralActionAmount(config: KeeperConfig): bigint {
  return config.minExecutableCollateralAmount > 0n
    ? config.minExecutableCollateralAmount
    : 1n;
}

export function resolveDrawDebtLimitIndexes(config: KeeperConfig): number[] {
  const configured = [
    ...(config.drawDebtLimitIndexes ?? []),
    ...(config.drawDebtLimitIndex === undefined ? [] : [config.drawDebtLimitIndex])
  ];

  return Array.from(new Set(configured)).sort((left, right) => left - right);
}

export function resolveAddQuoteBucketIndexes(config: KeeperConfig): number[] {
  const configured = [
    ...(config.addQuoteBucketIndexes ?? []),
    ...(config.addQuoteBucketIndex === undefined ? [] : [config.addQuoteBucketIndex])
  ];

  return Array.from(new Set(configured)).sort((left, right) => left - right);
}

export function resolveRemoveQuoteBucketIndexes(config: KeeperConfig): number[] {
  const configured = [
    ...(config.removeQuoteBucketIndexes ?? []),
    ...(config.removeQuoteBucketIndex === undefined ? [] : [config.removeQuoteBucketIndex])
  ];

  return Array.from(new Set(configured)).sort((left, right) => left - right);
}


export function deriveMeaningfulDepositThresholdFenwickIndex(
  inflatorWad: bigint,
  totalT0Debt: bigint,
  totalT0DebtInAuction: bigint,
  t0Debt2ToCollateralWad: bigint
): number | undefined {
  if (totalT0Debt <= totalT0DebtInAuction) {
    return undefined;
  }

  const nonAuctionedT0Debt = totalT0Debt - totalT0DebtInAuction;
  const dwatpWad = wdiv(
    wmul(wmul(inflatorWad, t0Debt2ToCollateralWad), AJNA_COLLATERALIZATION_FACTOR_WAD),
    nonAuctionedT0Debt
  );

  return priceToFenwickIndex(dwatpWad);
}

export function resolvePreWindowLendBucketIndexes(
  readState: SnapshotWindowState,
  config: KeeperConfig
): number[] {
  const configured = resolveAddQuoteBucketIndexes(config);
  if (readState.immediatePrediction.secondsUntilNextRateUpdate <= 0) {
    return configured;
  }

  if (configured.length > 0) {
    return configured;
  }

  const thresholdIndex = readState.meaningfulDepositThresholdFenwickIndex;
  if (thresholdIndex === undefined) {
    return configured;
  }

  return buildThresholdDerivedBucketIndexes(thresholdIndex);
}

export function resolveProtocolShapedPreWindowDualBucketIndexes(
  readState: SnapshotWindowState,
  config: KeeperConfig
): number[] {
  const configured = resolveAddQuoteBucketIndexes(config);
  if (readState.immediatePrediction.secondsUntilNextRateUpdate <= 0) {
    return configured;
  }

  const thresholdIndex = readState.meaningfulDepositThresholdFenwickIndex;
  if (thresholdIndex === undefined) {
    return configured;
  }

  return Array.from(
    new Set([...configured, ...buildThresholdDerivedBucketIndexes(thresholdIndex)])
  ).sort((left, right) => left - right);
}

export function resolveManagedInventoryBucketIndexes(
  readState: SnapshotWindowState,
  config: KeeperConfig
): number[] {
  const configured = resolveRemoveQuoteBucketIndexes(config);
  if (
    config.enableManagedInventoryUpwardControl !== true &&
    config.enableManagedDualUpwardControl !== true
  ) {
    return configured;
  }

  if (readState.immediatePrediction.secondsUntilNextRateUpdate <= 0) {
    return configured;
  }

  const thresholdIndex = readState.meaningfulDepositThresholdFenwickIndex;
  if (thresholdIndex === undefined) {
    return configured;
  }

  return Array.from(
    new Set([...configured, ...buildThresholdDerivedBucketIndexes(thresholdIndex)])
  ).sort((left, right) => left - right);
}

export function resolveProtocolApproximationBucketIndexes(
  readState: SnapshotWindowState,
  config: KeeperConfig,
  options: {
    borrowLimitIndexes?: number[];
    addQuoteBucketIndexes?: number[];
  } = {}
): number[] {
  const resolvedIndexes = new Set<number>([
    ...resolveProtocolShapedPreWindowDualBucketIndexes(readState, config),
    ...(options.addQuoteBucketIndexes ?? []),
    ...resolveAddQuoteBucketIndexes(config)
  ]);

  for (const seedIndex of options.borrowLimitIndexes ?? resolveDrawDebtLimitIndexes(config)) {
    for (const offset of BORROW_BUCKET_PROBE_OFFSETS) {
      const bucketIndex = seedIndex + offset;
      if (bucketIndex < 0 || bucketIndex > MAX_AJNA_LIMIT_INDEX) {
        continue;
      }

      resolvedIndexes.add(bucketIndex);
    }
  }

  return Array.from(resolvedIndexes).sort((left, right) => left - right);
}

export function resolveDrawDebtCollateralAmounts(config: KeeperConfig): bigint[] {
  const configured = [
    ...(config.drawDebtCollateralAmounts ?? []),
    ...(config.drawDebtCollateralAmount === undefined ? [] : [config.drawDebtCollateralAmount])
  ];

  if (configured.length === 0) {
    return [0n];
  }

  const minimumCollateralAmount = resolveMinimumCollateralActionAmount(config);

  return Array.from(
    new Set(
      configured.filter(
        (collateralAmount) =>
          collateralAmount === 0n || collateralAmount >= minimumCollateralAmount
      )
    )
  ).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function resolveSimulationBorrowLimitIndexes(config: KeeperConfig): number[] {
  const configured = resolveDrawDebtLimitIndexes(config);
  if (configured.length !== 1) {
    return configured;
  }

  const anchor = configured[0]!;

  return Array.from(
    new Set(
      [
        ...EXACT_BORROW_LIMIT_INDEX_OFFSETS.map((offset) => anchor + offset),
        ...EXACT_BORROW_PROTOCOL_SAMPLE_POINTS,
        MAX_AJNA_LIMIT_INDEX
      ].filter((limitIndex) => limitIndex >= 0)
    )
  ).sort((left, right) => left - right);
}

function buildBorrowBucketProbeIndexes(
  config: KeeperConfig,
  additionalSeedIndexes: number[] = []
): number[] {
  const seedIndexes = Array.from(
    new Set([
      ...resolveSimulationBorrowLimitIndexes(config),
      ...resolveAddQuoteBucketIndexes(config),
      ...additionalSeedIndexes
    ])
  );

  return Array.from(
    new Set(
      seedIndexes.flatMap((seedIndex) =>
        BORROW_BUCKET_PROBE_OFFSETS.map((offset) => seedIndex + offset)
      )
    )
  )
    .filter((bucketIndex) => bucketIndex >= 0 && bucketIndex <= MAX_AJNA_LIMIT_INDEX)
    .sort((left, right) => left - right);
}

export async function resolvePoolAwareBorrowLimitIndexes(
  publicClient: PublicClient,
  poolAddress: HexAddress,
  blockNumber: bigint,
  config: KeeperConfig,
  options: {
    seedIndexes?: number[];
  } = {}
): Promise<number[]> {
  const baseIndexes = Array.from(
    new Set([
      ...resolveSimulationBorrowLimitIndexes(config),
      ...(options.seedIndexes ?? [])
    ])
  ).sort((left, right) => left - right);
  const probeIndexes = buildBorrowBucketProbeIndexes(config, options.seedIndexes ?? []);
  if (probeIndexes.length === 0) {
    return baseIndexes;
  }

  const multicallResults = await publicClient.multicall({
    allowFailure: true,
    contracts: probeIndexes.map((bucketIndex) => ({
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "bucketInfo",
      args: [BigInt(bucketIndex)]
    })),
    blockNumber
  });
  const bucketResults = multicallResults.map((result, index) => {
    if (result.status !== "success") {
      return undefined;
    }
    const bucketState = result.result as unknown as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint
    ];
    const [, , bankruptcyTime, bucketDeposit] = bucketState;
    return {
      bucketIndex: probeIndexes[index]!,
      bankruptcyTime,
      bucketDeposit
    };
  });

  const fundedIndexes = bucketResults
    .filter(
      (
        bucket
      ): bucket is {
        bucketIndex: number;
        bankruptcyTime: bigint;
        bucketDeposit: bigint;
      } =>
        bucket !== undefined &&
        bucket.bankruptcyTime === 0n &&
        bucket.bucketDeposit > 0n
    )
    .sort((left, right) => {
      if (left.bucketDeposit !== right.bucketDeposit) {
        return left.bucketDeposit > right.bucketDeposit ? -1 : 1;
      }
      return left.bucketIndex - right.bucketIndex;
    })
    .map((bucket) => bucket.bucketIndex);

  return Array.from(new Set([...fundedIndexes, ...baseIndexes]));
}

export function resolveSimulationBorrowCollateralAmounts(
  config: KeeperConfig,
  maxAvailableCollateral: bigint,
  options: {
    borrowerHasExistingPosition?: boolean;
  } = {}
): bigint[] {
  const configured = resolveDrawDebtCollateralAmounts(config).filter(
    (collateralAmount) => collateralAmount <= maxAvailableCollateral
  );
  if (configured.length === 0) {
    return [];
  }

  if (configured.length !== 1) {
    return Array.from(
      new Set([
        ...(options.borrowerHasExistingPosition ? [0n] : []),
        ...configured
      ])
    ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  const anchor = configured[0]!;
  if (anchor === 0n) {
    return [0n];
  }

  const scaledCandidates = new Set<bigint>([
    anchor / 10n,
    anchor / 5n,
    anchor / 2n,
    anchor,
    anchor * 2n,
    anchor * 5n,
    anchor * 10n
  ]);
  let scaledUp = anchor * 10n;
  while (
    scaledCandidates.size < MAX_SIMULATION_BORROW_COLLATERAL_SAMPLES &&
    scaledUp < maxAvailableCollateral
  ) {
    scaledUp *= 10n;
    scaledCandidates.add(scaledUp);
  }

  return Array.from(
    new Set([
      ...(options.borrowerHasExistingPosition ? [0n] : []),
      ...Array.from(scaledCandidates)
    ])
  )
    .filter(
      (collateralAmount) =>
        collateralAmount >= 0n && collateralAmount <= maxAvailableCollateral
    )
    .sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
}

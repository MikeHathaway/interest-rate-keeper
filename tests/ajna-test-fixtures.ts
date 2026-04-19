import type { KeeperConfig } from "../src/core/types.js";

export const WAD = 1_000_000_000_000_000_000n;

export const baseConfig: KeeperConfig = {
  chainId: 8453,
  poolId: "8453:pool",
  targetRateBps: 900,
  toleranceBps: 50,
  toleranceMode: "relative",
  completionPolicy: "next_move_would_overshoot",
  executionBufferBps: 50,
  maxQuoteTokenExposure: 10n * WAD,
  maxBorrowExposure: 10n * WAD,
  snapshotAgeMaxSeconds: 90,
  minTimeBeforeRateWindowSeconds: 120,
  minExecutableQuoteTokenAmount: 1n,
  minExecutableBorrowAmount: 1n,
  minExecutableCollateralAmount: 1n,
  recheckBeforeSubmit: true,
  allowHeuristicExecution: false,
  addQuoteBucketIndex: 3000,
  addQuoteExpirySeconds: 3600
};

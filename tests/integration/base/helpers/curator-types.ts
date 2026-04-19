export type CuratorHelperDeps = {
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

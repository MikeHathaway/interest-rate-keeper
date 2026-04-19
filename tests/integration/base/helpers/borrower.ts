import { ajnaPoolAbi } from "../../../../src/index.js";
import { FORK_TIME_SKIP_SECONDS } from "./protocol.js";
import { createBaseFactoryBorrowerPreWindowHelpers } from "./borrower-pre-window.js";
import { createBaseFactoryBorrowerSameCycleHelpers } from "./borrower-same-cycle.js";

type BorrowerHelperDeps = {
  createQuoteOnlyBorrowFixture: (...args: any[]) => Promise<`0x${string}`>;
  createQuoteOnlyMultiBucketBorrowFixture: (...args: any[]) => Promise<`0x${string}`>;
  createExistingBorrowerSameCycleFixture: (...args: any[]) => Promise<`0x${string}` | undefined>;
  createExistingBorrowerMultiBucketFixture: (...args: any[]) => Promise<`0x${string}` | undefined>;
};

export function createBaseFactoryBorrowerHelpers(deps: BorrowerHelperDeps) {
  const {
    createQuoteOnlyBorrowFixture,
    createQuoteOnlyMultiBucketBorrowFixture,
    createExistingBorrowerSameCycleFixture,
    createExistingBorrowerMultiBucketFixture
  } = deps;

  async function moveToFirstBorrowLookaheadState(
    account: { address: `0x${string}` },
    publicClient: any,
    walletClient: any,
    testClient: any,
    poolAddress: `0x${string}`
  ): Promise<number> {
    await testClient.increaseTime({
      seconds: FORK_TIME_SKIP_SECONDS
    });
    await testClient.mine({
      blocks: 1
    });

    const updateHash = await walletClient.writeContract({
      account,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "updateInterest"
    });
    await publicClient.waitForTransactionReceipt({ hash: updateHash });

    await testClient.increaseTime({
      seconds: FORK_TIME_SKIP_SECONDS
    });
    await testClient.mine({
      blocks: 1
    });

    return Number((await publicClient.getBlock()).timestamp);
  }

  const preWindowHelpers = createBaseFactoryBorrowerPreWindowHelpers({
    createQuoteOnlyBorrowFixture,
    createExistingBorrowerSameCycleFixture,
    createExistingBorrowerMultiBucketFixture
  });

  const sameCycleHelpers = createBaseFactoryBorrowerSameCycleHelpers({
    createQuoteOnlyBorrowFixture,
    createQuoteOnlyMultiBucketBorrowFixture,
    createExistingBorrowerSameCycleFixture,
    moveToFirstBorrowLookaheadState
  });

  return {
    moveToFirstBorrowLookaheadState,
    ...preWindowHelpers,
    ...sameCycleHelpers
  };
}

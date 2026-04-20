// Synthetic-pool variant of the rate-response probe. For a configurable
// pool shape (base-lender deposit, borrower debts + collaterals, EMA warmup
// cycles, fixed operator ownership fraction, target offset), this helper
// builds a fresh Ajna pool from scratch for each withdrawal fraction trial,
// has the operator remove that fraction of their LP, warps to the next two
// rate-update boundaries, and records the realized rate after each.
//
// Purpose: test whether the ~67% STEP_UP cliff we observed on dog/USDC is
// pool-shape-specific. Run with two different pool shapes and compare cliff
// positions.

import { ajnaPoolAbi } from "../../../../src/index.js";
import {
  advanceAndApplyEligibleUpdatesDirect,
  approveToken,
  deployMockToken,
  deployPoolThroughFactory,
  DEFAULT_ANVIL_PRIVATE_KEY,
  type MockArtifact,
  mintToken
} from "./shared.js";

export interface SyntheticPoolShape {
  label: string;
  baseLenderDepositQuoteToken: bigint;
  debtAmountsQuoteToken: readonly bigint[];
  collateralAmountsCollateralToken: readonly bigint[];
  emaWarmupCycles: number;
  targetBucketIndex: number;
  operatorFraction: number; // 0..1, fraction of target bucket the operator will own
  targetOffsetBps: number;
}

export interface SyntheticRateResponseRow {
  fractionBps: number;
  withdrawalFraction: number;
  withdrawAmountWad: bigint;
  bucketDepositBeforeRemoveWad: bigint;
  bucketDepositAfterRemoveWad: bigint;
  currentRateBpsBefore: number;
  currentRateBpsAfterFirstUpdate: number;
  currentRateBpsAfterSecondUpdate: number;
  firstUpdateMoveBps: number;
  secondUpdateMoveBps: number;
  totalMoveBps: number;
}

export interface SyntheticRateResponseInput {
  account: { address: `0x${string}` };
  publicClient: any;
  walletClient: any;
  testClient: any;
  artifact: MockArtifact;
  poolShape: SyntheticPoolShape;
  withdrawalFractions: readonly number[];
}

const BORROWER_A_ADDRESS =
  "0x00000000000000000000000000000000000000b1" as `0x${string}`;
const BORROWER_B_ADDRESS =
  "0x00000000000000000000000000000000000000b2" as `0x${string}`;
const OPERATOR_ADDRESS =
  "0x0000000000000000000000000000000000000aaa" as `0x${string}`;

async function impersonateWithFunds(params: {
  testClient: any;
  address: `0x${string}`;
}): Promise<void> {
  await params.testClient.impersonateAccount({ address: params.address });
  await params.testClient.setBalance({
    address: params.address,
    value: 10n ** 22n
  });
}

async function mintAndApproveForActor(params: {
  walletClient: any;
  publicClient: any;
  artifact: MockArtifact;
  tokenAddress: `0x${string}`;
  actor: `0x${string}`;
  amount: bigint;
  spender: `0x${string}`;
}): Promise<void> {
  if (params.amount === 0n) {
    return;
  }
  await mintToken(
    params.walletClient,
    params.publicClient,
    params.artifact,
    params.tokenAddress,
    params.actor,
    params.amount
  );
  await params.publicClient.waitForTransactionReceipt({
    hash: await params.walletClient.writeContract({
      account: params.actor,
      chain: undefined,
      address: params.tokenAddress,
      abi: params.artifact.abi,
      functionName: "approve",
      args: [params.spender, 2n ** 255n]
    })
  });
}

async function runOneWithdrawalTrial(
  input: SyntheticRateResponseInput,
  withdrawalFraction: number,
  trialIndex: number
): Promise<SyntheticRateResponseRow> {
  const { account, publicClient, walletClient, testClient, artifact, poolShape } = input;
  process.env.AJNA_KEEPER_PRIVATE_KEY = DEFAULT_ANVIL_PRIVATE_KEY;

  const fractionBps = Math.round(withdrawalFraction * 10_000);

  // Fresh mock tokens + pool per trial so no state leaks between trials.
  const quoteToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    `Rate Response Quote ${poolShape.label} ${trialIndex}`,
    `RRQ${trialIndex}`
  );
  const collateralToken = await deployMockToken(
    walletClient,
    publicClient,
    artifact,
    `Rate Response Collateral ${poolShape.label} ${trialIndex}`,
    `RRC${trialIndex}`
  );

  const baseLenderDepositWad = poolShape.baseLenderDepositQuoteToken * 10n ** 18n;
  const debtAmountsWad = poolShape.debtAmountsQuoteToken.map(
    (amount) => amount * 10n ** 18n
  );
  const collateralAmountsWad = poolShape.collateralAmountsCollateralToken.map(
    (amount) => amount * 10n ** 18n
  );

  await mintToken(
    walletClient,
    publicClient,
    artifact,
    quoteToken,
    account.address,
    baseLenderDepositWad * 100n
  );
  await mintToken(
    walletClient,
    publicClient,
    artifact,
    collateralToken,
    account.address,
    collateralAmountsWad.reduce((acc, amount) => acc + amount, 0n) * 10n
  );

  const poolAddress = await deployPoolThroughFactory(
    walletClient,
    publicClient,
    collateralToken,
    quoteToken
  );

  await approveToken(
    walletClient,
    publicClient,
    quoteToken,
    poolAddress,
    2n ** 255n,
    artifact.abi
  );
  await approveToken(
    walletClient,
    publicClient,
    collateralToken,
    poolAddress,
    2n ** 255n,
    artifact.abi
  );

  // Base lender seeds the target bucket.
  const firstBlock = await publicClient.getBlock();
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "addQuoteToken",
      args: [
        baseLenderDepositWad,
        BigInt(poolShape.targetBucketIndex),
        firstBlock.timestamp + 3600n
      ]
    })
  });

  // Two borrowers → clears the noOfLoans > 1 eligibility gate.
  const borrowerAddresses = [BORROWER_A_ADDRESS, BORROWER_B_ADDRESS];
  for (let i = 0; i < borrowerAddresses.length; i += 1) {
    const borrowerAddress = borrowerAddresses[i]!;
    await impersonateWithFunds({ testClient, address: borrowerAddress });
    await mintAndApproveForActor({
      walletClient,
      publicClient,
      artifact,
      tokenAddress: collateralToken,
      actor: borrowerAddress,
      amount: collateralAmountsWad[i]!,
      spender: poolAddress
    });
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        account: borrowerAddress,
        chain: undefined,
        address: poolAddress,
        abi: ajnaPoolAbi,
        functionName: "drawDebt",
        args: [
          borrowerAddress,
          debtAmountsWad[i]!,
          BigInt(poolShape.targetBucketIndex),
          collateralAmountsWad[i]!
        ]
      })
    });
    await testClient.stopImpersonatingAccount({ address: borrowerAddress });
  }

  // EMA warmup: warp past consecutive 12h rate-update boundaries and call
  // updateInterest each time so debtEma / depositEma / etc become nonzero.
  await advanceAndApplyEligibleUpdatesDirect(
    account,
    publicClient,
    walletClient,
    testClient,
    poolAddress,
    poolShape.emaWarmupCycles
  );

  // Read post-warmup bucket state. Operator deposit sized to hit the target
  // ownership fraction.
  const bucketInfoBeforeOperator = await publicClient.readContract({
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "bucketInfo",
    args: [BigInt(poolShape.targetBucketIndex)]
  });
  const bucketDepositBeforeOperatorWad = bucketInfoBeforeOperator[3];
  const operatorFractionBps = Math.round(poolShape.operatorFraction * 10_000);
  const operatorDepositWad =
    (bucketDepositBeforeOperatorWad * BigInt(operatorFractionBps)) /
    BigInt(10_000 - operatorFractionBps);

  await impersonateWithFunds({ testClient, address: OPERATOR_ADDRESS });
  await mintAndApproveForActor({
    walletClient,
    publicClient,
    artifact,
    tokenAddress: quoteToken,
    actor: OPERATOR_ADDRESS,
    amount: operatorDepositWad,
    spender: poolAddress
  });
  const operatorExpiryBlock = await publicClient.getBlock();
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account: OPERATOR_ADDRESS,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "addQuoteToken",
      args: [
        operatorDepositWad,
        BigInt(poolShape.targetBucketIndex),
        operatorExpiryBlock.timestamp + 3600n
      ]
    })
  });

  // Snapshot pre-REMOVE state so we can size the withdrawal by the
  // operator's current LP and read the rate-before cleanly.
  const rateBefore = await readInterestRateBps(publicClient, poolAddress);
  const [operatorLpAfterDeposit] = (await publicClient.readContract({
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "lenderInfo",
    args: [BigInt(poolShape.targetBucketIndex), OPERATOR_ADDRESS]
  })) as readonly [bigint, bigint];
  const withdrawAmountWad =
    (operatorLpAfterDeposit * BigInt(fractionBps)) / 10_000n;

  const bucketInfoBeforeRemove = await publicClient.readContract({
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "bucketInfo",
    args: [BigInt(poolShape.targetBucketIndex)]
  });
  const bucketDepositBeforeRemoveWad = bucketInfoBeforeRemove[3];

  // Execute the REMOVE_QUOTE at the chosen fraction of operator LP.
  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      account: OPERATOR_ADDRESS,
      chain: undefined,
      address: poolAddress,
      abi: ajnaPoolAbi,
      functionName: "removeQuoteToken",
      args: [withdrawAmountWad, BigInt(poolShape.targetBucketIndex)]
    })
  });

  const bucketInfoAfterRemove = await publicClient.readContract({
    address: poolAddress,
    abi: ajnaPoolAbi,
    functionName: "bucketInfo",
    args: [BigInt(poolShape.targetBucketIndex)]
  });
  const bucketDepositAfterRemoveWad = bucketInfoAfterRemove[3];

  const firstUpdate = await advanceAndApplyEligibleUpdatesDirect(
    account,
    publicClient,
    walletClient,
    testClient,
    poolAddress,
    1
  );
  const rateAfterFirst = firstUpdate.currentRateBps;

  const secondUpdate = await advanceAndApplyEligibleUpdatesDirect(
    account,
    publicClient,
    walletClient,
    testClient,
    poolAddress,
    1
  );
  const rateAfterSecond = secondUpdate.currentRateBps;

  await testClient.stopImpersonatingAccount({ address: OPERATOR_ADDRESS });

  return {
    fractionBps,
    withdrawalFraction,
    withdrawAmountWad,
    bucketDepositBeforeRemoveWad,
    bucketDepositAfterRemoveWad,
    currentRateBpsBefore: rateBefore,
    currentRateBpsAfterFirstUpdate: rateAfterFirst,
    currentRateBpsAfterSecondUpdate: rateAfterSecond,
    firstUpdateMoveBps: rateAfterFirst - rateBefore,
    secondUpdateMoveBps: rateAfterSecond - rateAfterFirst,
    totalMoveBps: rateAfterSecond - rateBefore
  };
}

export async function probeRateResponseOnSyntheticPool(
  input: SyntheticRateResponseInput
): Promise<{
  shape: SyntheticPoolShape;
  rows: SyntheticRateResponseRow[];
}> {
  const rows: SyntheticRateResponseRow[] = [];
  let trialIndex = 0;
  for (const fraction of input.withdrawalFractions) {
    if (fraction <= 0 || fraction > 1) {
      throw new Error(
        `withdrawal fraction must be in (0, 1]; got ${fraction}`
      );
    }
    const row = await runOneWithdrawalTrial(input, fraction, trialIndex);
    rows.push(row);
    trialIndex += 1;
  }
  return { shape: input.poolShape, rows };
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

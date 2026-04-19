export const STEERING_BUCKET_CANDIDATES = [2500, 2750, 3000, 3250, 3500] as const;
export const BORROW_COLLATERAL_CANDIDATES = [1n, 2n, 5n, 10n, 20n, 50n, 100n] as const;

export const DETERMINISTIC_PREWINDOW_LEND_SCENARIO_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

export const EXPERIMENTAL_COMPLEX_PREWINDOW_LEND_SCENARIOS = [
  {
    initialQuoteAmount: 1_000n,
    initialBorrowAmount: 850n,
    initialCollateralAmount: 1_500n,
    competingQuoteAmount: 150n,
    competingBorrowAmount: 125n,
    competingCollateralAmount: 300n,
    primaryFollowupQuoteAmount: 0n,
    competingFollowupBorrowAmount: 0n
  },
  {
    initialQuoteAmount: 1_000n,
    initialBorrowAmount: 950n,
    initialCollateralAmount: 2_000n,
    competingQuoteAmount: 200n,
    competingBorrowAmount: 175n,
    competingCollateralAmount: 400n,
    primaryFollowupQuoteAmount: 50n,
    competingFollowupBorrowAmount: 0n
  },
  {
    initialQuoteAmount: 750n,
    initialBorrowAmount: 650n,
    initialCollateralAmount: 1_000n,
    competingQuoteAmount: 250n,
    competingBorrowAmount: 220n,
    competingCollateralAmount: 500n,
    primaryFollowupQuoteAmount: 0n,
    competingFollowupBorrowAmount: 50n
  },
  {
    initialQuoteAmount: 1_000n,
    initialBorrowAmount: 900n,
    initialCollateralAmount: 1_500n,
    competingQuoteAmount: 300n,
    competingBorrowAmount: 250n,
    competingCollateralAmount: 600n,
    primaryFollowupQuoteAmount: 100n,
    competingFollowupBorrowAmount: 75n
  }
] as const;

export const EXPERIMENTAL_COMPLEX_PREWINDOW_TARGETS = [750, 800, 850, 900] as const;
export const EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_TARGET_OFFSETS_BPS = [50, 100, 150] as const;
export const EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_AMOUNTS_WAD = [
  10n ** 17n,
  5n * 10n ** 17n,
  10n ** 18n,
  2n * 10n ** 18n,
  5n * 10n ** 18n,
  10n * 10n ** 18n,
  20n * 10n ** 18n,
  50n * 10n ** 18n,
  100n * 10n ** 18n
] as const;
export const EXPERIMENTAL_COMPLEX_PREWINDOW_BORROW_LOOKAHEAD_UPDATES = [2, 3] as const;

export const EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_LIMIT_INDEXES = [
  2750, 3000, 3250
] as const;
export const EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_COLLATERAL_AMOUNTS = ["0"] as const;
export const EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_AMOUNTS_WAD = [
  5n * 10n ** 17n,
  10n ** 18n,
  2n * 10n ** 18n,
  5n * 10n ** 18n,
  10n * 10n ** 18n
] as const;
export const EXPERIMENTAL_MANUAL_PREWINDOW_EXISTING_BORROW_TARGET_OFFSETS_BPS = [
  50, 100
] as const;

export const EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_EXISTING_SCENARIOS = [
  { initialQuoteAmount: 750n, borrowAmount: 600n, collateralAmount: 1_500n },
  { initialQuoteAmount: 750n, borrowAmount: 650n, collateralAmount: 1_500n },
  { initialQuoteAmount: 750n, borrowAmount: 700n, collateralAmount: 2_000n },
  { initialQuoteAmount: 1_000n, borrowAmount: 750n, collateralAmount: 2_000n },
  { initialQuoteAmount: 1_000n, borrowAmount: 850n, collateralAmount: 2_200n },
  { initialQuoteAmount: 1_000n, borrowAmount: 900n, collateralAmount: 2_500n },
  { initialQuoteAmount: 1_500n, borrowAmount: 1_200n, collateralAmount: 3_000n },
  { initialQuoteAmount: 2_000n, borrowAmount: 1_700n, collateralAmount: 4_000n }
] as const;
export const EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_LIMIT_INDEXES = [
  2750, 3000, 3250
] as const;
export const EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_COLLATERAL_AMOUNTS = [
  "0",
  "1000000000000000000"
] as const;
export const EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_BORROW_AMOUNTS_WAD = [
  10n ** 17n,
  25n * 10n ** 16n,
  5n * 10n ** 17n,
  10n ** 18n,
  2n * 10n ** 18n,
  5n * 10n ** 18n,
  10n * 10n ** 18n,
  20n * 10n ** 18n,
  50n * 10n ** 18n
] as const;

export const REPRESENTATIVE_LEND_AND_DUAL_FIXTURE_MANIFEST = {
  borrowedStepUpScenarios: [
    { initialQuoteAmount: 500n, borrowAmount: 400n, collateralAmount: 600n },
    { initialQuoteAmount: 500n, borrowAmount: 450n, collateralAmount: 800n },
    { initialQuoteAmount: 500n, borrowAmount: 490n, collateralAmount: 1_000n },
    { initialQuoteAmount: 750n, borrowAmount: 650n, collateralAmount: 1_000n },
    { initialQuoteAmount: 1_000n, borrowAmount: 850n, collateralAmount: 1_200n },
    { initialQuoteAmount: 1_000n, borrowAmount: 950n, collateralAmount: 1_500n },
    { initialQuoteAmount: 1_000n, borrowAmount: 990n, collateralAmount: 2_000n }
  ],
  dualSearch: {
    targetOffsetsBps: [50, 100] as const,
    tolerancesBps: [25] as const,
    lookaheadUpdates: [1, 3] as const,
    collateralAmounts: [10n * 10n ** 18n] as const
  }
} as const;

export const REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_SCENARIOS = [
  { initialQuoteAmount: 1_000n, borrowAmount: 100n, collateralAmount: 1_000n },
  { initialQuoteAmount: 1_000n, borrowAmount: 250n, collateralAmount: 1_000n },
  { initialQuoteAmount: 2_000n, borrowAmount: 150n, collateralAmount: 1_200n },
  { initialQuoteAmount: 2_000n, borrowAmount: 400n, collateralAmount: 1_500n }
] as const;

export const EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_SCENARIOS = [
  { initialQuoteAmount: 500n, borrowAmount: 450n, collateralAmount: 1_000n },
  { initialQuoteAmount: 750n, borrowAmount: 700n, collateralAmount: 1_200n },
  { initialQuoteAmount: 1_000n, borrowAmount: 950n, collateralAmount: 1_500n }
] as const;

export const EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_SCENARIOS = [
  { initialQuoteAmount: 1_000n, borrowAmount: 100n, collateralAmount: 1_000n },
  { initialQuoteAmount: 1_000n, borrowAmount: 250n, collateralAmount: 1_000n },
  { initialQuoteAmount: 2_000n, borrowAmount: 150n, collateralAmount: 1_200n },
  { initialQuoteAmount: 2_000n, borrowAmount: 400n, collateralAmount: 1_500n }
] as const;
export const EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_TARGET_OFFSETS_BPS = [
  50, 100, 150
] as const;
export const EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_LIMIT_INDEXES = [
  2500, 2750, 3000, 3250, 3500
] as const;
export const EXPERIMENTAL_PREWINDOW_EXISTING_BORROWER_COLLATERAL_AMOUNTS = [
  "0",
  "1000000000000000000",
  "5000000000000000000"
] as const;

export const EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROWER_SCENARIOS = [
  {
    deposits: [
      { amount: 100n, bucketIndex: 3000 },
      { amount: 900n, bucketIndex: 3250 }
    ] as const,
    borrowAmount: 700n,
    collateralAmount: 1_500n
  },
  {
    deposits: [
      { amount: 50n, bucketIndex: 3000 },
      { amount: 950n, bucketIndex: 3250 }
    ] as const,
    borrowAmount: 750n,
    collateralAmount: 1_600n
  },
  {
    deposits: [
      { amount: 100n, bucketIndex: 3000 },
      { amount: 900n, bucketIndex: 3500 }
    ] as const,
    borrowAmount: 700n,
    collateralAmount: 1_500n
  },
  {
    deposits: [
      { amount: 100n, bucketIndex: 2750 },
      { amount: 900n, bucketIndex: 3000 }
    ] as const,
    borrowAmount: 650n,
    collateralAmount: 1_400n
  }
] as const;
export const EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_TARGET_OFFSETS_BPS = [
  50, 100
] as const;
export const EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_LIMIT_INDEXES = [
  3000, 3250, 3500
] as const;
export const EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_COLLATERAL_AMOUNTS = [
  "0",
  "1000000000000000000"
] as const;
export const EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROW_AMOUNTS_WAD = [
  5n * 10n ** 17n,
  10n ** 18n,
  2n * 10n ** 18n,
  5n * 10n ** 18n,
  10n * 10n ** 18n,
  20n * 10n ** 18n
] as const;

export const EXPERIMENTAL_BOUNDARY_TARGETED_BORROWER_SCENARIOS = [
  { initialQuoteAmount: 750n, borrowAmount: 700n, collateralAmount: 2_000n },
  { initialQuoteAmount: 1_000n, borrowAmount: 900n, collateralAmount: 2_500n },
  { initialQuoteAmount: 2_000n, borrowAmount: 1_700n, collateralAmount: 4_000n }
] as const;

export const REPRESENTATIVE_EXISTING_BORROWER_SAME_CYCLE_CONFIG_CANDIDATES = [
  {
    targetRateBps: 950,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2750, 3000, 3250] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "10000000000000000000"] as const
  },
  {
    targetRateBps: 1000,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2750, 3000, 3250] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "10000000000000000000"] as const
  },
  {
    targetRateBps: 1050,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2750, 3000, 3250] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "10000000000000000000"] as const
  },
  {
    targetRateBps: 1100,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2750, 3000, 3250] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "10000000000000000000"] as const
  }
] as const;

export const EXPERIMENTAL_BORROWER_HEAVY_EXISTING_BORROWER_CONFIG_CANDIDATES = [
  {
    targetRateBps: 950,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2500, 2750, 3000, 3250, 3500] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "5000000000000000000"] as const
  },
  {
    targetRateBps: 1000,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2500, 2750, 3000, 3250, 3500] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "5000000000000000000"] as const
  },
  {
    targetRateBps: 1050,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2500, 2750, 3000, 3250, 3500] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "5000000000000000000"] as const
  },
  {
    targetRateBps: 1100,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2500, 2750, 3000, 3250, 3500] as const,
    drawDebtCollateralAmounts: ["0", "1000000000000000000", "5000000000000000000"] as const
  }
] as const;

export const EXPERIMENTAL_MANUAL_SAME_CYCLE_BORROW_AMOUNTS_WAD = [
  10n ** 16n,
  5n * 10n ** 16n,
  10n ** 17n,
  25n * 10n ** 16n,
  5n * 10n ** 17n,
  10n ** 18n,
  2n * 10n ** 18n,
  5n * 10n ** 18n,
  10n * 10n ** 18n,
  20n * 10n ** 18n,
  50n * 10n ** 18n,
  100n * 10n ** 18n,
  200n * 10n ** 18n,
  500n * 10n ** 18n,
  1_000n * 10n ** 18n
] as const;

export const EXPERIMENTAL_MANUAL_BRAND_NEW_SAME_CYCLE_CONFIG_CANDIDATES = [
  {
    targetRateBps: 850,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2000, 2500, 2750, 3000, 3250, 3500, 4000] as const,
    drawDebtCollateralAmounts: [
      "10000000000000000",
      "50000000000000000",
      "100000000000000000",
      "500000000000000000",
      "1000000000000000000",
      "5000000000000000000",
      "10000000000000000000"
    ] as const
  },
  {
    targetRateBps: 900,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2000, 2500, 2750, 3000, 3250, 3500, 4000] as const,
    drawDebtCollateralAmounts: [
      "10000000000000000",
      "50000000000000000",
      "100000000000000000",
      "500000000000000000",
      "1000000000000000000",
      "5000000000000000000",
      "10000000000000000000"
    ] as const
  },
  {
    targetRateBps: 950,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2000, 2500, 2750, 3000, 3250, 3500, 4000] as const,
    drawDebtCollateralAmounts: [
      "10000000000000000",
      "50000000000000000",
      "100000000000000000",
      "500000000000000000",
      "1000000000000000000",
      "5000000000000000000",
      "10000000000000000000"
    ] as const
  },
  {
    targetRateBps: 1000,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2000, 2500, 2750, 3000, 3250, 3500, 4000] as const,
    drawDebtCollateralAmounts: [
      "10000000000000000",
      "50000000000000000",
      "100000000000000000",
      "500000000000000000",
      "1000000000000000000",
      "5000000000000000000",
      "10000000000000000000"
    ] as const
  },
  {
    targetRateBps: 1050,
    toleranceBps: 50,
    toleranceMode: "absolute" as const,
    drawDebtLimitIndexes: [2000, 2500, 2750, 3000, 3250, 3500, 4000] as const,
    drawDebtCollateralAmounts: [
      "10000000000000000",
      "50000000000000000",
      "100000000000000000",
      "500000000000000000",
      "1000000000000000000",
      "5000000000000000000",
      "10000000000000000000"
    ] as const
  }
] as const;

export const EXPERIMENTAL_BOUNDARY_TARGETED_SAME_CYCLE_LIMIT_INDEXES = [
  2750,
  3000,
  3250,
  3500
] as const;
export const EXPERIMENTAL_BOUNDARY_TARGETED_SAME_CYCLE_COLLATERAL_AMOUNTS_WAD = [
  0n,
  10n ** 16n,
  10n ** 17n,
  10n ** 18n
] as const;
export const EXPERIMENTAL_BOUNDARY_TARGETED_PASSIVE_CYCLES = [0, 1, 2] as const;

export const REPRESENTATIVE_MULTI_CYCLE_BORROW_CONFIG = {
  targetRateBps: 1300,
  toleranceBps: 50,
  lookaheadUpdates: 3
} as const;

export const EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE = {
  targetRateBps: 1300,
  toleranceBps: 50,
  cycleCount: 2,
  initialDeposits: [
    { actor: "operator", amount: 1_000n, bucketIndex: 3000 },
    { actor: "lenderA", amount: 250n, bucketIndex: 3000 },
    { actor: "lenderA", amount: 250n, bucketIndex: 3250 },
    { actor: "lenderB", amount: 250n, bucketIndex: 3500 },
    { actor: "lenderC", amount: 250n, bucketIndex: 2750 }
  ] as const,
  initialBorrows: [
    { actor: "operator", amount: 10n, limitIndex: 3000, collateralAmount: 300n },
    { actor: "borrowerA", amount: 10n, limitIndex: 3000, collateralAmount: 300n },
    { actor: "borrowerB", amount: 10n, limitIndex: 3000, collateralAmount: 300n }
  ] as const,
  cycleActionPatterns: [
    [
      { actor: "lenderA", type: "ADD_QUOTE", bucketIndex: 3250, amount: 25n },
      { actor: "borrowerA", type: "DRAW_DEBT", limitIndex: 3000, amount: 5n, collateralAmount: 0n }
    ],
    [
      { actor: "lenderB", type: "ADD_QUOTE", bucketIndex: 3500, amount: 20n },
      { actor: "borrowerB", type: "DRAW_DEBT", limitIndex: 3000, amount: 5n, collateralAmount: 0n }
    ],
    [
      { actor: "lenderC", type: "ADD_QUOTE", bucketIndex: 2750, amount: 20n },
      { actor: "borrowerA", type: "DRAW_DEBT", limitIndex: 3000, amount: 5n, collateralAmount: 0n }
    ],
    [
      { actor: "lenderA", type: "ADD_QUOTE", bucketIndex: 3000, amount: 20n },
      { actor: "borrowerB", type: "DRAW_DEBT", limitIndex: 3000, amount: 5n, collateralAmount: 0n }
    ]
  ] as const
} as const;

export const EXPERIMENTAL_USED_POOL_UPWARD_ARCHETYPES = [
  {
    id: "existing-borrower-quote-heavy",
    fixtureKind: "existing-borrower" as const,
    scenario: EXPERIMENTAL_BOUNDARY_DERIVED_PREWINDOW_EXISTING_SCENARIOS[4],
    targetOffsetBps: 100
  },
  {
    id: "existing-borrower-multi-bucket",
    fixtureKind: "existing-borrower-multi-bucket" as const,
    scenario: EXPERIMENTAL_PREWINDOW_MULTI_BUCKET_EXISTING_BORROWER_SCENARIOS[1],
    targetOffsetBps: 100
  },
  {
    id: "large-used-pool-multi-week",
    fixtureKind: "large-used-pool" as const,
    targetRateBps: EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.targetRateBps,
    cycleCount: EXPERIMENTAL_LARGE_USED_POOL_MULTI_WEEK_BORROW_FIXTURE.cycleCount
  }
] as const;

export const EXPERIMENTAL_PINNED_USED_POOL_UPWARD_ARCHETYPES = [
  {
    id: "pinned-used-pool-ac58-latest",
    poolAddress: "0xAc58D4f94f9b77e47cd59B80b64790Af23cB084b",
    blockNumber: 44_680_762n,
    borrowerAddress: "0x31aFDdBE7977a82BAbce5b80D0A6B91918A7804b",
    targetRateBps: 277,
    toleranceBps: 50
  },
  {
    id: "pinned-used-pool-0014-latest",
    poolAddress: "0x0014D130E17197e609fd1509A1366249d0100E77",
    blockNumber: 44_680_762n,
    borrowerAddress: "0x31aFDdBE7977a82BAbce5b80D0A6B91918A7804b",
    targetRateBps: 159,
    toleranceBps: 50
  },
  {
    id: "pinned-used-pool-903c-latest",
    poolAddress: "0x903C2E9e9ff3820cAa93AfA4121872CbB280371B",
    blockNumber: 44_680_762n,
    borrowerAddress: "0x7ba01460ab4829223325d6ed1e8681f7366dF646",
    targetRateBps: 163,
    toleranceBps: 50
  }
] as const;

export const EXPERIMENTAL_AJNA_INFO_MANAGED_USED_POOL_ARCHETYPES = [
  {
    id: "ajna-info-managed-weth-usdc-2024-12-01",
    poolAddress: "0x0b17159f2486f669a1f930926638008e2ccb4287",
    blockNumber: 23_139_570n,
    senderAddress: "0x0ecdf706d25f9ded9cb68a028376cfc2eaf212c0",
    borrowerAddress: "0x0ecdf706d25f9ded9cb68a028376cfc2eaf212c0",
    lenderBucketIndex: 2618,
    inventorySource: "transfer_lp" as const,
    targetOffsetBps: 200,
    toleranceBps: 50
  },
  {
    id: "ajna-info-managed-2388-2024-04-08",
    poolAddress: "0x238862f4d2f3a3c6808736aa6fead766c2296d2d",
    blockNumber: 12_904_736n,
    senderAddress: "0x72f85a69b79954ffd253ac0b8a37fb26d1a84917",
    borrowerAddress: "0x72f85a69b79954ffd253ac0b8a37fb26d1a84917",
    lenderBucketIndex: 4156,
    inventorySource: "transfer_lp" as const,
    targetOffsetBps: 200,
    toleranceBps: 50
  },
  {
    id: "ajna-info-managed-prime-usdc-2025-10-17",
    poolAddress: "0x1abc629d901100218cdfd389e6e778b9399e9f70",
    blockNumber: 36_968_900n,
    senderAddress: "0x41c7b055ff83c33915242c2642640b9b35dea840",
    borrowerAddress: "0x41c7b055ff83c33915242c2642640b9b35dea840",
    lenderBucketIndex: 3506,
    inventorySource: "direct_add_quote" as const,
    targetOffsetBps: 200,
    toleranceBps: 50
  },
  {
    id: "ajna-info-managed-weth-usdglo-2024-10-03",
    poolAddress: "0xc73d1e1b5463920325ae42318a20f88181617185",
    blockNumber: 20_586_751n,
    senderAddress: "0xddf9e5a32f83ea24eb8dbae02e9890c80c06ea13",
    borrowerAddress: "0xddf9e5a32f83ea24eb8dbae02e9890c80c06ea13",
    lenderBucketIndex: 2632,
    inventorySource: "direct_add_quote" as const,
    targetOffsetBps: 200,
    toleranceBps: 50
  },
  {
    id: "ajna-info-managed-dog-usdc-2026-03-18",
    poolAddress: "0xb156f09e8ab6756cd23cf283d495ab75f8334104",
    blockNumber: 43_506_804n,
    senderAddress: "0x7500c95cc6f6c9ede82d4043f9337715360d6b6a",
    borrowerAddress: "0x7500c95cc6f6c9ede82d4043f9337715360d6b6a",
    lenderBucketIndex: 6003,
    inventorySource: "direct_add_quote" as const,
    targetOffsetBps: 200,
    toleranceBps: 50
  }
] as const;

export const MAX_EXACT_DUAL_VALIDATIONS_WITH_PURE_MATCH = 1;
export const MAX_EXACT_DUAL_VALIDATIONS_WITHOUT_PURE_MATCH = 1;

export const EXPERIMENTAL_PREWINDOW_BUCKET_OFFSETS = [
  -250, -100, -50, -20, -10, -5, 0, 5, 10, 20, 50, 100, 250
] as const;
export const EXPERIMENTAL_PREWINDOW_QUOTE_AMOUNTS = [
  1n, 2n, 5n, 10n, 20n, 50n, 100n, 200n, 500n, 1_000n
] as const;
export const EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_BUCKET_OFFSETS = [
  -1_000, -500, -250, -100, -50, -20, -10, -5, 0
] as const;
export const EXPERIMENTAL_PREWINDOW_MULTI_CYCLE_QUOTE_AMOUNTS = [
  10n,
  20n,
  50n,
  100n,
  200n,
  500n,
  1_000n,
  2_000n,
  5_000n,
  10_000n
] as const;
export const EXPERIMENTAL_PREWINDOW_COMPLEX_QUOTE_AMOUNTS = [
  10n,
  20n,
  50n,
  100n,
  200n,
  500n,
  1_000n,
  2_000n,
  5_000n,
  10_000n,
  20_000n,
  50_000n,
  100_000n
] as const;

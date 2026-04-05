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

import { parseAbi } from "viem";

export const ajnaPoolAbi = parseAbi([
  "function addQuoteToken(uint256 amount_, uint256 index_, uint256 expiry_) returns (uint256 bucketLP_, uint256 addedAmount_)",
  "function removeQuoteToken(uint256 maxAmount_, uint256 index_) returns (uint256 removedAmount_, uint256 redeemedLP_)",
  "function drawDebt(address borrowerAddress_, uint256 amountToBorrow_, uint256 limitIndex_, uint256 collateralToPledge_)",
  "function repayDebt(address borrowerAddress_, uint256 maxQuoteTokenAmountToRepay_, uint256 collateralAmountToPull_, address recipient_, uint256 limitIndex_) returns (uint256 amountRepaid_)",
  "function addCollateral(uint256 amountToAdd_, uint256 index_, uint256 expiry_) returns (uint256 bucketLP_)",
  "function removeCollateral(uint256 maxAmount_, uint256 index_) returns (uint256 removedAmount_, uint256 redeemedLP_)",
  "function updateInterest()",
  "function interestRateInfo() view returns (uint256 interestRate_, uint256 interestRateUpdate_)",
  "function debtInfo() view returns (uint256 debt_, uint256 accruedDebt_, uint256 debtInAuction_, uint256 t0Debt2ToCollateral_)",
  "function emasInfo() view returns (uint256 debtColEma_, uint256 lupt0DebtEma_, uint256 debtEma_, uint256 depositEma_)",
  "function inflatorInfo() view returns (uint256 inflator_, uint256 lastUpdate_)",
  "function borrowerInfo(address borrower_) view returns (uint256 t0Debt_, uint256 collateral_, uint256 npTpRatio_)",
  "function loansInfo() view returns (address maxBorrower_, uint256 maxT0DebtToCollateral_, uint256 noOfLoans_)",
  "function totalT0Debt() view returns (uint256)",
  "function totalT0DebtInAuction() view returns (uint256)",
  "function bucketInfo(uint256 index_) view returns (uint256 lpAccumulator_, uint256 availableCollateral_, uint256 bankruptcyTime_, uint256 bucketDeposit_, uint256 bucketScale_)",
  "function lenderInfo(uint256 index_, address lender_) view returns (uint256 lpBalance_, uint256 depositTime_)",
  "function quoteTokenAddress() view returns (address)",
  "function collateralAddress() view returns (address)",
  "function quoteTokenScale() view returns (uint256)",
  "function collateralScale() view returns (uint256)",
  "function poolType() view returns (uint8)"
]);

export const ajnaErc20PoolFactoryAbi = parseAbi([
  "function deployPool(address collateral_, address quote_, uint256 interestRate_) returns (address pool_)",
  "event PoolCreated(address pool_, bytes32 subsetHash_)"
]);

export const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function balanceOf(address owner) view returns (uint256)"
]);

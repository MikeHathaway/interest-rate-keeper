# interest-rate-keeper

Ajna interest-rate keeper for steering a pool toward a target rate on Ajna's 12-hour cadence.

This repo currently contains:
- a pure planner with a closed top-level intent model
- a live Ajna RPC snapshot source
- a live Ajna execution backend
- CLI and KeeperHub entrypoints
- unit tests plus a Base-fork integration test that uses the deployed Base Ajna ERC20 factory

The detailed product and engineering decisions are in [DESIGN.md](./DESIGN.md). Deferred work is tracked in [TODOS.md](./TODOS.md).

## Status

This is still an early implementation. The core keeper loop exists and the live Ajna path is wired, but fully automatic steering is still incomplete:

- exact simulation-backed `ADD_QUOTE` synthesis now exists behind `enableSimulationBackedLendSynthesis`
- exact simulation-backed `DRAW_DEBT` synthesis now exists behind `enableSimulationBackedBorrowSynthesis`
- exact simulation-backed `LEND_AND_BORROW` synthesis now exists when both exact lend and borrow synthesis are enabled
- heuristic `ADD_QUOTE` synthesis still exists behind `enableHeuristicLendSynthesis`
- heuristic `LEND_AND_BORROW` synthesis now exists for the narrow case where adding quote tempers an oversized borrow path toward the target band

Today, the snapshot builder reads real pool state and predicts the next Ajna rate move. For steering candidates:

- `manualCandidates` are still the general bridge for live steering plans
- simulation-backed `ADD_QUOTE` synthesis is an exact opt-in path that forks the current chain state and tests candidate quote deposits against real Ajna contract behavior
- simulation-backed `DRAW_DEBT` synthesis is an exact opt-in path that forks the current chain state and tests candidate borrow amounts against real Ajna contract behavior
- simulation-backed `LEND_AND_BORROW` synthesis is an exact opt-in path that searches direct `ADD_QUOTE -> DRAW_DEBT` combinations on a fork and validates the full `ADD_QUOTE -> DRAW_DEBT -> updateInterest` path before emitting them
- heuristic `ADD_QUOTE` synthesis remains useful for exploratory planning and dry-run validation
- heuristic `LEND_AND_BORROW` synthesis is deliberately narrow: it looks for `ADD_QUOTE -> DRAW_DEBT` plans that soften a borrow overshoot rather than trying to solve a full two-dimensional optimizer
- snapshot `predictedNextOutcome` / `predictedNextRateBps` now describe the next eligible Ajna rate update, even when that update is not due yet
- candidate usefulness is now judged against the do-nothing next update path, not just against the current rate, so the planner can prefer neutralizing a bad upcoming move over letting the pool drift farther away

The current Base-fork evidence is important: the keeper now finds a lend plan in representative borrowed-pool step-up fixtures, borrower-side lookahead planning can find and live-execute a representative multi-cycle `BORROW` plan when a wider search space is enabled, and multi-bucket quote search now surfaces, naturally selects, and live-executes a representative exact `LEND_AND_BORROW` candidate on the fork. Due-window mutating plans no longer append a separate `UPDATE_INTEREST` step, because the first mutating action can consume the overdue update itself. The fork suite now also proves that the keeper aborts safely when another actor changes the pool between planning and execution. On the borrower side, exact same-cycle `DRAW_DEBT` search still does not find a safe candidate in the representative abandoned-pool fixture covered by integration. Exact pre-window lend synthesis is now intentionally disabled, because the later live fork proof did not hold up. So borrower-side exact mode is now useful for representative multi-cycle live steering, but not yet a proven live same-cycle borrow executor.

## Requirements

- Node.js `>=20.5.0`
- `npm`
- Foundry (`forge` and `anvil`) for fork integration tests

## Install

```bash
npm install
```

## Commands

```bash
npm run build
npm run typecheck
npm test
npm run test:integration:base
```

Notes:
- `npm test` runs the fast unit suite only.
- `npm run test:integration:base` runs the Base-fork integration test in [`tests/integration/base-factory.integration.ts`](./tests/integration/base-factory.integration.ts).
- The Base integration test uses `BASE_RPC_URL` if provided, otherwise it falls back to `https://mainnet.base.org`.

## Env Files

The CLI and Base-fork integration test now load `.env` automatically via `dotenv`. Existing shell environment variables still win, so you can always override values for a single command without editing the file.

Start from:

```bash
cp .env.example .env
```

Typical local values:

```dotenv
BASE_RPC_URL=https://your-base-rpc.example
AJNA_KEEPER_PRIVATE_KEY=0x...
```

## CLI Usage

Build first:

```bash
npm run build
```

Dry-run from a config file:

```bash
node dist/src/cli.js run --config ./keeper.config.json --dry-run
```

Run against a live Ajna pool:

```bash
node dist/src/cli.js run --config ./keeper.config.json
```

KeeperHub-style payload execution:

```bash
node dist/src/cli.js keeperhub --payload ./keeperhub-payload.json --dry-run
```

CLI flags:
- `run --config <path>`
- `run --config <path> --snapshot <path>`
- `keeperhub --payload <path>`
- `--dry-run`

If `--snapshot` is omitted in `run` mode, the CLI uses the live Ajna RPC snapshot source.

## Minimal Config Shape

```json
{
  "chainId": 8453,
  "poolAddress": "0x0000000000000000000000000000000000000000",
  "targetRateBps": 800,
  "toleranceBps": 50,
  "toleranceMode": "relative",
  "completionPolicy": "next_move_would_overshoot",
  "executionBufferBps": 50,
  "maxQuoteTokenExposure": "1000000000000000000000000",
  "maxBorrowExposure": "1000000000000000000000000",
  "snapshotAgeMaxSeconds": 90,
  "minTimeBeforeRateWindowSeconds": 120,
  "minExecutableActionQuoteToken": "1",
  "recheckBeforeSubmit": true,
  "rpcUrl": "https://mainnet.base.org"
}
```

Optional live-execution fields:
- `borrowerAddress`
- `recipientAddress`
- `logPath`
- `manualCandidates`
- `maxGasCostWei`
- `addQuoteBucketIndex`
- `addQuoteBucketIndexes`
- `addQuoteExpirySeconds`
- `enableSimulationBackedLendSynthesis`
- `enableSimulationBackedBorrowSynthesis`
- `simulationSenderAddress`
- `drawDebtLimitIndex`
- `drawDebtLimitIndexes`
- `drawDebtCollateralAmount`
- `drawDebtCollateralAmounts`
- `borrowSimulationLookaheadUpdates`
- `enableHeuristicLendSynthesis`

## Live Execution Notes

The live executor currently:
- requires `AJNA_KEEPER_PRIVATE_KEY` or `PRIVATE_KEY` in the environment
- requires `poolAddress` and `rpcUrl` in config
- checks ERC20 allowance before quote-token or collateral-token moves
- does not auto-submit approval transactions for you

Supported low-level execution steps:
- `ADD_QUOTE`
- `REMOVE_QUOTE`
- `DRAW_DEBT`
- `REPAY_DEBT`
- `ADD_COLLATERAL`
- `REMOVE_COLLATERAL`
- `UPDATE_INTEREST`

Supported top-level planner intents:
- `NO_OP`
- `LEND`
- `BORROW`
- `LEND_AND_BORROW`

## Base Fork Integration Test

The Base integration test is intended to stay close to real deployed Ajna behavior:

- it forks Base with Anvil
- it deploys mock ERC20 collateral and quote tokens into the fork
- it calls the deployed Base Ajna ERC20 factory
- it creates a fresh pool through that real factory
- it advances time past the 12-hour update window
- it runs the keeper cycle and verifies that `UPDATE_INTEREST` changes the rate as expected
- it also proves that the keeper can find a due-cycle `LEND` plan in a representative borrowed-pool step-up fixture without appending a separate `UPDATE_INTEREST` step
- it also proves that exact same-cycle `BORROW` synthesis still finds no candidate in a representative abandoned-pool Base fixture, even though the fork reaches real states where borrower-side steering would be desirable
- it also proves that borrower-side lookahead planning can find and live-execute a representative multi-cycle `BORROW` plan when `borrowSimulationLookaheadUpdates` is enabled with a wider search space
- it also proves that the keeper aborts safely when another actor changes the pool between planning and execution
- it also proves that multi-bucket quote search can surface, naturally select, and live-execute a representative exact `LEND_AND_BORROW` candidate on the fork
- it proves the one-cycle-ahead forecast by checking that a post-update not-due snapshot predicts the passive next eligible rate update correctly on a later real `updateInterest`
- it proves repeated update-only cycles across roughly a week by stepping a pool from `1000 bps` down to a `200 bps` target band over 15 successive real updates, then verifying the keeper stops cleanly once the band is reached

Run it with:

```bash
npm run test:integration:base
```

## Current Limitations

- The planner does not yet synthesize the minimum directional threshold directly from live Ajna pool state.
- `manualCandidates` are still the bridge for live steering plans.
- Exact simulation-backed lend synthesis is opt-in and currently limited to due-window representative lend fixtures.
- Exact pre-window lend synthesis is intentionally disabled for now, because the live fork proof did not match the simulated candidate in the representative not-due step-up fixture.
- Exact simulation-backed borrow synthesis is opt-in and now supports multi-cycle planning through `borrowSimulationLookaheadUpdates`, with representative Base-fork coverage for a live-executed 3-update borrower path.
- Exact simulation-backed `LEND_AND_BORROW` synthesis is now wired into the live snapshot path when both exact lend and borrow synthesis are enabled, and it benchmarks candidate dual paths against the best exact single-action paths before emitting them.
- Adding multi-bucket quote search made that stricter benchmark productive again in the representative Base fixture: the keeper now surfaces and naturally selects a real exact `LEND_AND_BORROW` candidate there.
- The representative live-execution equivalence check for the exact dual plan is now covered on the fork: the executed due-window plan lands on the same first-update rate the simulation predicted.
- Exact same-cycle borrow synthesis remains conservative in the representative Base-fork abandoned-pool fixture; the fork reaches eligible states, but no same-cycle live `DRAW_DEBT` candidate is appearing there yet.
- Heuristic `LEND_AND_BORROW` synthesis only covers the “temper an oversized borrow with a small quote deposit” case today; it is not yet a general liquidity-seeding or multi-dimensional search strategy.
- Heuristic lend synthesis is opt-in and currently validated for live planning/dry-run discovery, not for blind live execution in borrowed pools.
- Repeated natural update-only convergence is covered by integration tests, including week-scale multi-cycle operation.
- Token approvals are checked, not managed.
- The current fork integration tests prove factory creation, real interest updates, next-cycle forecasting, a live-executed representative due-window `LEND_AND_BORROW` cycle, a live-executed representative multi-cycle `BORROW` cycle, safe recheck aborts under competing actor interference, a representative due-window `LEND` planning cycle, and the exact-vs-heuristic split for lend planning, but not yet a fully validated live-executed computed same-cycle borrower-side steering cycle.

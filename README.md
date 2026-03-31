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
- heuristic `DRAW_DEBT` synthesis now exists behind `enableHeuristicBorrowSynthesis`
- heuristic `LEND_AND_BORROW` synthesis now exists for the narrow case where adding quote tempers an oversized borrow path toward the target band

Today, the snapshot builder reads real pool state and predicts the next Ajna rate move. For steering candidates:

- `manualCandidates` are still the general bridge for live steering plans
- `manualCandidates` can now carry `planningRateBps` and `planningLookaheadUpdates`, so manually supplied multi-cycle plans are ranked correctly
- live Ajna snapshots now bind `manualCandidates` to snapshot-specific validation signatures that include pool, borrower, loan, and referenced-bucket context, so recheck can invalidate stale manual plans before execution
- simulation-backed `ADD_QUOTE` synthesis is an exact opt-in path that forks the current chain state and tests candidate quote deposits against real Ajna contract behavior
- simulation-backed `DRAW_DEBT` synthesis is an exact opt-in path that forks the current chain state and tests candidate borrow amounts against real Ajna contract behavior
- simulation-backed `LEND_AND_BORROW` synthesis is an exact opt-in path that searches direct `ADD_QUOTE -> DRAW_DEBT` combinations on a fork and validates the full `ADD_QUOTE -> DRAW_DEBT -> updateInterest` path before emitting them
- heuristic `ADD_QUOTE` synthesis remains useful for exploratory planning and dry-run validation
- heuristic `DRAW_DEBT` synthesis now provides exploratory upward-steering candidates when exact same-cycle borrow remains too conservative
- heuristic `LEND_AND_BORROW` synthesis is deliberately narrow: it looks for `ADD_QUOTE -> DRAW_DEBT` plans that soften a borrow overshoot rather than trying to solve a full two-dimensional optimizer
- when `borrowSimulationLookaheadUpdates` is unset, the live exact borrower path now tries one-update exact borrow first, then falls back to the default 3-update exact borrow path
- snapshot `predictedNextOutcome` / `predictedNextRateBps` now describe the next eligible Ajna rate update, even when that update is not due yet
- candidate usefulness is now judged against the do-nothing next update path, not just against the current rate, so the planner can prefer neutralizing a bad upcoming move over letting the pool drift farther away

The current Base-fork evidence is important: the keeper now finds a lend plan in representative borrowed-pool step-up fixtures, borrower-side lookahead planning can find and live-execute a representative multi-cycle `BORROW` plan when a wider search space is enabled, and multi-bucket quote search now surfaces, naturally selects, and live-executes a representative exact `LEND_AND_BORROW` candidate on the fork. Due-window mutating plans no longer append a separate `UPDATE_INTEREST` step, because the first mutating action can consume the overdue update itself. The fork suite now also proves that the keeper aborts safely when another actor changes the pool between planning and execution. On the borrower side, exact same-cycle `DRAW_DEBT` search still does not find a safe candidate in the representative brand-new quote-only fixture covered by routine integration, while heuristic `DRAW_DEBT` synthesis is now available as an exploratory fallback. The broader existing-borrower exact same-cycle negative proof remains in the `experimental` profile, now filtered to true borrower/loan states, and it is still negative even on a deliberately borrower-heavy existing-loan fixture set. Exact pre-window lend synthesis is still intentionally disabled, because the representative not-due step-up fixture is not stable enough for a live proof yet. So borrower-side exact mode is now useful for representative multi-cycle live steering, but not yet a proven live same-cycle borrow executor.

## Product Modes

The keeper should be thought of as several related product modes, not one generic "steer the rate" problem.

### 1. Brand-New Pool, Target Rate Below Current Trajectory

This is the "new pool is too expensive / should drift down faster" case.

- closest keeper primitive: `UPDATE_INTEREST` and `LEND`
- protocol shape: quote-heavy / underutilized pool
- current evidence: strongest

What is proven today:
- repeated update-only convergence over roughly a week
- representative due-window `LEND` planning

### 2. Brand-New Pool, Target Rate Above Current Trajectory

This is the "new pool should move up faster than passive updates would allow" case.

- closest keeper primitive: `BORROW`
- protocol shape: borrower-side steering from a low-rate pool
- current evidence: partial

What is proven today:
- representative multi-cycle `BORROW` planning and live execution
- the live exact borrower path now automatically attempts a multi-cycle fallback when same-cycle exact borrow is unavailable and no explicit lookahead is configured

What is not proven today:
- exact same-cycle borrower-side steering

### 3. Abandoned High-Rate Pool / Reset-To-Ten Behavior

This is not the same as a new pool. Ajna has special reset behavior for thin high-rate pools.

- closest keeper primitive: explicit `RESET_TO_TEN` outcome modeling
- protocol shape: low meaningful utilization at rate > `10%`
- current evidence: modeled and forecast, but not a distinct live keeper strategy beyond the shared engine

### 4. Mixed Two-Sided Correction

This is the case where quote and borrow actions together beat either side alone.

- closest keeper primitive: `LEND_AND_BORROW`
- protocol shape: direct `ADD_QUOTE -> DRAW_DEBT` path
- current evidence: representative due-window exact dual execution is proven

### Capability Matrix

| Mode | Current status |
| --- | --- |
| New pool, drift rate down | proven for update-only convergence and representative due-window `LEND` planning |
| New pool, move rate up | proven only for representative multi-cycle `BORROW`; same-cycle `BORROW` not proven |
| Abandoned high-rate reset/recovery | outcome model implemented, but not a separately proven live steering strategy |
| Mixed two-sided correction | representative exact due-window `LEND_AND_BORROW` is proven |

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
npm run lint
npm run typecheck
npm run verify
npm test
npm run test:integration:base:smoke
npm run test:integration:base
npm run test:integration:base:slow
npm run test:integration:base:stress
npm run test:integration:base:experimental
```

Notes:
- `npm test` runs the fast unit suite only.
- `npm run lint` runs the source-focused ESLint pass over `src/**/*.ts` plus the release runner script.
- `npm run verify` runs `lint + typecheck + unit tests + build` and is the same gate used by CI and publish workflows.
- `npm run test:integration:base:smoke` runs the smallest Base-fork health checks through the managed fork runner.
- `npm run test:integration:base` runs the broader default Base-fork integration profile in [`tests/integration/base-factory.integration.ts`](./tests/integration/base-factory.integration.ts) through the managed fork runner.
- `npm run test:integration:base:slow` runs the slower but still routine exact-path proofs through the managed fork runner.
- `npm run test:integration:base:stress` runs the heavier but consistently passable managed-local-Anvil proofs.
- `npm run test:integration:base:experimental` runs the longest algorithmic exact-search proofs, including the broader existing-borrower same-cycle borrow scan. These are exploratory and can still take many minutes.
- `npm run test:integration:base:all` runs every profile together, including `experimental`, and also uses the managed local-Anvil path.
- The Base integration test uses `BASE_RPC_URL` if provided, otherwise it falls back to `https://mainnet.base.org`.
- If `BASE_LOCAL_ANVIL_URL` is unset, the managed fork runner picks a profile-specific free local port, starts its own local Anvil fork there, and tears it down after the run.
- If `BASE_LOCAL_ANVIL_URL` is set, the test harness reuses that already-running local Anvil fork instead of spawning a fresh one.
- The Base integration test logs the selected profile plus either the explicit reused local fork host or the spawned upstream/local hosts at startup.

## CI/CD

- [ci.yml](./.github/workflows/ci.yml) runs `npm run verify` on every push/PR and runs the Base smoke profile when `BASE_RPC_URL` is available as a GitHub secret.
- [publish.yml](./.github/workflows/publish.yml) runs on `v*` tags, reruns `npm run verify`, publishes to npm using `NPM_TOKEN`, and creates a GitHub release.
- `npm pack --dry-run` now produces a clean package containing the built CLI/library artifacts from `dist/src`.

## Env Files

The CLI and Base-fork integration test now load `.env` automatically via `dotenv`. Existing shell environment variables still win, so you can always override values for a single command without editing the file.

Start from:

```bash
cp .env.example .env
```

Typical local values:

```dotenv
BASE_RPC_URL=https://your-base-rpc.example
BASE_LOCAL_ANVIL_URL=http://127.0.0.1:9545
BASE_ACTIVE_POOL_ADDRESS=0x...
AJNA_KEEPER_PRIVATE_KEY=0x...
```

`BASE_LOCAL_ANVIL_URL` is optional. When set, the integration harness expects an already-running Anvil-compatible local fork and reuses it for snapshot/revert/time-travel instead of spawning its own process. This is the most robust way to run the heavier Base-fork profiles when sandboxed fork startup or upstream DNS has been flaky.

When you set `BASE_LOCAL_ANVIL_URL`, the runner trusts that endpoint and does not reset or sanitize it. Point it at a clean Base fork that you control, or let the managed runner start an isolated local fork for the current profile instead.

`BASE_ACTIVE_POOL_ADDRESS` is optional. When set, the real active-pool replay test skips factory-log discovery and replays against that specific Base pool instead.

Recommended heavy-test workflow:

```bash
anvil --fork-url "$BASE_RPC_URL" --port 9545 --chain-id 8453 --silent
BASE_LOCAL_ANVIL_URL=http://127.0.0.1:9545 npm run test:integration:base:slow
```

For the heaviest representative proofs, prefer:

```bash
BASE_LOCAL_ANVIL_URL=http://127.0.0.1:9545 npm run test:integration:base:stress
```

For the longest exploratory exact-search proofs, use:

```bash
BASE_LOCAL_ANVIL_URL=http://127.0.0.1:9545 npm run test:integration:base:experimental
```

If `BASE_LOCAL_ANVIL_URL` is unset, all Base-fork package scripts automatically start a managed local Anvil fork on a profile-specific free local port, run the suite there, then shut it down when the run finishes.

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

When KeeperHub payload config includes `poolAddress` and `rpcUrl`, the adapter now uses the payload snapshot for planning and a live Ajna RPC read for the submit-time recheck. If the payload cannot support a live recheck, the adapter disables `recheckBeforeSubmit` instead of pretending the second read happened.

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
- `enableHeuristicBorrowSynthesis`

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
- it also proves that exact same-cycle `BORROW` synthesis still finds no candidate in a representative brand-new quote-only Base fixture after the first passive update, even though the fork reaches real states where borrower-side steering would be desirable
- it also includes experimental proofs that exact same-cycle `BORROW` synthesis still finds no candidate across a broadened representative set of true existing-borrower Base fixtures, including a deliberately borrower-heavy existing-loan matrix
- it also proves that borrower-side lookahead planning can find and live-execute a representative multi-cycle `BORROW` plan when `borrowSimulationLookaheadUpdates` is enabled with a wider search space
- it also proves that the keeper aborts safely when another actor changes the pool between planning and execution
- it also proves that multi-bucket quote search can surface, naturally select, and live-execute a representative exact `LEND_AND_BORROW` candidate on the fork
- it proves the one-cycle-ahead forecast by checking that a post-update not-due snapshot predicts the passive next eligible rate update correctly on a later real `updateInterest`
- it proves repeated update-only cycles across roughly a week by stepping a pool from `1000 bps` down to a `200 bps` target band over 15 successive real updates, then verifying the keeper stops cleanly once the band is reached
- it can optionally skip live pool discovery and replay against `BASE_ACTIVE_POOL_ADDRESS` when that env var is set

Run it with:

```bash
npm run test:integration:base
```

## Current Limitations

- The planner does not yet synthesize the minimum directional threshold directly from live Ajna pool state.
- `manualCandidates` are still the bridge for live steering plans.
- live snapshots now attach validation signatures to `manualCandidates`, so recheck can invalidate them when pool, borrower, loan, or referenced-bucket context drifts before execution.
- Exact simulation-backed lend synthesis is opt-in and currently limited to due-window representative lend fixtures.
- Exact simulation-backed borrow synthesis is opt-in and now supports multi-cycle planning through `borrowSimulationLookaheadUpdates`, with representative Base-fork coverage for a live-executed 3-update borrower path. When `borrowSimulationLookaheadUpdates` is unset, the live snapshot source tries `[1, 3]` exact borrow planning in that order.
- Heuristic borrow synthesis is opt-in and now covers exploratory upward-steering candidates through the same heuristic search path used by the pure planner tests.
- Brand-new pool upward-convergence and abandoned-pool recovery should not be treated as the same keeper mode; they share engine pieces, but the proven execution paths are different.
- Exact simulation-backed `LEND_AND_BORROW` synthesis is now wired into the live snapshot path when both exact lend and borrow synthesis are enabled, and it benchmarks candidate dual paths against the best exact single-action paths before emitting them.
- Adding multi-bucket quote search made that stricter benchmark productive again in the representative Base fixture: the keeper now surfaces and naturally selects a real exact `LEND_AND_BORROW` candidate there.
- The representative live-execution equivalence check for the exact dual plan is now covered on the fork: the executed due-window plan lands on the same first-update rate the simulation predicted.
- Exact same-cycle borrow synthesis now uses Ajna `bucketInfo` reads to prioritize funded live bucket indexes, reads `borrowerInfo` and `loansInfo` to ground borrower-side search, broadens a single configured `drawDebtLimitIndex` into a wider protocol sample set, expands a single configured `drawDebtCollateralAmount` toward the live account’s available collateral during simulation, and includes `0` additional collateral for existing borrowers. It also no longer short-circuits just because the current rate is in band; same-cycle borrower, lender, and dual synthesis now correctly consider whether the next eligible update is about to step out of band. For one-update exact borrow validation, the engine now uses same-cycle heuristic borrow as a plausibility gate and validates only the heuristic candidate's collateral/limit-index path instead of performing a near-global exact scan. Even with that broader and more pool-aware borrower search, it still remains conservative in the representative brand-new quote-only fixture, and the broader existing-borrower negative proof remains exploratory in `experimental` after filtering to real borrower/loan states and borrower-heavy loan shapes.
- Heuristic `LEND_AND_BORROW` synthesis only covers the “temper an oversized borrow with a small quote deposit” case today; it is not yet a general liquidity-seeding or multi-dimensional search strategy.
- Heuristic lend synthesis is opt-in and currently validated for live planning/dry-run discovery, not for blind live execution in borrowed pools.
- Repeated natural update-only convergence is covered by integration tests, including week-scale multi-cycle operation.
- Token approvals are checked, not managed.
- The current fork integration tests prove factory creation, real interest updates, next-cycle forecasting, a live-executed representative due-window `LEND_AND_BORROW` cycle, a live-executed representative multi-cycle `BORROW` cycle, safe recheck aborts under competing actor interference, a representative due-window `LEND` planning cycle, and the exact-vs-heuristic split for lend planning, but not yet a fully validated live-executed computed same-cycle borrower-side steering cycle.

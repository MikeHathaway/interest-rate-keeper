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
- heuristic `ADD_QUOTE` synthesis still exists behind `enableHeuristicLendSynthesis`
- generalized automatic `BORROW` / `LEND_AND_BORROW` synthesis is still not built

Today, the snapshot builder reads real pool state and predicts the next Ajna rate move. For steering candidates:

- `manualCandidates` are still the general bridge for live steering plans
- simulation-backed `ADD_QUOTE` synthesis is an exact opt-in path that forks the current chain state and tests candidate quote deposits against real Ajna contract behavior
- heuristic `ADD_QUOTE` synthesis remains useful for exploratory planning and dry-run validation
- snapshot `predictedNextOutcome` / `predictedNextRateBps` now describe the next eligible Ajna rate update, even when that update is not due yet

The current Base-fork evidence is important: exact simulation-backed synthesis did not find any same-cycle `LEND` candidate across the tested due-cycle borrowed-pool scenarios, while heuristic discovery still found dry-run candidates. So exact mode is currently best understood as a safety filter for due-cycle lend plans, not yet as a proven live same-cycle lend executor.

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
AJNA_KEEPER_PRIVATE_KEY=0x... \
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
- `addQuoteExpirySeconds`
- `enableSimulationBackedLendSynthesis`
- `simulationSenderAddress`
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
- it also proves that exact simulation-backed due-cycle `LEND` synthesis stays silent on the tested borrowed-pool scenarios while heuristic discovery still finds a dry-run `ADD_QUOTE` plan
- it proves the one-cycle-ahead forecast by checking that a post-update not-due snapshot predicts the next eligible rate update correctly on a later real `updateInterest`

Run it with:

```bash
BASE_RPC_URL=https://mainnet.base.org npm run test:integration:base
```

## Current Limitations

- The planner does not yet synthesize the minimum directional threshold directly from live Ajna pool state.
- `manualCandidates` are still the bridge for live steering plans.
- Exact simulation-backed lend synthesis is opt-in and currently behaves as a conservative safety check for due-cycle borrowed-pool lend plans in the tested Base-fork scenarios.
- Exact simulation-backed lend synthesis also remains conservative in the tested pre-window post-update scenarios; the one-cycle-ahead forecast is validated, but exact pre-window `LEND` plans are still not appearing in those cases.
- Heuristic lend synthesis is opt-in and currently validated for live planning/dry-run discovery, not for blind live execution in borrowed pools.
- Token approvals are checked, not managed.
- The current fork integration tests prove factory creation, real interest updates, next-cycle forecasting, and the exact-vs-heuristic split for lend planning, but not yet a fully validated live-executed computed `LEND` or `BORROW` steering cycle.

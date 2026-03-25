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

This is still an early implementation. The core keeper loop exists and the live Ajna path is wired, but one important gap remains:

- automatic onchain threshold synthesis is not built yet

Today, the snapshot builder reads real pool state and predicts the next Ajna rate move, but candidate steering actions still come from `manualCandidates` in config when you want the planner to choose `LEND`, `BORROW`, or `LEND_AND_BORROW`.

There is now one partial exception:

- heuristic `ADD_QUOTE` synthesis can be enabled explicitly with `enableHeuristicLendSynthesis`

That path is useful for live planning and dry-run validation, but it is still heuristic rather than a fully validated onchain threshold synthesizer.

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
- it also proves heuristic `ADD_QUOTE` plan discovery against a real borrowed pool state on a Base fork

Run it with:

```bash
BASE_RPC_URL=https://mainnet.base.org npm run test:integration:base
```

## Current Limitations

- The planner does not yet synthesize the minimum directional threshold directly from live Ajna pool state.
- `manualCandidates` are still the bridge for live steering plans.
- Heuristic lend synthesis is opt-in and currently validated for live planning/dry-run discovery, not for blind live execution in borrowed pools.
- Token approvals are checked, not managed.
- The current fork integration tests prove factory creation, real interest updates, and heuristic live-plan discovery, but not yet a fully validated live-executed computed `LEND` or `BORROW` steering cycle.

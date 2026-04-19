# Architecture

This keeper has one generic engine and one concrete Ajna adapter.

The real source layout is now:

- `src/core/config/*`: config parsing and normalization
- `src/core/snapshot/*`: generic snapshot types, metadata access, and file/payload snapshot sources
- `src/core/planning/*`: candidate metrics, managed-control guards, planner, and policy
- `src/core/cycle/*`: execution backend abstraction and one-cycle orchestration
- `src/ajna/adapter/*`: Ajna-specific wiring into the core engine
- `src/ajna/read/*`: authoritative onchain reads and read caches
- `src/ajna/search/*`: bounded candidate-space construction
- `src/ajna/synthesize/*`: heuristic and exact candidate evaluation
- `src/ajna/math/*`: Ajna rate math and protocol constants
- `src/ajna/dev/*`: fork/testing helpers used by simulation and integration workflows

## End-to-End Flow

1. Config is parsed by [`config.ts`](../src/core/config/config.ts), plus the grouped config helpers in [`managed.ts`](../src/core/config/managed.ts), [`synthesis.ts`](../src/core/config/synthesis.ts), and [`parse.ts`](../src/core/config/parse.ts).
2. The entrypoint uses the generic snapshot contract from [`file.ts`](../src/core/snapshot/file.ts).
3. For live Ajna operation, the concrete snapshot source is [`snapshot-source.ts`](../src/ajna/adapter/snapshot-source.ts).
4. That adapter calls the Ajna read layer in [`pool-state.ts`](../src/ajna/read/pool-state.ts) and [`cache.ts`](../src/ajna/read/cache.ts) to build a block-pinned pool/account view.
5. The adapter resolves a bounded search space through [`index.ts`](../src/ajna/search/index.ts), [`buckets.ts`](../src/ajna/search/buckets.ts), [`amounts.ts`](../src/ajna/search/amounts.ts), [`ranking.ts`](../src/ajna/search/ranking.ts), and [`dual-prefilter.ts`](../src/ajna/search/dual-prefilter.ts).
6. Candidate evaluation happens in the synthesize layer:
   - lend: [`heuristic.ts`](../src/ajna/synthesize/lend/heuristic.ts), [`exact.ts`](../src/ajna/synthesize/lend/exact.ts)
   - borrow: [`heuristic.ts`](../src/ajna/synthesize/borrow/heuristic.ts), [`exact.ts`](../src/ajna/synthesize/borrow/exact.ts)
   - dual: [`heuristic.ts`](../src/ajna/synthesize/dual/heuristic.ts), [`exact.ts`](../src/ajna/synthesize/dual/exact.ts)
   - shared simulation helpers: [`context.ts`](../src/ajna/synthesize/sim/context.ts), [`helpers.ts`](../src/ajna/synthesize/sim/helpers.ts)
7. The adapter returns a generic `PoolSnapshot` to the planner in [`planner.ts`](../src/core/planning/planner.ts).
8. The policy layer in [`policy.ts`](../src/core/planning/policy.ts) validates the selected plan and performs submit-time rechecks against fresh state.
9. [`run-cycle.ts`](../src/core/cycle/run-cycle.ts) orchestrates planning, recheck, execution, and re-planning for multi-step flows.
10. Live Ajna transaction submission happens in [`executor.ts`](../src/ajna/adapter/executor.ts).

## Read vs Search vs Synthesize

- `read` answers: what is the authoritative pool/account state right now?
- `search` answers: which bucket indexes, sizes, limits, and horizons are worth trying?
- `synthesize` answers: if we try those candidates against Ajna mechanics, which plans are actually useful?

That separation matters because the keeper should not mix protocol truth with search policy.

## Core vs Ajna

`src/core/*` should stay protocol-agnostic.

Its job is to:
- parse config
- define shared types
- accept snapshots
- choose a plan
- apply policy
- execute a cycle

`src/ajna/*` is the protocol adapter.

Its job is to:
- read Ajna state
- understand Ajna rate math
- build Ajna-specific search spaces
- synthesize Ajna candidates
- execute Ajna transactions

## Test Layout

The Base fork integration suite now mirrors the product modes more directly:

- [`index.integration.ts`](../tests/integration/base/index.integration.ts): suite entrypoint and orchestration
- [`borrower.ts`](../tests/integration/base/borrower.ts): borrower/upward research registration
- [`curator.ts`](../tests/integration/base/curator.ts): managed-inventory research registration
- [`lend.ts`](../tests/integration/base/lend.ts): downward/lend registration
- [`helpers/`](../tests/integration/base/helpers): shared harness, fixtures, protocol helpers, and research probes

The integration runner targets the canonical suite path directly through [`run-base-fork-profile.mjs`](../scripts/run-base-fork-profile.mjs).

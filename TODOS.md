# TODOS

## Orchestration

### Multi-pool and Multi-chain Orchestration

**What:** Add orchestration that fans out one-shot keeper runs across multiple pools and chains.

**Why:** This unlocks the broader operator workflow you described without forcing v1 to own scheduling, prioritization, and cross-chain coordination before the core engine is proven.

**Context:** The eng review intentionally reduced v1 to one pool on one chain per run, with CLI and KeeperHub invoking the same one-shot engine. Build orchestration as an outer layer that repeatedly calls the stable one-shot cycle rather than changing planner or execution semantics. It should isolate failures per pool, apply per-pool caps, and avoid turning the core engine into a distributed scheduler.

**Effort:** L
**Priority:** P2
**Depends on:** Stable v1 engine, structured run logs, and shared CLI/KeeperHub entrypoints

## Surfaces

### Recommendation Widget for Pool Creators

**What:** Add a website widget or read-only UI that shows the predicted next-rate outcome, recommended action, and expected convergence before execution.

**Why:** This gives new pool creators a low-friction way to understand what the keeper would do before they wire it into KeeperHub or run it directly.

**Context:** The reviewed v1 explicitly defers the website widget. The pure planner and closed action-plan schema make this straightforward later: call the same backend planner, show the predicted next-rate outcome and the minimum directional threshold plus buffer, and keep execution out of the frontend. Start in recommendation-only mode.

**Effort:** M
**Priority:** P3
**Depends on:** Pure planner, closed action-plan schema, and stable snapshot semantics

## Execution

### Private Bundle / Atomic Execution Backend

**What:** Add an optional execution backend for supported chains that submits dual-action plans through private bundles or equivalent atomic execution paths.

**Why:** This can reduce visible intermediate state and partial-completion risk for `LEND_AND_BORROW` plans in thin pools where sequential execution feels operationally awkward.

**Context:** The eng review kept v1 on sequential execution with recheck and explicit partial-success handling because that is the boring, portable default and fits KeeperHub cleanly. This deferred path should only be attempted after the sequential baseline is proven. Requirements: chain-specific relay/provider support, target-block simulation, bundle inclusion and retry handling, fallback to sequential mode when bundles are unavailable, and integration tests that prove parity with the normal executor. Drawbacks: lower portability across chains, more specialized infrastructure and operational dependencies, likely weaker fit with plain KeeperHub-native workflows, and more complex observability/debugging when bundles are rejected or not included.

**Effort:** L
**Priority:** P3
**Depends on:** Stable action-plan schema, direct executor backend, and a fully tested sequential-execution baseline

## Review Follow-Ups

### Release and CI Automation

**What:** Finish the distribution automation that the design calls for: GitHub Actions for lint/typecheck/test/build, publish-on-tag, and release packaging.

**Why:** The core keeper exists, but the release path from the design is still not implemented. The package is still private and there is no checked-in GitHub Actions workflow yet.

**Context:** The current repo already has stable unit coverage and multiple Base fork test profiles. The missing piece is the automation layer that turns that into a repeatable release and verification pipeline.

**Effort:** M
**Priority:** P2
**Depends on:** Stable test profile split and a decision on package publication scope

### External Local Anvil Cleanliness Contract

**What:** Keep documenting and possibly enforcing the trust contract around `BASE_LOCAL_ANVIL_URL`.

**Why:** When an explicit local Anvil URL is supplied, the runner intentionally trusts that endpoint instead of resetting it. That is correct for operator-controlled heavy test runs, but it means replay tests are only as clean as the provided local fork.

**Context:** The managed fork runner now starts isolated local Anvil instances by default for package scripts. This follow-up only applies when operators intentionally point the suite at an external reused fork.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Completed

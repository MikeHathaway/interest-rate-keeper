# Curator Mode

## Purpose

This note describes the only used-pool upward-control model that currently looks operationally credible in Ajna:

- the operator already has meaningful quote inventory in the pool
- the operator may also maintain a live borrower position
- the keeper steers with that standing inventory over multiple updates

This is a different product mode from the default keeper boundary.

Without standing inventory, the current evidence still does not support broad used-pool upward control.

## Status

Targeted managed `REMOVE_QUOTE` is a **supported but narrow** curator-mode
path. Of the five pinned `ajna.info.finance` managed archetypes we have
actual-chain state for, exactly one (dog/USDC at Base block `43,506,804`) is
verified end-to-end today: the simulation-backed synthesis produces a
REMOVE_QUOTE candidate, the planned call executes against the forked pool,
and the realized on-chain rate after a warp-and-update matches the
simulator's prediction exactly (`+28 bps` on the first update, `+58 bps`
terminal across two updates). The operator owns ~100% of the target bucket
and the candidate's release amount is ~67% of the bucket's deposit (the
**release fraction**, not the ownership fraction — see the next section for
the distinction).

The other four pinned archetypes do **not** surface an exact REMOVE_QUOTE
candidate today. The diagnostic probe in
`tests/integration/base/curator.ts` reports the root cause for each:

| Archetype | Root cause | Category |
| --- | --- | --- |
| `ajna-info-managed-weth-usdc-2024-12-01` | `secondsUntilNextRateUpdate: 0` — the block is pinned inside the rate-update window. Eligibility reason: *"managed inventory upward control currently only runs before the next eligible rate update"*. | Fixture timing (pinned block chosen for ajna.info event capture, not curator testability) |
| `ajna-info-managed-2388-2024-04-08` | EMAs are zero. Eligibility reason: *"managed inventory upward control is only modeled on EMA-initialized used pools"*. | Pool state (pool too young to model) |
| `ajna-info-managed-prime-usdc-2025-10-17` | Eligibility passes, search runs, but finds no improving amount. Operator holds ~9% of the target bucket's deposit (~10 USDC out of ~110 USDC total); no withdrawal size beats the passive 2-update path. | Action-space constraint (operator's fraction of pool deposit EMA too small to move the rate) |
| `ajna-info-managed-weth-usdglo-2024-10-03` | EMAs are zero. Same eligibility reason as archetype 2. | Pool state (pool too young to model) |

Two findings worth calling out:

**Three of four failures are not search-quality issues.** Two archetypes are
correctly refused by the curator-eligibility gate because the pool is not
EMA-initialized, one is pinned inside the rate-update window. The keeper is
behaving correctly; those archetypes are just not curator-applicable at their
pinned blocks.

**One archetype reveals a real action-space boundary.** On PRIME/USDC, the
operator's ~9% ownership of the target bucket's deposit is too small a
fraction of the pool's total deposit EMA to move the rate meaningfully. This
is not a search-grid bug. It is the keeper correctly refusing to act when an
operator's inventory cannot produce a beat-passive improvement. For curator
operators: if your bucket ownership is a small fraction of total pool deposit
EMA, expect the keeper to produce no exact candidate, regardless of search
tuning.

### Two fractions that matter, and how they differ

Two different fractions come up in curator analysis and they are easy to
confuse. They answer different questions:

- **Ownership fraction** — *before* the action, how much of the target
  bucket's deposit the operator already controls. For dog/USDC this is
  ~100% (operator LP ≈ bucket deposit); for PRIME/USDC it is ~9%.
- **Release fraction** — *as part of the action*, how much of the target
  bucket the keeper's selected REMOVE_QUOTE amount will withdraw. For
  dog/USDC this is ~67% of the bucket; the synthetic-pool sweep below lands
  on ~63% at its surfacing point.

Ownership gates whether a candidate surfaces at all. Release is what the
surfaced candidate does once it is eligible to act. The release fraction
looks remarkably stable across the cases we've measured (~2/3 of the bucket
both on dog/USDC and in the synthetic sweep), which is why it is tempting
to quote as a single number; the ownership threshold is pool-specific and
cannot be quoted as a single universal number.

### Ownership threshold (synthetic-pool-specific)

A synthetic-pool ownership sweep in
`tests/integration/base/helpers/curator-ownership-sweep.ts` fixes the fraction
of the target bucket's deposit the operator controls (the ownership
fraction), and asks whether the simulation-backed search surfaces a
candidate. On a synthetic EMA-initialized two-borrower pool seeded with a
single "other lender" holding a fixed 10k-unit deposit and 5k of debt at
10k of collateral, stepping the operator's share through
`{10%, 30%, 50%, 80%, 95%}`:

| Operator share | Candidate surfaces? | Terminal-rate move (2 updates) | Release fraction (of bucket) |
| --- | --- | --- | --- |
| 10% | No | n/a | n/a |
| 30% | No | n/a | n/a |
| 50% | No | n/a | n/a |
| 80% | No | n/a | n/a |
| **95%** | **Yes** | +147 bps (baseline 1464 → candidate 1611) | ~63% |

So on this specific synthetic pool the surfacing threshold for operator
ownership sits between 80% and 95%. **The threshold number is
configuration-specific, not a universal constant.** The pool's debt/deposit
ratio, EMA state, deposit distribution across other buckets, and target
offset all affect the rate-response-per-withdrawn-unit and therefore the
minimum ownership that produces a beat-passive improvement. A pool with
more debt relative to deposit, or a thinner deposit distribution, would
likely have a lower threshold.

The real-chain data is consistent with the synthetic finding:

- **dog/USDC (~100% operator ownership)**: surfaces and executes end-to-end.
- **PRIME/USDC (~9% operator ownership)**: does not surface.

Both are well outside the 80–95% synthetic-threshold band, so we cannot tell
from these two real archetypes alone whether the threshold in a pool that
looked like PRIME/USDC would actually sit at 80%, 50%, or elsewhere — only
that 9% is too low and 100% is enough.

### Why the release fraction consistently lands at ~2/3

Both the real dog/USDC result and the synthetic 95%-ownership trial settled
on a release of ~2/3 of the operator's maxWithdrawable. This is not a
search-grid coincidence — it is where the Ajna protocol's STEP_UP condition
actually crosses on these pools.

An empirical rate-response probe (see
`tests/integration/base/helpers/curator-rate-response-probe.ts`) fixes
the operator's withdrawal fraction across a fine grid, realises the
`removeQuoteToken` on a fresh fork of dog/USDC, warps to the next two Ajna
rate-update boundaries, and records the realised `interestRateInfo` after
each:

| Withdrawal fraction of operator LP | Rate after 1st update | Rate after 2nd update | 2-update move |
| --- | --- | --- | --- |
| 10% – 66% | 275 | 275 | **0 bps** |
| **66.5%** | **303** | **333** | **+58 bps** ⬆ |
| 67% – 93% | 303 | 333 | +58 bps |
| **93.5%** (narrow hole) | **275** | **275** | **0 bps** |
| 94% – 99% | 303 | 333 | +58 bps (timing-sensitive near 94%) |
| **100%** | **275** | **275** | **0 bps** ⬇ |

Two distinct cliff structures:

**Lower cliff (between 66% and 66.5%).** Below 66% the `MAU / TU` ratio after
one rate-update boundary does not cross the STEP_UP threshold, so passive
`NO_CHANGE` wins. Above 66.5% it does. This is a sharp, reproducible
boundary.

**Upper region (93%–100%) is non-monotonic, not a clean cliff.** We observed:

- A narrow `NO_CHANGE` hole at 93.5%, surrounded by working values on both
  sides (93%, 94% both produce +58 bps).
- A repeat run flipped the 94% result between `+58` and `0` for the
  identical withdraw amount. The fork is pinned to the same block and the
  withdraw args are byte-identical — the only variable is the exact
  `block.timestamp` anvil assigns when we warp 12h+1s past the last update.
  Near the STEP_UP / NO_CHANGE boundary the EMA-update math is sensitive
  enough that microsecond-scale timing differences change which side we
  land on.
- A deterministic `NO_CHANGE` at 100%: emptying the bucket entirely shifts
  the LUP (lowest-utilized price) upward, which increases the `lupt0DebtEma`
  input to `TU`, rebalancing `MAU / TU` back into the NO_CHANGE band.

The safe, robust operational window is **~67% to ~90%** of operator LP.
Inside this range the rate response is deterministic and reproducible. The
keeper's hardcoded `2/3` search anchor sits exactly at the low end of this
band. Above 90%, treat the response as cliff-adjacent and avoid relying on
it: small protocol-level timing variation or state perturbation can flip the
outcome.

What this means for the "2/3" observation:

- The keeper's `buildHighEndExposureFractionAnchorAmounts` hardcodes anchors
  at `{2/3, 3/4, 9/10, 1/1}` of maxWithdrawable, then the search returns the
  smallest improving anchor. On dog/USDC the lower cliff is at ~66.5%, so
  2/3 (66.67%) is the smallest anchor that just clears the STEP_UP
  condition.
- Without the 2/3 anchor, the search's other amount generators
  (`buildOneTwoFiveSearchAmounts` + mirrored top-end points) would mostly
  skip the 65%–70% band and probably return 3/4 or 9/10 instead. That would
  still be a working candidate but less capital-efficient than the 2/3
  anchor allows.
- The 9/10 anchor is near the edge of the reliable window and the 1/1
  anchor is in the 100% reversal zone. The search returning 2/3 (the
  smallest anchor) is actually the safest choice — it keeps the release
  firmly inside the reproducible `[~67%, ~90%]` band and well away from the
  cliff-adjacent 93%–100% region on dog/USDC.

### The cliff is pool-shape-specific (not a universal constant)

A two-shape synthetic comparison (see
`tests/integration/base/helpers/curator-rate-response-synthetic.ts`) runs
the same fine-grained withdrawal-fraction sweep on two different pool
shapes at fixed 95% operator ownership:

| Pool shape | Debt / total-deposit ratio | Starting rate | Withdrawal-fraction cliff |
| --- | --- | --- | --- |
| Shape A (baseline) | 5k / 200k ≈ 2.5% | 1331 bps | **Between 30% and 50%** |
| Shape B (5× debt) | 25k / 200k ≈ 12.5% | 729 bps | **No viable cliff** — all fractions produce STEP_DOWN |
| dog/USDC (real) | pool-specific | 275 bps | **Between 66% and 66.5%** |

Shape A's cliff sits near 40%, not 67%. At 30% withdrawal the rate steps up
on the first update (1331 → 1464) but then falls to 1000 via `RESET_TO_TEN`
— Ajna's safety net firing when the rate is above 10% and utilization drops
far enough. The trajectory is net −331 bps for a 30% withdrawal. From 50%
onward, both updates STEP_UP cleanly (1331 → 1464 → 1610 = +279 bps).

Shape B produces no improvement at any fraction. Increasing debt 5× while
holding the deposit structure fixed places the pool in a regime where
withdrawing the operator's LP can't shift `MAU / TU` past the STEP_UP
threshold — all withdrawals result in STEP_DOWN on both updates.

Takeaways:

- **There is no universal 2/3 rule.** The cliff position is a function of
  the pool's debt / deposit ratio, EMA state, and target offset. Dog/USDC
  and the synthetic 95%-ownership single-shape trial both happen to have
  cliffs near 2/3 because their pool states are shaped similarly. A pool
  with a lower debt/deposit ratio can cliff at 40% or lower; a pool with
  a higher debt/deposit ratio may cliff nowhere in `(0, 1)`.
- **The search's hardcoded 2/3 anchor is the right default but not
  capital-optimal on every pool.** On Shape A the operator could safely
  withdraw as little as 50% and still hit +279 bps, but the search would
  still return 2/3 because it's the smallest *anchor* that the
  high-end-anchor generator emits. Operators who want minimum-release
  outcomes on light-debt pools could get more capital efficiency by
  widening the anchor set; the current code doesn't do this.
- **Some pools are "curator-untouchable" regardless of ownership.** Shape B
  is an example: no fraction produces improvement. Operators on
  high-debt-ratio pools should not expect the keeper to be able to steer
  the rate upward via REMOVE_QUOTE at all.

This reinforces the operator-facing rule stated earlier: the dry-run is the
only definitive per-pool test. If a candidate surfaces, the keeper has found
a viable withdrawal; if not, no tuning of release fractions (hardcoded or
otherwise) will change the action space.

The lower cliff is protocol-level (MAU/TU threshold shaped by pool state);
the 100% reversal on dog/USDC is protocol-level too (bucket-empty LUP
shift); Shape B's "no-cliff" regime is also protocol-level (pool state
outside curator-addressable envelope). None of these are keeper-tunable
knobs.

### Practical rule for operators

Curator mode requires (a) an EMA-initialized pool and pre-window timing
(the managed-eligibility gate enforces this automatically), and (b) enough
operator ownership of the target bucket that the rate-sensitive release
fraction (~2/3 of the bucket) translates into an absolute rate move large
enough to beat passive over the 2-update horizon. How much ownership is
"enough" is pool-specific; the dry-run answers it definitively for any
given pool state. If a candidate surfaces, the ownership is sufficient; if
not, it isn't, and no config tuning will change that. Treat the dog/USDC
result as an existence proof for a high-concentration position; treat the
80–95% number as evidence that a significant minority share will not
surface on *this* synthetic pool, not as a universal minimum.

This is tracked and continuously re-verified in
`tests/integration/base/curator.ts` via
"probes curator-mode REMOVE_QUOTE across every pinned managed archetype and
verifies realized rate matches prediction for every archetype that surfaces"
— when additional archetypes start surfacing candidates, they will be covered
automatically by the same realized-rate invariant.

Managed `REMOVE_QUOTE + DRAW_DEBT` (dual mode) remains **research**: manual
probes still find some improvements on hand-picked states, but the exact
simulation-backed synthesis has not surfaced a dual candidate on any pinned
archetype, even with the lender bucket and borrow limit indexes explicitly
seeded.

### Why dual mode does not surface on PRIME/USDC

A debug trace over the dual exact synthesis on PRIME/USDC
(`tests/integration/base/curator.ts` → "diagnoses why dual REMOVE_QUOTE +
DRAW_DEBT does not surface on PRIME/USDC") instruments
`synthesize/dual/exact.ts` via `setDualSynthesisDebugTrace` and records every
`(removeQuoteAmount, drawDebtAmount, limitIndex, collateralAmount)` tuple
the search evaluates, along with the verdict.

On PRIME/USDC, the search evaluates **288 tuples across 8
limit-index/collateral combinations**. The results:

| Metric | Value |
| --- | --- |
| Total evaluations | 288 |
| Evaluation failures (`simulatePath` threw) | **270 (94%)** |
| Improving candidates | **0** |
| Successful evaluations | 18 (6%) |
| All successful tuples converge on | `quoteAmount = 1 wei, drawDebtAmount ≈ 3.9 WAD (~4 USDC)` |
| Best terminal distance | 219 bps (equal to passive baseline) |

The failure pattern by limit index is telling:

- **Lower limit indexes (500, 1000, 2658, 3158, 3408)**: every `drawDebt`
  call reverts (36/36 failures per limit). These correspond to higher price
  constraints — the pool's HTP (highest threshold price) exceeds the
  requested limit, so Ajna's drawDebt precondition fails.
- **Higher limit indexes (3506, 3558, 3608)**: `drawDebt` succeeds only for
  tiny amounts (~4 USDC). Larger amounts revert because the existing
  borrower is near collateralization limits.

**Classification: structural / real-pool-constraint issue**, not a
search-quality issue. The pool's borrower state genuinely doesn't leave
headroom for the keeper to construct a dual action that meaningfully moves
the rate. The 6% of tuples that execute without reverting are too small to
perturb the deposit/debt EMAs enough to cross the STEP_UP threshold — all
land on the same terminal rate as passive.

This is the same family as Shape B in the synthetic ownership sweep
(curator-untouchable regime): a pool state where no REMOVE_QUOTE +
DRAW_DEBT combination can produce a rate response, regardless of how the
search grid is tuned.

### What would make dual mode ship-able

For dual exact synthesis to surface a candidate, we would need a pinned
managed archetype where all of these hold simultaneously:

1. Operator owns the overwhelming majority of a target bucket (per the
   single-action ownership-threshold finding).
2. Operator is also a borrower on the same account (`sameAccountManagedBorrower`).
3. The borrower has enough collateral headroom that `drawDebt` succeeds at
   meaningful amounts (not just ~4 USDC).
4. The combined action shifts `MAU / TU` past the STEP_UP threshold for at
   least one of the lookahead updates.
5. *And*: single-action alone must **not** already saturate the STEP_UP cap.
   Ajna caps rate moves at two STEP_UPs over a 2-update lookahead, so if
   REMOVE_QUOTE alone reaches terminal = baseline × 1.10² then the dual path
   cannot strictly improve on it.

### Empirical test of (1)–(4): the dual code works, the regime is narrow

A synthetic ownership sweep that satisfies conditions (1)–(4) by
construction (95% operator ownership + same-account borrower + 20×
collateral headroom) confirms:

| Ownership | Passive trajectory | Single-action REMOVE_QUOTE | Dual best terminal | Dual surfaces? |
| --- | --- | --- | --- | --- |
| 95% | 1100 → 1000 → ~900 (step-down) | **Surfaces** at terminal 1210 (distance 40) | 1210 (same as single) | **No** (cannot beat single) |
| 75% | 1331 → 1464 → 1611 (already overshoots target 1531±50) | Does not surface (no action needed) | 1611 (same as passive) | No (no improvement needed) |
| 55% | Same as 75% | Does not surface | 1611 (same as passive) | No (no improvement needed) |

Across all three ownership levels the dual-synthesis evaluate loop runs
cleanly — 288 tuples per level, ~50% success rate on `simulatePath` (vs
PRIME/USDC's 6%). The dual code produces valid rate-response simulations.
It just never produces a candidate that strictly improves on the best
alternative, because:

- **At 95% ownership**: single-action REMOVE_QUOTE already achieves
  `2 × STEP_UP` terminal, which is the protocol-imposed ceiling for a
  2-update lookahead. Adding DRAW_DEBT cannot push the rate higher.
- **At ≤75% ownership**: the synthetic warmup lands the pool in a state
  where the passive trajectory already overshoots the target band. No
  keeper action is needed.

Condition (5) is the new operational requirement: the pool state must be
in a narrow marginal regime where single-action cannot quite trigger
both STEP_UPs but dual can. That regime is reachable in principle but
hard to land on empirically — tuning deposit ratios, debt sizes, and
target offsets simultaneously. Finding a real-chain pool in that regime
(or constructing one reproducibly) is the remaining barrier.

### Classification

Dual mode's failure to surface is now pinned to **three** distinct causes,
all confirmed empirically across 8 pinned managed archetypes:

1. **Borrower collateral starvation** (PRIME/USDC pattern): 94% of
   evaluations revert on `drawDebt`. Real-chain pools where the borrower
   is near collateralization limits cannot support meaningful additional
   debt, so dual can never run.
2. **Single-action saturation** (dog/USDC + synthetic 95%): 63% of
   evaluations succeed, but single-action REMOVE_QUOTE alone already hits
   the protocol's 2× STEP_UP ceiling over the 2-update lookahead. Dual
   can't beat what single already reaches.
3. **Passive-trajectory saturation** (pool `0x7b0b` pattern): 33% of
   evaluations succeed, but the passive (no-action) trajectory is already
   STEP_UP-ing at the protocol's 2× cap over the lookahead. The dual
   search confirms it can match that trajectory but cannot exceed it —
   the protocol simply refuses to STEP_UP more than twice in 2 updates.
   Nothing the keeper does can help, because passive is already doing
   the maximum.

Neither is a keeper bug. (1) is a pool-state constraint; (2) and (3) are
protocol-level ceilings interacting with the search's "must strictly
improve" rule.

### Widened empirical sweep — 8 archetypes tested

To confirm the picture wasn't a fluke of the original 5 archetypes, a
discovery-script sweep over `ajna.info.finance` added 3 more pinned
archetypes (pool `0x7b0b85c8`, pool `0x2a869a39`, and a second actor on the
existing PRIME/USDC pool `0x1abc629d`). Running the multi-archetype probe +
dual-diagnostic trace on all 8:

| Archetype | Eligible? | Single surfaces? | Dual surfaces? | Failure category |
| --- | --- | --- | --- | --- |
| `weth-usdc-2024-12-01` | no | n/a | n/a | eligibility: pinned inside rate-update window |
| `2388-2024-04-08` | no | n/a | n/a | eligibility: not EMA-initialized |
| `prime-usdc-2025-10-17` | yes | **no** | **no** | (1) collateral starvation (94% revert) |
| `weth-usdglo-2024-10-03` | no | n/a | n/a | eligibility: not EMA-initialized |
| `dog-usdc-2026-03-18` | yes | **YES** | **no** | (2) single already saturates STEP_UP cap |
| `7b0b-2025-10-25` | yes | no | **no** | (3) passive already saturates STEP_UP cap |
| `prime-usdc-ccad-2025-10-09` | no | n/a | n/a | eligibility: not EMA-initialized |
| `2a869a-2026-04-18` | no | n/a | n/a | eligibility: not EMA-initialized |

Only ONE of eight (`dog-usdc`) surfaces a working single-action candidate.
ZERO of eight surface a dual candidate. Five of eight fail the eligibility
gate outright (not EMA-initialized, or in the rate-update window). The
three that pass eligibility each hit a different protocol-level limitation.

### Why the conditions stack unfavorably

The five conditions dual needs are *individually* satisfiable but hard to
stack. Among actual-chain managed pools found on Base:

- Most managed pools are young (transferred LP, recent borrower). Young
  pools have uninitialized EMAs and fail eligibility.
- Among older managed pools with initialized EMAs: concentrated ownership
  tends to correlate with single-action saturating, because a highly-owned
  bucket has enough LP to trigger 2× STEP_UP on release alone.
- Pools where passive is naturally STEP_UP-ing (like `0x7b0b`) don't need
  any action — the protocol is already doing the work.
- Pools where the borrower has already maxed their collateralization are
  common in the "active steering" scenarios where dual would theoretically
  help — but they're also exactly where dual can't run.

The empirical conclusion: **the pool-state regime where dual is both
feasible AND useful is either very rare or effectively empty on Base**.
The discovery script found 12 same-account managed archetypes across
the chain's history; none of the 4 in our expanded sweep (dog/USDC's
single already suffices; 7b0b's passive already suffices; PRIME has two
actors both with collateral problems; 2a869a / weth-usdglo not
EMA-initialized) fall into the dual-useful regime.

### Cross-chain expansion — same conclusion, more evidence

A mainnet discovery run against the ajna.info API found 16 same-account
managed archetypes on Ethereum. The top two (chosen for concentrated
ownership + collateral headroom) were probed:

| Pool (mainnet) | Pair | Ownership | On-chain collateral vs debt | noOfLoans | Dual result |
| --- | --- | --- | --- | --- | --- |
| `0x660ae24a` | scrvUSD/crvUSD | 100% | 45.76 / 10.05 (~4.5× headroom) | **1** | single-action saturation (288 evals, best terminal matches single) |
| `0xb3f52e1f` | DMusd/USDC | 100% | on-chain differs from API | **1** | collateral starvation (288 evals, **100% revert rate**) |

Both are solo-borrower pools — operator is the only active loan. This
originally looked like a fifth failure mode, but on inspection the gate
`noOfLoans > 1n` was overly conservative for managed-dual: if the operator
IS the pool's single loan, rate projections are *more* reliable (they
control both sides of MAU). The check was protecting against "fresh pool
with no real activity" but managed-dual has a different invariant.

### The gate relaxation

The `noOfLoans > 1n` check was relaxed to `noOfLoans >= 1n` in three
managed-specific paths:

- `src/ajna/adapter/managed-diagnostics.ts:79-87` — eligibility flag
- `src/ajna/adapter/snapshot-source.ts:687-702` — multi-cycle dual gate
- `src/ajna/synthesize/dual/exact.ts:429-446` — protocolShapedManagedDualSearch

The relaxation is guarded: only the managed-dual path uses the looser gate;
the generic ADD_QUOTE dual path and non-managed paths keep the stricter
`> 1n` check (where it's semantically appropriate — multi-cycle lookahead
does benefit from background loan activity when the keeper isn't the
dominant actor).

After the relaxation the mainnet probes became eligible and dual synthesis
ran (288 evaluations each), but:

- scrvUSD/crvUSD: single-action saturation (classification 2 above) — dual
  can't beat single's terminal
- DMusd/USDC: 100% `drawDebt` revert rate (classification 1 above) — API's
  "481× headroom" claim didn't match actual on-chain state at the pinned
  block

So **relaxing the gate confirmed the original finding**: the dual regime
is empty even on solo-borrower pools where the gate was previously the
only thing blocking the path. Across 8 Base archetypes + 2 mainnet
archetypes (10 total surveyed under the relaxed gate): zero surface dual.

### Stopping point

Without a pinned archetype that satisfies all five conditions
simultaneously (or a realistic mechanism for the keeper to construct one),
dual mode cannot ship. Future research would need to either:

- Find such a pool organically on Base (the discovery script can be re-run
  periodically as new curator-like actors emerge).
- Construct a synthetic fixture tuned into the marginal regime (deposit
  sizes / debt / target offset all calibrated so single-action triggers 1
  STEP_UP but dual triggers 2). This was attempted in the synthetic
  ownership sweep; no configuration tested landed in that band.
- Expand the dual synthesis to consider `ADD_COLLATERAL + DRAW_DEBT +
  REMOVE_QUOTE` triples, which would let the keeper create collateral
  headroom in pools like PRIME/USDC (but adds capital lockup).

None of these are low-effort. Given the data, the realistic product
recommendation is to treat dual as permanent research until and unless
one of these paths becomes concretely viable.

**Note on `setDualSynthesisDebugTrace`:** this is a module-level listener
hook added specifically for this diagnostic. Production paths leave it
unset; the emit call is a cheap conditional check. Keep it in place — it's
how the next investigation (if/when a dual-eligible archetype appears) will
characterize whether the search is landing on improving tuples.

## Current Keeper State

Today, the keeper is strongest at:

- downward control on brand-new and representative used pools
- upward control on brand-new pools through exact multi-cycle `BORROW`
- representative due-window exact `LEND_AND_BORROW`

The main unresolved gap is still generic upward control on used pools.

The important used-pool result is narrower:

- targeted exact managed `REMOVE_QUOTE` now surfaces on at least one pinned actual-chain managed state, AND the planned action has been verified to execute on-chain against the fork with the realized rate matching the simulator prediction exactly
- bounded manual managed `REMOVE_QUOTE + DRAW_DEBT` can still improve some hand-picked managed states, but the earlier PRIME/USDC positive no longer holds on the current rerun
- generic managed upward search still does not surface broadly on its own

So curator-only `REMOVE_QUOTE` is a supported product path for operators with existing inventory in a pinned archetype; dual mode is still research; generic discovery remains out of scope.

## What Curator Mode Means

Curator mode assumes the operator is not a cold-start outsider. The operator is already materially present in the pool state that Ajna uses for rate formation.

In practice, that means:

- meaningful quote inventory in the buckets that matter for counted / meaningful deposit state
- enough size that outside flow does not immediately wash out the intervention
- optionally a standing borrower position when dual-side control is needed

This does not require being the largest participant in the whole pool. It does require being large enough in the relevant buckets to move the state Ajna actually reacts to.

## Feasible Steering By Direction

### Downward

Downward steering is the cleaner curator path.

Primary action:

- `ADD_QUOTE`

Operationally, this is just more quote deployed into the pool plus gas. It does not require new debt and does not require added collateral.

### Upward

Upward steering on used pools looks realistic only in inventory-backed form.

Primary action family:

- `REMOVE_QUOTE`

Experimental follow-on:

- `REMOVE_QUOTE + DRAW_DEBT`

This is the key product shift. For mature pools, used-pool upward control looks more like deposit management than borrower-only nudging.

## Capital Model

### Downward Cost

Downward curator control costs:

- quote capital deposited
- gas

Economic tradeoff:

- more capital is at risk in-pool
- that capital cannot be used elsewhere while deployed

### Upward Remove-Only Cost

Managed `REMOVE_QUOTE` changes the deposit side without taking on fresh debt.

Cost is mainly:

- reduced in-pool quote exposure
- reduced lending yield on the withdrawn inventory
- gas

This is often cleaner than borrower-led upward steering because it does not add debt just to move the rate.

### Upward Dual Cost

Managed `REMOVE_QUOTE + DRAW_DEBT` adds a second cost layer:

- reduced in-pool quote exposure
- borrow debt carry
- gas

This can be more powerful in some states, but it is not exact-surfaced reliably enough yet to treat as supported.

## Capital Efficiency

Curator mode can be capital-efficient if the inventory already exists.

It is usually not capital-efficient if the operator has to build a large lender and borrower footprint purely to steer the pool.

The practical rule is:

- warm inventory-backed control can be efficient
- cold-start used-pool upward control still looks poor

## Recommended Policy

Treat curator mode as a separate operating mode with tighter gates.

### Supported

- used-pool downward steering through existing lend paths
- managed used-pool upward steering through targeted `REMOVE_QUOTE` where the keeper has real lender inventory and the action beats passive by a real margin

### Experimental

- managed `REMOVE_QUOTE + DRAW_DEBT`

The dual branch should only count as meaningful if it beats:

- passive path
- the matching `REMOVE_QUOTE` branch

Otherwise the borrow leg is not earning its complexity or cost.

### Unsupported

- generic cold-start used-pool upward control
- generic borrower-only used-pool upward control
- same-cycle borrower steering as a used-pool upward primitive

## Guard Rails

Curator mode should refuse to act unless all of these are true:

- pool is a used / EMA-initialized state
- direction is upward
- operator has real withdrawable quote inventory in relevant buckets
- projected action beats passive over the configured horizon
- if dual is considered, it also beats the matching remove-only path

Good future guard rails:

- controllability / sensitivity threshold before any upward used-pool action
- minimum improvement margin over passive
- explicit inventory and debt caps

## Current Config Surface

The managed remove-only path is now explicit in keeper config:

- `enableManagedDualUpwardControl`
- `enableManagedInventoryUpwardControl`
- `minimumManagedImprovementBps`
- `maxManagedInventoryReleaseBps`
- `minimumManagedSensitivityBpsPer10PctRelease`
- `removeQuoteBucketIndex`
- `removeQuoteBucketIndexes`

Representative config:

```json
{
  "enableManagedInventoryUpwardControl": true,
  "minimumManagedImprovementBps": 10,
  "maxManagedInventoryReleaseBps": 2000,
  "minimumManagedSensitivityBpsPer10PctRelease": 5,
  "removeQuoteBucketIndexes": [2618]
}
```

Operational meaning:

- the keeper only considers exact managed `REMOVE_QUOTE` when upward control is needed in a used / EMA-initialized pool and it can see real withdrawable lender inventory
- `enableManagedDualUpwardControl` exists for managed dual research, but exact surfaced `REMOVE_QUOTE + DRAW_DEBT` is still not a supported product path
- `minimumManagedImprovementBps` keeps the keeper from releasing inventory for trivial gains
- `maxManagedInventoryReleaseBps` caps one-cycle inventory release as a fraction of total withdrawable managed inventory
- `minimumManagedSensitivityBpsPer10PctRelease` is the controllability gate for managed upward actions
- if the fresh submit-time snapshot no longer satisfies those conditions, the keeper refuses the plan instead of degrading silently

## Operator Reporting

Curator-mode outputs now separate inventory movement from generic capital terms:

- `quoteInventoryDeployed`
- `quoteInventoryReleased`
- `operatorCapitalRequired`
- `operatorCapitalAtRisk`

This matters because `REMOVE_QUOTE` is not borrowed quote. It is released inventory plus reduced in-pool yield exposure.

## Product Boundary

The clean product boundary is:

- default keeper: strong for downward control, strong enough for brand-new upward via multi-cycle `BORROW`
- curator mode: plausible path for used-pool upward control when the operator already has meaningful pool inventory

So the honest message is:

- used-pool upward control is not broadly generic
- used-pool upward control may be viable for managed pools
- the first operationally credible managed path is `REMOVE_QUOTE`, not borrower-only steering

## Next Steps

1. ~~Promote targeted managed `REMOVE_QUOTE` from research into an explicit experimental supported mode.~~ **Done.** The dog/USDC archetype has end-to-end verification (synthesis → planning → on-chain submit → realized rate matching prediction). See the Operator Runbook below.
2. ~~Add a controllability gate so low-sensitivity used-pool upward actions are refused automatically.~~ **Done.** `minimumManagedSensitivityBpsPer10PctRelease` is wired into `managedInventoryGuards` and enforced at both plan time and submit time.
3. Keep managed `REMOVE_QUOTE + DRAW_DEBT` in research until it exact-surfaces on pinned actual-chain managed states, not just manual probes.
4. Keep generic used-pool upward control outside the default supported boundary until inventory-backed managed proofs are broader.
5. Per-bucket recheck: the snapshot now exposes `managedPerBucketWithdrawableQuoteAmount` (a map-encoded string of `idx:amount` pairs). `preSubmitRecheck` validates the specific bucket(s) the plan targets still have enough withdrawable inventory, catching the case where aggregate withdrawable stays positive but the target bucket was drained.
6. Candidate validation signatures: auto-synthesized REMOVE_QUOTE candidates carry a lender-bucket-state fingerprint as `validationSignature`. At recheck, any drift in LP balance, bucket deposit, or LP accumulator for the target bucket produces a clean `CANDIDATE_INVALIDATED` failure rather than relying on implicit amount-in-ID drift.

## Operator Runbook

This section is for an operator with real lender LP in an Ajna pool who wants to
enable curator-mode upward steering. It assumes you have already set up the
keeper CLI and the `AJNA_KEEPER_PRIVATE_KEY` environment variable.

### When this applies

You qualify for curator-mode REMOVE_QUOTE steering if:

- Your account has a nonzero `lenderInfo(bucketIndex, your_address)` LP balance
  in one or more buckets of the pool.
- The pool is EMA-initialized (has `>1` loan and non-zero EMAs). Brand-new pools
  do not qualify.
- The current rate is below your target, and the next eligible rate update is
  at least `minTimeBeforeRateWindowSeconds` away.

### Minimum config

Add these keys to your keeper config (alongside the standard `chainId`,
`poolAddress`, `rpcUrl`, `targetRateBps`, `toleranceBps`, `toleranceMode`,
`completionPolicy`, `maxQuoteTokenExposure`, `maxBorrowExposure`,
`snapshotAgeMaxSeconds`, `minTimeBeforeRateWindowSeconds`, and the minimum
executable amount knobs):

```json
{
  "enableManagedInventoryUpwardControl": true,
  "simulationSenderAddress": "<your on-chain address>",
  "borrowerAddress": "<your borrower address, or same as sender>",
  "removeQuoteBucketIndexes": [<fenwick index of each bucket you hold LP in>],
  "minimumManagedImprovementBps": 10,
  "maxManagedInventoryReleaseBps": 2000,
  "minimumManagedSensitivityBpsPer10PctRelease": 5,
  "enableSimulationBackedLendSynthesis": true
}
```

Leave `enableManagedDualUpwardControl` unset (false) until dual-mode graduates
from research. Enabling it today will not cause the keeper to run dual plans,
but it will populate managed dual diagnostics in the snapshot that have no
production use yet.

### Pre-flight: dry-run before going live

Run the keeper with `--dry-run` (or whatever your entrypoint uses for dry-run)
and inspect the resulting `CycleResult`:

**1. Confirm managed eligibility in the snapshot metadata.**

```jsonc
{
  "managedInventoryUpwardControlEnabled": true,
  "managedInventoryUpwardEligible": true,
  "managedTotalWithdrawableQuoteAmount": "<non-zero wad>",
  "managedPerBucketWithdrawableQuoteAmount": "<idx>:<amount>,<idx>:<amount>"
}
```

If `managedInventoryUpwardEligible` is `false`, read
`managedInventoryIneligibilityReason`. Common reasons:

- *"the current target does not require upward steering"* — your target is
  already reached; no action needed.
- *"managed inventory upward control currently only runs before the next
  eligible rate update"* — the next rate-update window has already opened;
  wait for the next one.
- *"managed inventory upward control is only modeled on EMA-initialized used
  pools"* — the pool is brand-new; curator mode doesn't apply. Use the default
  keeper lend path instead.
- *"no withdrawable quote inventory was found in the configured or derived
  managed buckets"* — your LP is not in the buckets listed in
  `removeQuoteBucketIndexes`, or the buckets are empty. Double-check your
  bucket list against `lenderInfo(bucketIndex, your_address)` on the pool.
- *"exact managed inventory control requires a resolvable simulation
  sender/private key"* — `AJNA_KEEPER_PRIVATE_KEY` is missing or the address
  it derives does not match `simulationSenderAddress`.

**2. Confirm the candidate that the planner selected.**

In the `CyclePlan` output, verify:

- `intent: "LEND"` (not `"NO_OP"`)
- `requiredSteps` contains a `REMOVE_QUOTE` step for your bucket, with an
  `amount` that's less than `maxManagedInventoryReleaseBps / 10000` of your
  total withdrawable inventory.
- `predictedRateBpsAfterNextUpdate` is closer to your target than
  `snapshot.predictedNextRateBps` by at least `minimumManagedImprovementBps`.
- The selected candidate's `validationSignature` is non-empty. This binds the
  plan to the exact bucket state it was synthesized against; any change in
  your LP balance before submit will cause a clean abort.

**3. Confirm the guard rails are active.**

Temporarily tighten `minimumManagedSensitivityBpsPer10PctRelease` above what
you see the plan delivering, and confirm the cycle now returns `NO_OP` with
reason code `MANAGED_CONTROLLABILITY_TOO_LOW`. Restore your real value once
you've seen the guard fire.

### After a live cycle runs

Verify in the `CycleResult`:

- `status: "EXECUTED"`
- `transactionHashes` has one hash per executed step
- `executedSteps` contains the REMOVE_QUOTE you planned

Then, after the next Ajna rate-update window (up to 12 h later), read
`interestRateInfo()` on the pool. The new rate should match
`predictedRateBpsAfterNextUpdate` from the plan. For multi-cycle plans
(`planningLookaheadUpdates === 2`), the rate after the second update should
match `planningRateBps`.

### Safety properties that catch mistakes

These run automatically at submit time and will abort the cycle cleanly
(with a specific `GuardFailure` code) rather than submitting a bad transaction:

- **`MANAGED_CONTROL_UNAVAILABLE`** — eligibility flipped, totals disappeared,
  or the specific target bucket no longer has enough withdrawable inventory.
- **`MANAGED_RELEASE_CAP_EXCEEDED`** — plan would release more than
  `maxManagedInventoryReleaseBps` of your total inventory in a single cycle.
- **`MANAGED_CONTROLLABILITY_TOO_LOW`** — plan no longer clears the
  improvement floor or sensitivity gate in the fresh snapshot.
- **`CANDIDATE_INVALIDATED`** — bucket state drifted between planning and
  submission (LP transferred, deposit accrued differently, etc.).
- **`EXPIRED_STEP`** — the plan sat too long and a step's expiry has passed.
- **`STALE_SNAPSHOT`** / **`UNSAFE_TIME_WINDOW`** — snapshot aged out or we
  hit the rate-update boundary before submit.

If any of these fire on a live run, the keeper logs the reason and takes no
on-chain action; re-running the cycle with a fresh snapshot is safe.

### What NOT to do

- **Do not enable `enableManagedDualUpwardControl: true` on a live pool.** The
  dual synthesis doesn't produce exact candidates reliably yet; at best you
  will get the same REMOVE_QUOTE candidate the single-action path produces,
  at worst you will confuse yourself with additional dual-mode diagnostics
  that have no production meaning.
- **Do not rely on a single successful cycle as proof the rate moved.** Ajna
  rates update on 12 h minimum intervals; a successful REMOVE_QUOTE only
  produces the predicted rate after the next update (not on the same block).
- **Do not reuse the same bucket indexes across pools.** Ajna fenwick indexes
  encode the price level per pool's quote/collateral decimals; bucket 6003 in
  one pool is a different price point from bucket 6003 in another.

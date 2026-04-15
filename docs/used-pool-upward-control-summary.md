# Used-Pool Upward Control Summary

## Executive Summary

The keeper is in a good state for:

- downward control across brand-new and representative used pools
- upward control on brand-new pools via exact multi-cycle `BORROW`
- representative due-window dual execution and pre-window lend research

The main unresolved product gap is still upward control on used pools.

After synthetic fixtures, boundary-ranked borrower probes, protocol-shaped approximations, pinned real used-pool states, and pinned paired lender-borrower dual probes, the current evidence is:

- generic borrower-only used-pool upward control is not routine-supported
- generic paired `LEND_AND_BORROW` upward control on pinned real used-pool states is also not surfacing
- a new exact `REMOVE_QUOTE` synthesis branch now exists for used-pool upward states with real lender inventory, but the pinned real used-pool archetype probe is still negative
- a new exact `REMOVE_QUOTE + DRAW_DEBT` branch now exists for same-account managed-pool states, but the pinned paired dual probe is still negative
- a broadened discovery pass that mined recent pool activity for same-address `drawDebt` plus `addQuoteToken` actors across recent real pools still did not find promotable same-account managed archetypes
- a targeted deep-history pass over the three pinned real used-pool archetypes also returned no same-account managed matches across a 6M-block lookback
- the realistic remaining path is likely inventory-backed control, not cold-start borrower steering

## Current Keeper State

### What is working

- Brand-new pools moving down:
  - proven via repeated update-only convergence
  - representative due-window `LEND` planning is proven

- Brand-new pools moving up:
  - supported through representative exact multi-cycle `BORROW`
  - same-cycle borrower steering is still unsupported

- Existing used pools moving down:
  - representative due-window `LEND` is proven
  - deterministic exact pre-window surfaced-plan coverage exists
  - broader pre-window lend execution remains experimental, but real

- Mixed two-sided correction:
  - representative due-window exact `LEND_AND_BORROW` execution is proven

- Safety / operations:
  - gas cap enforcement exists
  - dry-run is explicit in results
  - heuristic plans are advisory by default
  - capital metrics and planning horizon are surfaced

### What is not working broadly

- Exact same-cycle borrower steering
- Generic borrower-only upward control on used pools
- Generic paired `LEND_AND_BORROW` upward control on pinned real used-pool archetypes
- Abandoned-pool recovery as a separately proven end-to-end live mode

## Key Technical Conclusion

The current synthesized control space is skewed toward:

- `ADD_QUOTE`
- `DRAW_DEBT`
- `ADD_QUOTE + DRAW_DEBT`

That is not necessarily the right action space for used-pool upward control.

For mature pools, the more realistic control problem is likely:

- managing the deposit side directly with standing inventory
- managing the debt side with a standing borrower position
- evaluating those changes over multiple updates, not same-cycle

In other words, used-pool upward control probably needs to look like:

- `REMOVE_QUOTE`
- `REMOVE_QUOTE + DRAW_DEBT`

not:

- cold-start `DRAW_DEBT`
- `ADD_QUOTE + DRAW_DEBT`

## Practical Interpretation

If the operator is not already materially involved in the used pool, upward control does not currently look realistic.

The plausible control model is:

- the operator is already a relevant lender in the buckets that matter for Ajna's counted / meaningful deposit state
- the operator likely also maintains a standing borrower position
- the operator adjusts those positions over multiple update windows

So the realistic used-pool upward path is not "show up late and borrow a bit."

It is closer to:

- maintain meaningful quote inventory in-pool
- maintain a live borrower position
- use inventory-backed controls to influence debt and deposit state over time

## What The Recent Research Established

### Negative results that now look robust

- Representative used-pool borrower-only upward probes stayed negative
- Large used-pool multi-week borrower replay surfaced real debt addition without beating the passive path
- Pinned real used-pool upward archetypes did not surface a generic exact upward simulation candidate
- Even when those same pinned real used-pool states were paired with recent real lender addresses mined from quote-token transfers into the pool, the generic exact paired `LEND_AND_BORROW` search still did not surface an upward candidate
- Even after mining recent pool activity directly for same-address borrower+lender actors, the discovery pass still did not find pinned same-account managed archetypes worth promoting into coverage
- Even after running a deeper historical search over the known pinned pools themselves, the discovery script still returned `focusedManagedMatches: []`

### What those negatives likely mean

These results now look more like an action-space problem than a simple search-quality problem.

We have searched:

- synthetic fixtures
- richer ongoing fixtures
- protocol-shaped approximations
- pinned real pool states
- pinned paired lender-borrower states

The boundary is now strong enough that continuing to widen the same search family is unlikely to change the product conclusion materially.

## Recommended Product Boundary

Treat the keeper as:

- strong for downward convergence
- strong enough for brand-new upward convergence through multi-cycle `BORROW`
- not yet a generic used-pool upward controller

Used-pool upward control should currently be described as:

- research / experimental
- only plausibly viable for operators with meaningful existing inventory in the pool

## Recommended Next Engineering Step

The next serious engineering step should still not be more borrower-only search widening.

The first inventory-backed steps are now in place:

1. lender-position reads for withdrawable quote inventory
2. exact simulation-backed `REMOVE_QUOTE` synthesis for tightly gated used-pool upward states
3. exact simulation-backed `REMOVE_QUOTE + DRAW_DEBT` synthesis for tightly gated same-account managed-pool states

That did not change the current product boundary, so the next serious step is:

4. If research continues, move to a richer protocol-state archive or explicitly hand-curated historical states from external pool analytics, not more RPC-only generic discovery.
5. Add a controllability gate so the keeper refuses low-sensitivity used-pool upward interventions.

## Recommended Product Policy

For now:

- support new-pool upward control through exact multi-cycle `BORROW`
- support used-pool downward control through the existing proven lend paths
- keep used-pool upward control out of the supported default product boundary
- only revisit supported used-pool upward control after `REMOVE_QUOTE`-based managed-pool probes exist

## Verification Basis

This summary reflects the current verified repo state, including:

- `npm run verify`
- `npm run test:integration:base`
- `npm run test:integration:base:slow`
- pinned real used-pool upward experimental probe
- pinned paired lender-borrower dual experimental probe

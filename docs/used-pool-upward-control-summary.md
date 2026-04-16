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
- a new exact `REMOVE_QUOTE` synthesis branch now exists for used-pool upward states with real lender inventory
- a new exact `REMOVE_QUOTE + DRAW_DEBT` branch now exists for same-account managed-pool states
- a broadened discovery pass that mined recent pool activity for same-address `drawDebt` plus `addQuoteToken` actors across recent real pools still did not find promotable same-account managed archetypes
- a targeted deep-history pass over the three pinned real used-pool archetypes also returned no same-account managed matches across a 6M-block lookback
- an actor-focused historical pass over the known live borrower addresses also returned no same-account managed matches on the actual pools they currently control
- a hand-picked `ajna.info.finance` indexed Base WETH/USDC state did surface a real same-account managed archetype with both nonzero debt and nonzero deposited quote in the same pool, so managed actual-chain states do exist even though the generic raw-RPC discovery passes were negative
- expanding that approach to multiple hand-picked `ajna.info.finance` managed states produced multiple real same-account borrower+lender actual-chain archetypes
- the generic snapshot path across those hand-picked managed states still does not surface inventory-backed candidates on its own
- a manual bounded `REMOVE_QUOTE` sizing probe now has a real 2-update positive on the dog/USDC managed archetype `0xb156f09e8ab6756cd23cf283d495ab75f8334104`
- a targeted exact seeded `REMOVE_QUOTE` candidate now surfaces on that same dog/USDC archetype when the lender bucket is pinned into the planner
- bounded manual `REMOVE_QUOTE + DRAW_DEBT` probes can still improve some hand-picked managed states, but the previously cited PRIME/USDC positive does not hold on the current rerun once the dual branch has to beat the matching `REMOVE_QUOTE` branch
- even with the lender bucket and productive borrow limit indexes seeded, the exact surfaced `REMOVE_QUOTE + DRAW_DEBT` path is still not appearing on PRIME/USDC
- the realistic remaining path is likely inventory-backed control, not cold-start borrower steering

For the operator-facing managed-pool framing of that path, see [Curator Mode](./curator-mode.md).

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
- Even after restricting the search to the known live borrower addresses and the pools they currently control, the discovery script still returned `curatedActorManagedMatches: []`
- Parsing the public `ajna.info.finance` index directly produced multiple real same-account managed archetypes on Base:
  - pool `0x0b17159f2486f669a1f930926638008e2ccb4287`
  - actor `0x0ecdf706d25f9ded9cb68a028376cfc2eaf212c0`
  - indexed event window around block `23,139,570` on December 1, 2024
  - same pool state includes both nonzero debt and nonzero deposited quote for that actor
  - pool `0x238862f4d2f3a3c6808736aa6fead766c2296d2d`
  - actor `0x72f85a69b79954ffd253ac0b8a37fb26d1a84917`
  - indexed event window around block `12,904,736` on April 8, 2024
  - same pool state includes concentrated same-account borrower debt and live transferred LP inventory
  - pool `0x1abc629d901100218cdfd389e6e778b9399e9f70`
  - actor `0x41c7b055ff83c33915242c2642640b9b35dea840`
  - indexed event window around block `36,968,900` on October 17, 2025
  - same pool state includes both nonzero debt and nonzero deposited quote for that actor
  - pool `0xc73d1e1b5463920325ae42318a20f88181617185`
  - actor `0xddf9e5a32f83ea24eb8dbae02e9890c80c06ea13`
  - indexed event window around block `20,586,751` on October 3, 2024
  - same pool state includes both nonzero debt and nonzero deposited quote for that actor
- The generic exact keeper probe still does not surface inventory-backed candidates across that managed-state set on its own
- A manual bounded `REMOVE_QUOTE` amount grid now improves the 2-update path on the dog/USDC managed state:
  - pool `0xb156f09e8ab6756cd23cf283d495ab75f8334104`
  - actor `0x7500c95cc6f6c9ede82d4043f9337715360d6b6a`
  - the improvement appears at high-end withdrawals around `75%` to `90%` of available quote
- After widening the exact multi-cycle remove-quote search to preserve those high-end managed-pool anchors, a targeted seeded exact `REMOVE_QUOTE` candidate now surfaces on that same dog/USDC state
- A rerun of the bounded manual dual probes tightened the real dual boundary further:
  - some hand-picked managed states can still show manual `REMOVE_QUOTE + DRAW_DEBT` improvement
  - the previously cited PRIME/USDC positive does not hold on the current rerun once the dual branch has to beat the matching `REMOVE_QUOTE` branch
  - so PRIME/USDC is no longer a trusted manual-positive reference state
- Even after seeding the exact planner with the known lender bucket, and for PRIME also seeding the productive limit-index family, the exact surfaced `REMOVE_QUOTE + DRAW_DEBT` planner still does not emit a meaningful dual inventory-backed action automatically

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

That operating model is documented in [Curator Mode](./curator-mode.md).

## Recommended Next Engineering Step

The next serious engineering step should still not be more borrower-only search widening.

The first inventory-backed steps are now in place:

1. lender-position reads for withdrawable quote inventory
2. exact simulation-backed `REMOVE_QUOTE` synthesis for tightly gated used-pool upward states
3. exact simulation-backed `REMOVE_QUOTE + DRAW_DEBT` synthesis for tightly gated same-account managed-pool states
4. pool-aware dual borrow limit-index discovery now seeds from runtime bucket context instead of requiring all dual borrow indexes to be preconfigured

That changed the research boundary but not the supported product boundary, so the next serious step is:

5. Promote the dog/USDC targeted seeded exact `REMOVE_QUOTE` path from experimental research to a more explicit managed-pool supported mode if it stays stable across reruns.
6. If dual-side work continues, first re-derive a trusted pinned-state manual dual positive under the stricter "beat remove-only" rule before trying to surface it exactly.
7. Add a controllability gate so the keeper refuses low-sensitivity used-pool upward interventions.

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

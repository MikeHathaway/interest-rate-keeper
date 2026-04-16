# Curator Mode

## Purpose

This note describes the only used-pool upward-control model that currently looks operationally credible in Ajna:

- the operator already has meaningful quote inventory in the pool
- the operator may also maintain a live borrower position
- the keeper steers with that standing inventory over multiple updates

This is a different product mode from the default keeper boundary.

Without standing inventory, the current evidence still does not support broad used-pool upward control.

## Current Keeper State

Today, the keeper is strongest at:

- downward control on brand-new and representative used pools
- upward control on brand-new pools through exact multi-cycle `BORROW`
- representative due-window exact `LEND_AND_BORROW`

The main unresolved gap is still generic upward control on used pools.

The important used-pool result is narrower:

- targeted exact managed `REMOVE_QUOTE` now surfaces on at least one pinned actual-chain managed state
- bounded manual managed `REMOVE_QUOTE + DRAW_DEBT` can still improve some hand-picked managed states, but the earlier PRIME/USDC positive no longer holds on the current rerun
- generic managed upward search still does not surface broadly on its own

So curator mode is plausible, but it is not yet the default supported used-pool behavior.

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

## Product Boundary

The clean product boundary is:

- default keeper: strong for downward control, strong enough for brand-new upward via multi-cycle `BORROW`
- curator mode: plausible path for used-pool upward control when the operator already has meaningful pool inventory

So the honest message is:

- used-pool upward control is not broadly generic
- used-pool upward control may be viable for managed pools
- the first operationally credible managed path is `REMOVE_QUOTE`, not borrower-only steering

## Next Steps

1. Promote targeted managed `REMOVE_QUOTE` from research into an explicit experimental supported mode.
2. Add a controllability gate so low-sensitivity used-pool upward actions are refused automatically.
3. Keep managed `REMOVE_QUOTE + DRAW_DEBT` in research until it exact-surfaces on pinned actual-chain managed states, not just manual probes.
4. Keep generic used-pool upward control outside the default supported boundary until inventory-backed managed proofs are broader.

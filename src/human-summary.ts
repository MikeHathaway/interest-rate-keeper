import { type CycleResult } from "./types.js";

export function formatCycleCapitalSummary(
  result: Pick<CycleResult, "dryRun" | "status" | "plan">
): string {
  const inventoryBacked = result.plan.requiredSteps.some((step) => step.type === "REMOVE_QUOTE");
  return [
    "summary",
    `dry_run=${result.dryRun ? "true" : "false"}`,
    `status=${result.status}`,
    `intent=${result.plan.intent}`,
    `inventory_backed=${inventoryBacked ? "true" : "false"}`,
    ...(result.plan.selectedCandidateExecutionMode === undefined
      ? []
      : [`candidate_mode=${result.plan.selectedCandidateExecutionMode}`]),
    ...(result.plan.planningLookaheadUpdates === undefined
      ? []
      : [`lookahead=${result.plan.planningLookaheadUpdates}`]),
    ...(result.plan.planningRateBps === undefined
      ? []
      : [`planning_rate=${result.plan.planningRateBps}`]),
    `required=${result.plan.operatorCapitalRequired.toString()}`,
    `at_risk=${result.plan.operatorCapitalAtRisk.toString()}`,
    `net_quote=${result.plan.netQuoteBorrowed.toString()}`,
    `addl_collateral=${result.plan.additionalCollateralRequired.toString()}`
  ].join(" ");
}

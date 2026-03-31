import { type CycleResult } from "./types.js";

export function formatCycleCapitalSummary(result: Pick<CycleResult, "status" | "plan">): string {
  return [
    "summary",
    `status=${result.status}`,
    `intent=${result.plan.intent}`,
    `required=${result.plan.operatorCapitalRequired.toString()}`,
    `at_risk=${result.plan.operatorCapitalAtRisk.toString()}`,
    `net_quote=${result.plan.netQuoteBorrowed.toString()}`,
    `addl_collateral=${result.plan.additionalCollateralRequired.toString()}`
  ].join(" ");
}

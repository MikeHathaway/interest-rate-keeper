import {
  derivePlanCandidateCapitalMetrics,
  resolveCandidateCapitalMetrics
} from "./candidate-metrics.js";
import {
  buildManagedReleaseCapReason,
  buildManagedSensitivityReason,
  buildManagedUnavailableReason,
  managedDistanceImprovementBps,
  managedImprovementBps,
  maximumManagedReleasedQuoteAmount,
  normalizedManagedSensitivityBpsPer10PctRelease,
  stepsUseManagedDual,
  stepsUseManagedRemoveQuote
} from "./managed-controls.js";
import {
  readManagedControlSnapshotMetadata,
  readSnapshotMetadataBoolean,
  simulationExecutionCompatibilityReason
} from "./snapshot-metadata.js";
import {
  type CyclePlan,
  type ExecutionStep,
  type KeeperConfig,
  type PlanCandidate,
  type PoolSnapshot,
  type TargetBand,
  type UpdateInterestStep
} from "./types.js";
import { BPS_DENOMINATOR, BPS_DENOMINATOR_BIG } from "./units.js";

const UPDATE_INTEREST_STEP: UpdateInterestStep = {
  type: "UPDATE_INTEREST",
  bufferPolicy: "none"
};

const ZERO_PLAN_CAPITAL = {
  quoteTokenDelta: 0n,
  quoteInventoryDeployed: 0n,
  quoteInventoryReleased: 0n,
  additionalCollateralRequired: 0n,
  netQuoteBorrowed: 0n,
  operatorCapitalRequired: 0n,
  operatorCapitalAtRisk: 0n
} as const;

function resolveCandidateCapital(candidate: PlanCandidate) {
  return resolveCandidateCapitalMetrics(candidate);
}

function resolvePlanCapital(steps: ExecutionStep[]) {
  return derivePlanCandidateCapitalMetrics(steps);
}

function calculateRelativeTolerance(targetRateBps: number, toleranceBps: number): number {
  return Math.ceil((targetRateBps * toleranceBps) / BPS_DENOMINATOR);
}

export function buildTargetBand(config: KeeperConfig): TargetBand {
  const tolerance =
    config.toleranceMode === "relative"
      ? calculateRelativeTolerance(config.targetRateBps, config.toleranceBps)
      : config.toleranceBps;

  return {
    minRateBps: Math.max(0, config.targetRateBps - tolerance),
    maxRateBps: config.targetRateBps + tolerance
  };
}

export function isRateInBand(rateBps: number, band: TargetBand): boolean {
  return rateBps >= band.minRateBps && rateBps <= band.maxRateBps;
}

export function distanceToTargetBand(rateBps: number, band: TargetBand): number {
  if (rateBps < band.minRateBps) {
    return band.minRateBps - rateBps;
  }

  if (rateBps > band.maxRateBps) {
    return rateBps - band.maxRateBps;
  }

  return 0;
}

function nextMoveWouldOvershoot(snapshot: PoolSnapshot, band: TargetBand): boolean {
  const projectedRateBps = snapshot.planningRateBps ?? snapshot.predictedNextRateBps;

  if (snapshot.currentRateBps < band.minRateBps) {
    return projectedRateBps > band.maxRateBps;
  }

  if (snapshot.currentRateBps > band.maxRateBps) {
    return projectedRateBps < band.minRateBps;
  }

  return false;
}

function rateUpdateIsDue(snapshot: PoolSnapshot): boolean {
  return snapshot.secondsUntilNextRateUpdate <= 0;
}

function naturallyImprovesConvergence(snapshot: PoolSnapshot, band: TargetBand): boolean {
  const currentDistance = distanceToTargetBand(snapshot.currentRateBps, band);
  const projectedRateBps = snapshot.planningRateBps ?? snapshot.predictedNextRateBps;
  const projectedDistance = distanceToTargetBand(projectedRateBps, band);
  return projectedDistance < currentDistance || isRateInBand(projectedRateBps, band);
}

function currentAndProjectedRatesAreInBand(snapshot: PoolSnapshot, band: TargetBand): boolean {
  return (
    isRateInBand(snapshot.currentRateBps, band) &&
    isRateInBand(snapshot.planningRateBps ?? snapshot.predictedNextRateBps, band)
  );
}

function candidateExecutionAllowed(candidate: PlanCandidate, config: KeeperConfig): boolean {
  if (candidate.executionMode === "unsupported") {
    return false;
  }

  return candidate.executionMode !== "advisory" || config.allowHeuristicExecution;
}

function defaultBufferPolicy(step: ExecutionStep): "apply" | "none" {
  switch (step.type) {
    case "ADD_QUOTE":
    case "DRAW_DEBT":
    case "ADD_COLLATERAL":
      return "apply";
    case "UPDATE_INTEREST":
      return "none";
    default:
      return "none";
  }
}

function applyBuffer(amount: bigint, bufferBps: number): bigint {
  if (amount <= 0n || bufferBps <= 0) {
    return amount;
  }

  const delta = (amount * BigInt(bufferBps) + BPS_DENOMINATOR_BIG - 1n) / BPS_DENOMINATOR_BIG;
  return amount + (delta > 0n ? delta : 1n);
}

export function withExecutionBuffer(step: ExecutionStep, config: KeeperConfig): ExecutionStep {
  const policy = step.bufferPolicy ?? defaultBufferPolicy(step);
  if (policy === "none") {
    return step;
  }

  switch (step.type) {
    case "ADD_QUOTE":
      return { ...step, amount: applyBuffer(step.amount, config.executionBufferBps) };
    case "DRAW_DEBT":
      return { ...step, amount: applyBuffer(step.amount, config.executionBufferBps) };
    case "ADD_COLLATERAL":
      return { ...step, amount: applyBuffer(step.amount, config.executionBufferBps) };
    default:
      return step;
  }
}

function maybeAppendUpdateInterest(
  steps: ExecutionStep[],
  snapshot: PoolSnapshot
): ExecutionStep[] {
  if (!rateUpdateIsDue(snapshot)) {
    return steps;
  }

  if (steps.length > 0) {
    return steps;
  }

  return [...steps, UPDATE_INTEREST_STEP];
}

function candidateImprovesConvergence(
  candidate: PlanCandidate,
  snapshot: PoolSnapshot,
  band: TargetBand
): boolean {
  const baselineDistance = distanceToTargetBand(
    snapshot.planningRateBps ?? snapshot.predictedNextRateBps,
    band
  );
  const candidateDistance = distanceToTargetBand(
    candidate.planningRateBps ?? candidate.predictedRateBpsAfterNextUpdate,
    band
  );

  return candidateDistance < baselineDistance;
}

function candidateClearsManagedImprovementThreshold(
  candidate: PlanCandidate,
  snapshot: PoolSnapshot,
  band: TargetBand,
  config: KeeperConfig
): boolean {
  if (!stepsUseManagedRemoveQuote(candidate.minimumExecutionSteps)) {
    return true;
  }

  const minimumManagedImprovementBps = config.minimumManagedImprovementBps ?? 0;
  if (minimumManagedImprovementBps <= 0) {
    return true;
  }

  const baselineDistance = distanceToTargetBand(
    snapshot.planningRateBps ?? snapshot.predictedNextRateBps,
    band
  );
  const candidateDistance = distanceToTargetBand(
    candidate.planningRateBps ?? candidate.predictedRateBpsAfterNextUpdate,
    band
  );

  return (
    managedImprovementBps(baselineDistance, candidateDistance) >=
    minimumManagedImprovementBps
  );
}

function candidateClearsManagedEligibility(
  candidate: PlanCandidate,
  snapshot: PoolSnapshot
): boolean {
  const managedMetadata = readManagedControlSnapshotMetadata(snapshot);
  if (!stepsUseManagedRemoveQuote(candidate.minimumExecutionSteps)) {
    return true;
  }

  if (stepsUseManagedDual(candidate.minimumExecutionSteps) && managedMetadata.managedDualUpwardEligible !== true) {
    return false;
  }

  return managedMetadata.managedInventoryUpwardEligible === true;
}

function candidateClearsManagedReleaseCap(
  candidate: PlanCandidate,
  snapshot: PoolSnapshot,
  config: KeeperConfig
): boolean {
  if (!stepsUseManagedRemoveQuote(candidate.minimumExecutionSteps)) {
    return true;
  }

  const managedMetadata = readManagedControlSnapshotMetadata(snapshot);
  const maxManagedInventoryReleaseBps = config.maxManagedInventoryReleaseBps;
  if (
    maxManagedInventoryReleaseBps === undefined ||
    maxManagedInventoryReleaseBps >= BPS_DENOMINATOR
  ) {
    return true;
  }

  const totalWithdrawableQuoteAmount = managedMetadata.managedTotalWithdrawableQuoteAmount;
  if (totalWithdrawableQuoteAmount === undefined || totalWithdrawableQuoteAmount <= 0n) {
    return false;
  }

  const released = resolveCandidateCapital(candidate).quoteInventoryReleased;
  const maximumReleased = maximumManagedReleasedQuoteAmount(
    totalWithdrawableQuoteAmount,
    maxManagedInventoryReleaseBps
  );

  return released <= maximumReleased;
}

function candidateClearsManagedSensitivityThreshold(
  candidate: PlanCandidate,
  snapshot: PoolSnapshot,
  band: TargetBand,
  config: KeeperConfig
): boolean {
  if (!stepsUseManagedRemoveQuote(candidate.minimumExecutionSteps)) {
    return true;
  }

  const managedMetadata = readManagedControlSnapshotMetadata(snapshot);
  const minimumManagedSensitivityBpsPer10PctRelease =
    config.minimumManagedSensitivityBpsPer10PctRelease ?? 0;
  if (minimumManagedSensitivityBpsPer10PctRelease <= 0) {
    return true;
  }

  const totalWithdrawableQuoteAmount = managedMetadata.managedTotalWithdrawableQuoteAmount;
  if (totalWithdrawableQuoteAmount === undefined || totalWithdrawableQuoteAmount <= 0n) {
    return false;
  }

  const released = resolveCandidateCapital(candidate).quoteInventoryReleased;

  const improvementBps = managedDistanceImprovementBps(
    {
      snapshotPlanningRateBps: snapshot.planningRateBps,
      snapshotPredictedNextRateBps: snapshot.predictedNextRateBps,
      afterPlanningRateBps: candidate.planningRateBps,
      afterPredictedRateBpsAfterNextUpdate: candidate.predictedRateBpsAfterNextUpdate
    },
    (rateBps) => distanceToTargetBand(rateBps, band)
  );
  const normalizedSensitivityBpsPer10PctRelease =
    normalizedManagedSensitivityBpsPer10PctRelease(
      improvementBps,
      released,
      totalWithdrawableQuoteAmount
    );
  if (normalizedSensitivityBpsPer10PctRelease === undefined) {
    return false;
  }

  return (
    normalizedSensitivityBpsPer10PctRelease >=
    BigInt(minimumManagedSensitivityBpsPer10PctRelease)
  );
}

function naturalConvergenceReason(snapshot: PoolSnapshot): string {
  if (snapshot.planningLookaheadUpdates && snapshot.planningLookaheadUpdates > 1) {
    return rateUpdateIsDue(snapshot)
      ? `pool is already positioned for a convergent ${snapshot.planningLookaheadUpdates}-update path`
      : `projected ${snapshot.planningLookaheadUpdates}-update path already converges toward the target band`;
  }

  return rateUpdateIsDue(snapshot)
    ? "pool is already positioned for a convergent interest update"
    : "next protocol move already converges toward the target band";
}

function advisoryOnlyReason(snapshot: PoolSnapshot): string {
  const simulationEnabled = readSnapshotMetadataBoolean(
    snapshot,
    "simulationBackedSynthesisEnabled"
  );
  const simulationPrerequisitesAvailable = readSnapshotMetadataBoolean(
    snapshot,
    "simulationPrerequisitesAvailable"
  );

  if (simulationEnabled === false && simulationPrerequisitesAvailable === false) {
    return "only advisory heuristic candidates improved convergence, and exact simulation-backed synthesis is unavailable without a resolvable simulation sender/private key";
  }

  if (simulationEnabled === false) {
    return "only advisory heuristic candidates improved convergence, and exact simulation-backed synthesis is disabled in the current config";
  }

  return "only advisory heuristic candidates improved convergence, and heuristic execution is disabled";
}

function unsupportedCandidateReason(snapshot: PoolSnapshot): string {
  const compatibilityReason = simulationExecutionCompatibilityReason(snapshot);
  if (compatibilityReason !== undefined) {
    return `only unsupported exact candidates improved convergence, because ${compatibilityReason}`;
  }

  return "only unsupported candidates improved convergence, and none can be executed safely in the current runtime";
}

function managedInventoryNoCandidateReason(
  snapshot: PoolSnapshot,
  band: TargetBand,
  config: KeeperConfig,
  managedRejectedByReleaseCap: boolean,
  managedRejectedBySensitivityThreshold: boolean
): string | undefined {
  const projectedRate = snapshot.planningRateBps ?? snapshot.predictedNextRateBps;
  if (projectedRate >= band.minRateBps) {
    return undefined;
  }

  const managedMetadata = readManagedControlSnapshotMetadata(snapshot);
  if (managedMetadata.managedInventoryUpwardControlEnabled !== true) {
    return undefined;
  }

  const eligible = managedMetadata.managedInventoryUpwardEligible;
  const ineligibilityReason = managedMetadata.managedInventoryIneligibilityReason;
  if (eligible === false) {
    return buildManagedUnavailableReason(ineligibilityReason);
  }

  const totalWithdrawableQuoteAmount = managedMetadata.managedTotalWithdrawableQuoteAmount;
  if (
    managedRejectedByReleaseCap &&
    (totalWithdrawableQuoteAmount === undefined || totalWithdrawableQuoteAmount <= 0n)
  ) {
    return "managed inventory upward control was eligible, but the snapshot no longer exposes withdrawable managed inventory totals";
  }

  if (managedRejectedByReleaseCap) {
    return buildManagedReleaseCapReason(config.maxManagedInventoryReleaseBps ?? 0);
  }

  if (managedRejectedBySensitivityThreshold) {
    return buildManagedSensitivityReason(
      config.minimumManagedSensitivityBpsPer10PctRelease ?? 0
    );
  }

  const removeCandidateCount = managedMetadata.managedRemoveQuoteCandidateCount ?? 0;
  const dualEnabled = managedMetadata.managedDualUpwardControlEnabled;
  const dualCandidateCount = managedMetadata.managedDualCandidateCount ?? 0;

  if (eligible === true && removeCandidateCount + dualCandidateCount === 0) {
    return dualEnabled === true
      ? "managed inventory upward control was eligible, but no exact managed candidate beat the passive path"
      : "managed remove-quote control was eligible, but no exact managed candidate beat the passive path";
  }

  return undefined;
}

function chooseBestCandidate(
  candidates: PlanCandidate[],
  band: TargetBand
): PlanCandidate | undefined {
  return candidates
    .slice()
    .sort((left, right) => {
      const leftCapital = resolveCandidateCapital(left);
      const rightCapital = resolveCandidateCapital(right);
      const leftInBand = isRateInBand(
        left.planningRateBps ?? left.predictedRateBpsAfterNextUpdate,
        band
      )
        ? 0
        : 1;
      const rightInBand = isRateInBand(
        right.planningRateBps ?? right.predictedRateBpsAfterNextUpdate,
        band
      )
        ? 0
        : 1;
      if (leftInBand !== rightInBand) {
        return leftInBand - rightInBand;
      }

      if (left.resultingDistanceToTargetBps !== right.resultingDistanceToTargetBps) {
        return left.resultingDistanceToTargetBps - right.resultingDistanceToTargetBps;
      }

      if (left.minimumExecutionSteps.length !== right.minimumExecutionSteps.length) {
        return left.minimumExecutionSteps.length - right.minimumExecutionSteps.length;
      }

      if (leftCapital.operatorCapitalRequired !== rightCapital.operatorCapitalRequired) {
        return leftCapital.operatorCapitalRequired < rightCapital.operatorCapitalRequired ? -1 : 1;
      }

      if (leftCapital.operatorCapitalAtRisk !== rightCapital.operatorCapitalAtRisk) {
        return leftCapital.operatorCapitalAtRisk < rightCapital.operatorCapitalAtRisk ? -1 : 1;
      }

      if (
        leftCapital.additionalCollateralRequired !== rightCapital.additionalCollateralRequired
      ) {
        return leftCapital.additionalCollateralRequired <
          rightCapital.additionalCollateralRequired
          ? -1
          : 1;
      }

      if (leftCapital.quoteTokenDelta !== rightCapital.quoteTokenDelta) {
        return leftCapital.quoteTokenDelta < rightCapital.quoteTokenDelta ? -1 : 1;
      }

      return left.id.localeCompare(right.id);
    })[0];
}

export function planCycle(snapshot: PoolSnapshot, config: KeeperConfig): CyclePlan {
  const targetBand = buildTargetBand(config);

  if (currentAndProjectedRatesAreInBand(snapshot, targetBand)) {
    return {
      intent: "NO_OP",
      reason: "current rate and projected next eligible update are already inside the target band",
      targetBand,
      requiredSteps: [],
      predictedOutcomeAfterPlan: snapshot.predictedNextOutcome,
      predictedRateBpsAfterNextUpdate: snapshot.predictedNextRateBps,
      ...(snapshot.planningRateBps === undefined
        ? {}
        : { planningRateBps: snapshot.planningRateBps }),
      ...(snapshot.planningLookaheadUpdates === undefined
        ? {}
        : { planningLookaheadUpdates: snapshot.planningLookaheadUpdates }),
      ...ZERO_PLAN_CAPITAL
    };
  }

  const viableCandidates = snapshot.candidates.filter(
    (candidate) =>
      candidateImprovesConvergence(candidate, snapshot, targetBand) &&
      candidateClearsManagedImprovementThreshold(candidate, snapshot, targetBand, config)
  );
  const managedEligibleCandidates = viableCandidates.filter((candidate) =>
    candidateClearsManagedEligibility(candidate, snapshot)
  );
  const managedReleaseCapCandidates = managedEligibleCandidates.filter((candidate) =>
    candidateClearsManagedReleaseCap(candidate, snapshot, config)
  );
  const managedSensitivityCandidates = managedReleaseCapCandidates.filter((candidate) =>
    candidateClearsManagedSensitivityThreshold(candidate, snapshot, targetBand, config)
  );
  const executableCandidates = managedSensitivityCandidates.filter((candidate) =>
    candidateExecutionAllowed(candidate, config)
  );
  const selected = chooseBestCandidate(executableCandidates, targetBand);
  if (selected) {
    const requiredSteps = maybeAppendUpdateInterest(
      selected.minimumExecutionSteps.map((step) => withExecutionBuffer(step, config)),
      snapshot
    );
    const capital = resolvePlanCapital(requiredSteps);

    return {
      intent: selected.intent,
      reason: selected.explanation,
      targetBand,
      selectedCandidateId: selected.id,
      ...(selected.candidateSource === undefined
        ? {}
        : { selectedCandidateSource: selected.candidateSource }),
      ...(selected.executionMode === undefined
        ? {}
        : { selectedCandidateExecutionMode: selected.executionMode }),
      requiredSteps,
      predictedOutcomeAfterPlan: selected.predictedOutcome,
      predictedRateBpsAfterNextUpdate: selected.predictedRateBpsAfterNextUpdate,
      ...(selected.planningRateBps === undefined
        ? {}
        : { planningRateBps: selected.planningRateBps }),
      ...(selected.planningLookaheadUpdates === undefined
        ? {}
        : { planningLookaheadUpdates: selected.planningLookaheadUpdates }),
      ...capital
    };
  }

  const managedRejectedByReleaseCap =
    managedEligibleCandidates.some((candidate) => stepsUseManagedRemoveQuote(candidate.minimumExecutionSteps)) &&
    !managedReleaseCapCandidates.some((candidate) => stepsUseManagedRemoveQuote(candidate.minimumExecutionSteps));
  const managedRejectedBySensitivityThreshold =
    managedReleaseCapCandidates.some((candidate) => stepsUseManagedRemoveQuote(candidate.minimumExecutionSteps)) &&
    !managedSensitivityCandidates.some((candidate) => stepsUseManagedRemoveQuote(candidate.minimumExecutionSteps));

  if (viableCandidates.some((candidate) => candidate.executionMode === "unsupported")) {
    return {
      intent: "NO_OP",
      reason: unsupportedCandidateReason(snapshot),
      targetBand,
      requiredSteps: [],
      predictedOutcomeAfterPlan: snapshot.predictedNextOutcome,
      predictedRateBpsAfterNextUpdate: snapshot.predictedNextRateBps,
      ...(snapshot.planningRateBps === undefined
        ? {}
        : { planningRateBps: snapshot.planningRateBps }),
      ...(snapshot.planningLookaheadUpdates === undefined
        ? {}
        : { planningLookaheadUpdates: snapshot.planningLookaheadUpdates }),
      ...ZERO_PLAN_CAPITAL
    };
  }

  if (
    viableCandidates.length > 0 &&
    viableCandidates.some((candidate) => candidate.executionMode === "advisory") &&
    !config.allowHeuristicExecution
  ) {
    return {
      intent: "NO_OP",
      reason: advisoryOnlyReason(snapshot),
      targetBand,
      requiredSteps: [],
      predictedOutcomeAfterPlan: snapshot.predictedNextOutcome,
      predictedRateBpsAfterNextUpdate: snapshot.predictedNextRateBps,
      ...(snapshot.planningRateBps === undefined
        ? {}
        : { planningRateBps: snapshot.planningRateBps }),
      ...(snapshot.planningLookaheadUpdates === undefined
        ? {}
        : { planningLookaheadUpdates: snapshot.planningLookaheadUpdates }),
      ...ZERO_PLAN_CAPITAL
    };
  }

  if (
    naturallyImprovesConvergence(snapshot, targetBand) &&
    config.completionPolicy === "next_move_would_overshoot" &&
    nextMoveWouldOvershoot(snapshot, targetBand)
  ) {
    return {
      intent: "NO_OP",
      reason: "next protocol move already converges and would overshoot the target band",
      targetBand,
      requiredSteps: [],
      predictedOutcomeAfterPlan: snapshot.predictedNextOutcome,
      predictedRateBpsAfterNextUpdate: snapshot.predictedNextRateBps,
      ...(snapshot.planningRateBps === undefined
        ? {}
        : { planningRateBps: snapshot.planningRateBps }),
      ...(snapshot.planningLookaheadUpdates === undefined
        ? {}
        : { planningLookaheadUpdates: snapshot.planningLookaheadUpdates }),
      ...ZERO_PLAN_CAPITAL
    };
  }

  if (naturallyImprovesConvergence(snapshot, targetBand)) {
    return {
      intent: "NO_OP",
      reason: naturalConvergenceReason(snapshot),
      targetBand,
      requiredSteps: maybeAppendUpdateInterest([], snapshot),
      predictedOutcomeAfterPlan: snapshot.predictedNextOutcome,
      predictedRateBpsAfterNextUpdate: snapshot.predictedNextRateBps,
      ...(snapshot.planningRateBps === undefined
        ? {}
        : { planningRateBps: snapshot.planningRateBps }),
      ...(snapshot.planningLookaheadUpdates === undefined
        ? {}
        : { planningLookaheadUpdates: snapshot.planningLookaheadUpdates }),
      ...ZERO_PLAN_CAPITAL
    };
  }

  return {
    intent: "NO_OP",
    reason:
      managedInventoryNoCandidateReason(
        snapshot,
        targetBand,
        config,
        managedRejectedByReleaseCap,
        managedRejectedBySensitivityThreshold
      ) ??
      "no candidate changes the next-rate outcome in a way that improves convergence",
    targetBand,
    requiredSteps: [],
    predictedOutcomeAfterPlan: snapshot.predictedNextOutcome,
    predictedRateBpsAfterNextUpdate: snapshot.predictedNextRateBps,
    ...(snapshot.planningRateBps === undefined
      ? {}
      : { planningRateBps: snapshot.planningRateBps }),
    ...(snapshot.planningLookaheadUpdates === undefined
      ? {}
      : { planningLookaheadUpdates: snapshot.planningLookaheadUpdates }),
    ...ZERO_PLAN_CAPITAL
  };
}

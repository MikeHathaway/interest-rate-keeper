import { createBaseFactoryCuratorDiscoveryHelpers } from "./base-factory.curator-discovery-helpers.js";
import { createBaseFactoryCuratorManagedStateHelpers } from "./base-factory.curator-managed-state-helpers.js";
import type { CuratorHelperDeps } from "./base-factory.curator-types.js";

export function createBaseFactoryCuratorHelpers(deps: CuratorHelperDeps) {
  const discoveryHelpers = createBaseFactoryCuratorDiscoveryHelpers(deps);
  const managedStateHelpers = createBaseFactoryCuratorManagedStateHelpers(deps);

  return {
    ...discoveryHelpers,
    ...managedStateHelpers
  };
}

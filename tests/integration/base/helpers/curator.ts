import { createBaseFactoryCuratorDiscoveryHelpers } from "./curator-discovery.js";
import { createBaseFactoryCuratorManagedStateHelpers } from "./curator-managed-state.js";
import type { CuratorHelperDeps } from "./curator-types.js";

export function createBaseFactoryCuratorHelpers(deps: CuratorHelperDeps) {
  const discoveryHelpers = createBaseFactoryCuratorDiscoveryHelpers(deps);
  const managedStateHelpers = createBaseFactoryCuratorManagedStateHelpers(deps);

  return {
    ...discoveryHelpers,
    ...managedStateHelpers
  };
}

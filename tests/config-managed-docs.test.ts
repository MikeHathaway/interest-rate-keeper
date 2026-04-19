import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MANAGED_CONFIG_OPTION_KEYS,
  MANAGED_CONFIG_OPTIONS
} from "../src/core/config/managed.js";

const repoRoot = join(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("managed config docs", () => {
  it("keeps the managed config descriptor keys unique", () => {
    expect(new Set(MANAGED_CONFIG_OPTION_KEYS).size).toBe(MANAGED_CONFIG_OPTION_KEYS.length);
    expect(MANAGED_CONFIG_OPTIONS).toHaveLength(MANAGED_CONFIG_OPTION_KEYS.length);
  });

  it("mentions every managed config key in the main docs", () => {
    const readme = readRepoFile("README.md");
    const design = readRepoFile("DESIGN.md");
    const curatorMode = readRepoFile("docs/curator-mode.md");

    for (const key of MANAGED_CONFIG_OPTION_KEYS) {
      expect(readme).toContain(key);
      expect(design).toContain(key);
      expect(curatorMode).toContain(key);
    }
  });
});

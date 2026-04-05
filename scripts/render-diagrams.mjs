import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const diagramsDir = join(repoRoot, "docs", "diagrams");

const diagramInputs = [
  join(diagramsDir, "keeper-architecture.dot"),
  join(diagramsDir, "keeper-run-cycle-sequence.dot")
];

mkdirSync(diagramsDir, { recursive: true });

for (const input of diagramInputs) {
  const { dir, name } = parse(input);
  for (const format of ["svg", "png"]) {
    const output = join(dir, `${name}.${format}`);
    const result = spawnSync("dot", [`-T${format}`, input, "-o", output], {
      stdio: "inherit"
    });

    if (result.status !== 0) {
      throw new Error(`dot failed while rendering ${output}`);
    }
  }
}

process.stdout.write("rendered keeper diagrams\n");

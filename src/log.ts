import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import { safeJsonStringify } from "./json.js";

export async function appendJsonlLog(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${safeJsonStringify(record)}\n`, "utf8");
}

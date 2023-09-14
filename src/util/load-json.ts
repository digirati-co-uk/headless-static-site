import { readFile } from "node:fs/promises";
import { lazyValue } from "./lazy-value.ts";
import { join } from "node:path";

export async function loadJson(filePath: string) {
  const file = Bun.file(filePath);
  return file.json();
}

export function lazyLoadJson(...filePath: string[]) {
  return lazyValue(async () => loadJson(join(...filePath)));
}

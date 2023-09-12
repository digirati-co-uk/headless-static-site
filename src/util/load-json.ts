import { readFile } from "node:fs/promises";

export async function loadJson(filePath: string) {
  const file = Bun.file(filePath);
  return file.json();
}

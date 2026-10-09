import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireCacheLock(cacheDirectory: string, timeoutMs = 30_000) {
  await mkdir(cacheDirectory, { recursive: true });
  const lockDirectory = join(cacheDirectory, ".build-lock");
  const startedAt = Date.now();

  // ponytail: one lock per versioned cache root; use finer-grained locks only if contention is measured.
  while (true) {
    try {
      await mkdir(lockDirectory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw Object.assign(new Error(`Timed out waiting for shared cache lock: ${lockDirectory}`), {
          code: "ELOCKED",
          path: lockDirectory,
        });
      }
      await wait(100);
    }
  }

  return () => rm(lockDirectory, { recursive: true, force: true });
}

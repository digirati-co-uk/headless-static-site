import { join } from "node:path";
import type { FileHandler } from "./file-handler";

export function* readAllFiles(fs: FileHandler, dir: string): Generator<string> {
  if (!fs.dirExists(dir)) {
    return;
  }
  const files = fs.readdirSyncWithFileTypes(dir);
  for (const file of files) {
    if (file.isDirectory()) {
      yield* readAllFiles(fs, join(dir, file.name));
    } else {
      yield join(dir, file.name);
    }
  }
}

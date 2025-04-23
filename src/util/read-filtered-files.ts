import micromatch from "micromatch";
import type { FileHandler } from "./file-handler.ts";
import { readAllFiles } from "./read-all-files.ts";

export function readFilteredFiles(
  fs: FileHandler,
  store: {
    path: string;
    pattern?: string;
    ignore?: string | string[];
  },
) {
  const allStoreFiles = readAllFiles(fs, store.path);
  const allFiles = Array.from(allStoreFiles);
  if (store.pattern || store.ignore) {
    return micromatch(allFiles, store.pattern || "**/*", {
      ignore: store.ignore,
    });
  }
  return allFiles;
}

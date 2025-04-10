import { join } from "node:path";
import { cwd } from "node:process";
import type { FileHandler } from "./file-handler";

export function createFiletypeCache(cacheFile: string, fs: FileHandler) {
  let isLoaded = false;
  let didChange = false;
  let fileTypeCache: Record<string, string> = {};

  const loadIfExists = async () => {
    if (isLoaded) return;
    isLoaded = true;
    if (fs.exists(cacheFile)) {
      try {
        fileTypeCache = await fs.loadJson(cacheFile);
      } catch (e) {
        console.error("Error parsing cache file", e);
        fileTypeCache = {};
      }
    }
  };

  return {
    //
    async getFileType(filePath: string) {
      await loadIfExists();
      if (fileTypeCache[filePath]) {
        return fileTypeCache[filePath];
      }

      if (fs.exists(filePath)) {
        if (
          filePath.endsWith("/_collection.yml") ||
          filePath.endsWith("/_collection.yaml")
        ) {
          fileTypeCache[filePath] = "Collection";
          didChange = true;
          return fileTypeCache[filePath];
        }

        let jsonResource = await fs.loadJson(join(cwd(), filePath), true);

        if (jsonResource.default) {
          jsonResource = jsonResource.default;
        }

        let type = jsonResource.type || jsonResource["@type"];

        switch (type) {
          case "sc:Manifest":
            type = "Manifest";
            break;
          case "sc:Collection":
            type = "Collection";
            break;
        }

        fileTypeCache[filePath] = type;

        didChange = true;

        return fileTypeCache[filePath];
      }

      return null;
    },
    async save() {
      if (didChange) {
        fs.writeFile(cacheFile, JSON.stringify(fileTypeCache, null, 2));
      }
    },
  };
}

import fs from "node:fs";
import { isAbsolute, join } from "node:path";
import { cwd } from "node:process";
import { loadJson } from "./load-json";

export function createFiletypeCache(cacheFile: string) {
  let loaded: Promise<void> | undefined;
  let didChange = false;
  let fileTypeCache: Record<string, string> = {};

  const loadIfExists = async () => {
    if (fs.existsSync(cacheFile)) {
      const file = await fs.promises.readFile(cacheFile, "utf-8");
      try {
        fileTypeCache = JSON.parse(file);
      } catch (e) {
        console.error("Error parsing cache file", e);
        fileTypeCache = {};
      }
    }
  };

  return {
    //
    async getFileType(filePath: string) {
      await (loaded ||= loadIfExists());
      if (fileTypeCache[filePath]) {
        return fileTypeCache[filePath];
      }

      if (fs.existsSync(filePath)) {
        if (/(^|\/)_?collection\.(json|ya?ml)$/.test(filePath)) {
          fileTypeCache[filePath] = "Collection";
          didChange = true;
          return fileTypeCache[filePath];
        }

        const jsonPath = isAbsolute(filePath) ? filePath : join(cwd(), filePath);
        let jsonResource = await loadJson(jsonPath, true);

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
        await fs.promises.writeFile(cacheFile, JSON.stringify(fileTypeCache, null, 2));
      }
    },
  };
}

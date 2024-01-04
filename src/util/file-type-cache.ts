import { existsSync } from "fs";

export function createFiletypeCache(cacheFile: string) {
  let isLoaded = false;
  let didChange = false;
  let fileTypeCache: Record<string, string> = {};

  const loadIfExists = async () => {
    if (isLoaded) return;
    isLoaded = true;
    if (existsSync(cacheFile)) {
      fileTypeCache = await Bun.file(cacheFile).json();
    }
  };

  return {
    //
    async getFileType(filePath: string) {
      await loadIfExists();
      if (fileTypeCache[filePath]) {
        return fileTypeCache[filePath];
      }

      if (existsSync(filePath)) {
        const jsonResource = await Bun.file(filePath).json();

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
        await Bun.write(cacheFile, JSON.stringify(fileTypeCache, null, 2));
      }
    },
  };
}

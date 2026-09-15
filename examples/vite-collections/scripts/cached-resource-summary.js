import { getManifestImageServices } from "../../../build/library.js";
import { join } from "node:path";
import { extract } from "../../../lib/scripts.js";

extract(
  {
    id: "cached-resource-summary",
    name: "Cached resource summary",
    types: ["Manifest"],
    cache: { version: "2" },
    async collect(temp, api) {
      // Every current manifest contributes, including extraction cache hits.
      await api.fileHandler.saveJson(join(api.build.filesDir, "meta/cache-demo.json"), temp);
    },
  },
  async (resource, api) => ({
    temp: {
      label: api.resource.label,
      canvases: api.resource.items.length,
      imageServices: getManifestImageServices(resource.vault, resource.id),
    },
  })
);

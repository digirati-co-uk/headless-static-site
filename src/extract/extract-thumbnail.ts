import { Extraction } from "../util/extract.ts";
import { createThumbnailHelper } from "@iiif/helpers";

export const extractThumbnail: Extraction = {
  id: "extract-thumbnail",
  name: "Extract Thumbnail",
  types: ["Manifest"],
  invalidate: async (resource, api, config) => {
    return true;
  },
  handler: async (resource, api) => {
    const vault = resource.vault;
    const helper = createThumbnailHelper(vault);
    const thumbnail = await helper.getBestThumbnailAtSize(
      api.resource,
      {
        width: 256,
        height: 256,
      },
      false,
    );

    if (thumbnail && thumbnail.best) {
      return {
        meta: { thumbnail: thumbnail.best },
        caches: { extractThumbnail: true },
      };
    }

    return {};
  },
};

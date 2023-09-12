import { Extraction } from "../util/extract";

export const extractSlugSource: Extraction = {
  types: ["Manifest", "Collection"],
  name: "Extract slug source",
  handler: async (resource) => {
    return {
      meta: { slugSource: resource.slugSource },
    };
  },
  invalidate: async () => {
    return true;
  },
};

import { enrich } from "../../../lib/scripts.js";

enrich(
  { id: "feature-heritage", name: "Feature academic heritage", types: ["Collection"] },
  async (resource, { builder, resource: collectionResource }) => {
    if (resource.slug !== "collections/heritage") return {};
    builder.editCollection(resource.id, (collection) => {
      collection.setBehavior([...new Set([...(collectionResource.behavior || []), "hss:featured"])]);
      collection.setSummary({
        en: [
          "From the observatory to the drawing table: explore the tools and ideas that changed how we understand our world.",
        ],
      });
    });
    return { didChange: true };
  }
);

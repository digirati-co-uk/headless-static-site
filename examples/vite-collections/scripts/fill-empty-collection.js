import { enrich } from "../../../lib/scripts.js";
import { readdir, readFile } from "node:fs/promises";

// A filesystem-driven selection can just as easily use an API or generated data.
enrich(
  { id: "fill-empty-collection", name: "Fill an empty collection", types: ["Collection"] },
  async (resource, { builder }) => {
    if (resource.slug !== "collections/scripted") return {};
    const directory = new URL("../fixtures/shared/", import.meta.url);
    const objects = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(new URL(name, directory), "utf8")))
    );
    objects.sort((a, b) => a.label.en[0].localeCompare(b.label.en[0]));
    builder.editCollection(resource.id, (collection) => {
      for (const object of objects) collection.createManifest(object.id, (manifest) => manifest.setLabel(object.label));
    });
    return { didChange: true };
  }
);

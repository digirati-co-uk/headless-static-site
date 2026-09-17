import { basename, dirname, join, relative } from "node:path";
import { convertPresentation2 } from "@iiif/parser/presentation-2";
import micromatch from "micromatch";
import type { IIIFJSONStore } from "../stores/iiif-json.ts";
import type { FolderCollectionsConfig } from "../extract/extract-folder-collections.ts";
import { readFilteredFiles } from "./read-filtered-files.ts";
import { rewritePath } from "./rewrite-path.ts";
import { stringToLang } from "./string-to-lang.ts";
import type { ParsedResource, StoreApi } from "./store.ts";

/** Materialise folder resources before the ordinary extraction/enrichment pipeline. */
export async function materializeFolderCollections(store: IIIFJSONStore, api: StoreApi, resources: ParsedResource[]) {
  const config: FolderCollectionsConfig = {
    ...api.build.config?.config?.["folder-collections"],
    ...store.config?.["folder-collections"],
  };
  const automatic =
    config.enabled !== false &&
    !store.skip?.includes("folder-collections") &&
    (api.build.manifestExtractions?.some((step) => step.id === "folder-collections") ||
      store.run?.includes("folder-collections"));
  const eligible = (folder: string) => {
    const path = relative(store.path, folder).replaceAll("\\", "/");
    return (
      path.split("/").filter(Boolean).length >= Math.max(0, config.minDepth ?? 1) &&
      !(config.ignorePaths?.length && micromatch.isMatch(path, config.ignorePaths))
    );
  };
  const folders = new Map<string, string | undefined>();
  for (const file of readFilteredFiles({ ...store, pattern: "**/{_collection,collection}.{json,yml,yaml}" })) {
    if (config.ignorePaths?.length && micromatch.isMatch(relative(store.path, dirname(file)), config.ignorePaths))
      continue;
    if (folders.has(dirname(file))) throw new Error(`Multiple collection sidecars in ${dirname(file)}`);
    folders.set(dirname(file), file);
  }
  // Authored folders compose their descendants even without the automatic extraction.
  const authoredFolders = [...folders.keys()];
  const insideAuthored = (folder: string) =>
    authoredFolders.some((parent) => {
      const path = relative(parent, folder).replaceAll("\\", "/");
      return !path || (path !== ".." && !path.startsWith("../"));
    });
  const childFolders = [
    ...resources
      .filter((resource) => resource.source.type === "disk")
      .map((resource) => dirname((resource.source as { filePath: string }).filePath)),
    ...authoredFolders.map((folder) => dirname(folder)),
  ];
  for (const childFolder of childFolders) {
    for (let folder = childFolder; folder !== store.path && folder !== dirname(folder); folder = dirname(folder)) {
      if (relative(store.path, folder).split(/[\\/]/).includes("..")) break;
      if ((automatic || insideAuthored(folder)) && eligible(folder) && !folders.has(folder)) {
        folders.set(folder, undefined);
      }
    }
  }
  const sourceSlugs = new Set(
    resources.filter((resource) => resource.type === "Collection").map((resource) => resource.slug)
  );
  const generated: Array<{ folder: string; resource: ParsedResource; json: any }> = [];
  for (const [folder, sidecar] of folders) {
    const relativePath = relative(store.path, folder).replaceAll("\\", "/");
    const rewritten =
      store.base || store.destination ? rewritePath(store)(sidecar || join(folder, "collection.json")) : "";
    const slug = !rewritten || rewritten === "collections" ? `collections/${relativePath || api.storeId}` : rewritten;
    if (sourceSlugs.has(slug) && sidecar) {
      throw new Error(`Both a source collection and a sidecar define ${slug}`);
    }
    const authored = sidecar
      ? sidecar.endsWith(".json")
        ? await api.files.loadJson(sidecar, true)
        : await api.files.readYaml(sidecar)
      : {};
    const metadata = authored?.["@type"] === "sc:Collection" ? convertPresentation2(authored) : authored;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new Error(`Invalid collection metadata in ${sidecar}`);
    if (metadata.type && metadata.type !== "Collection") throw new Error(`Expected a Collection in ${sidecar}`);
    if (metadata.id !== undefined && (typeof metadata.id !== "string" || !metadata.id))
      throw new Error(`Invalid collection id in ${sidecar}`);
    const { id: _id, type: _type, items = [], label, summary, metadata: fields, ...rest } = metadata;
    if (!Array.isArray(items)) throw new Error(`Collection items must be an array in ${sidecar}`);
    const customLabel = config.labelStrategy === "customMap" ? config.customMap?.[relativePath] : undefined;
    const folderLabel = basename(folder)
      .split(/[-_\s]+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    const json = {
      ...rest,
      id: metadata.id || `virtual://${api.storeId}/${relativePath}`,
      type: "Collection",
      label: stringToLang(customLabel || label || folderLabel),
      summary: summary ? stringToLang(summary) : undefined,
      metadata: fields?.map((field: any) => ({ label: stringToLang(field.label), value: stringToLang(field.value) })),
      items,
    };
    const path = api.files.resolve(join(api.build.virtualCacheDir, api.storeId, relativePath, "collection.json"));
    generated.push({
      folder,
      json,
      resource: {
        path,
        slug,
        type: "Collection",
        storeId: api.storeId,
        virtual: true,
        saveToDisk: true,
        inputKey: sidecar ? store.inputKeys?.[sidecar] || store.inputKeys?.[relative(store.path, sidecar)] : undefined,
        source: { type: "disk", path: store.path, filePath: sidecar || folder, relativePath },
      },
    });
  }
  const members = new Map<string, any[]>();
  const addMember = (folder: string, item: any) => {
    if (!members.has(folder)) members.set(folder, []);
    members.get(folder)!.push(item);
  };
  const generatedFolders = new Set(generated.map(({ folder }) => folder));
  const children = resources.filter(
    (child) => child.source.type === "disk" && generatedFolders.has(dirname(child.source.filePath))
  );
  const concurrency = api.build.concurrency?.load ?? 4;
  for (let start = 0; start < children.length; start += concurrency) {
    const batch = children.slice(start, start + concurrency);
    const sources = await Promise.all(batch.map((child) => api.files.loadJson(child.path)));
    for (const [index, child] of batch.entries()) {
      const source = sources[index];
      const id = source.id || source["@id"];
      if (!id) throw new Error(`Missing IIIF id in ${child.path}`);
      if (child.source.type === "disk")
        addMember(dirname(child.source.filePath), { id, type: child.type, label: source.label });
    }
  }
  for (const child of generated) {
    addMember(dirname(child.folder), { id: child.json.id, type: "Collection", label: child.json.label });
  }
  for (const { folder, json, resource } of generated) {
    json.items = [...json.items, ...(members.get(folder) || [])];
    await api.files.saveJson(resource.path, json);
  }
  return [...resources, ...generated.map(({ resource }) => resource)];
}

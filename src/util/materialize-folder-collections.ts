import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
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
  for (const file of readFilteredFiles({ ...store, pattern: "**/_collection.{yml,yaml}" })) {
    if (config.ignorePaths?.length && micromatch.isMatch(relative(store.path, dirname(file)), config.ignorePaths))
      continue;
    if (folders.has(dirname(file))) throw new Error(`Multiple collection sidecars in ${dirname(file)}`);
    folders.set(dirname(file), file);
  }
  if (automatic) {
    for (const resource of resources) {
      if (resource.source.type !== "disk" || resource.type !== "Manifest") continue;
      for (
        let folder = dirname(resource.source.filePath);
        folder !== store.path && folder !== dirname(folder);
        folder = dirname(folder)
      ) {
        if (eligible(folder) && !folders.has(folder)) folders.set(folder, undefined);
      }
    }
  }
  const sourceSlugs = new Set(
    resources.filter((resource) => resource.type === "Collection").map((resource) => resource.slug)
  );
  const generated: Array<{ folder: string; resource: ParsedResource; json: any }> = [];
  for (const [folder, sidecar] of folders) {
    const relativePath = relative(store.path, folder).replaceAll("\\", "/");
    const slug =
      sidecar && (store.base || store.destination) ? rewritePath(store)(sidecar) : `collections/${relativePath}`;
    if (sourceSlugs.has(slug)) {
      if (sidecar) throw new Error(`Both a source collection and a sidecar define ${slug}`);
      continue;
    }
    const metadata = sidecar ? await api.files.readYaml(sidecar) : {};
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      throw new Error(`Invalid collection metadata in ${sidecar}`);
    const { id: _id, type: _type, items: _items, label, summary, metadata: fields, ...rest } = metadata;
    const customLabel = config.labelStrategy === "customMap" ? config.customMap?.[relativePath] : undefined;
    const folderLabel = basename(folder)
      .split(/[-_\s]+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    const json = {
      ...rest,
      id: `virtual://${sidecar ? rewritePath(store)(sidecar) : `${api.storeId}/${relativePath}`}`,
      type: "Collection",
      label: stringToLang(customLabel || label || folderLabel),
      summary: summary ? stringToLang(summary) : undefined,
      metadata: fields?.map((field: any) => ({ label: stringToLang(field.label), value: stringToLang(field.value) })),
      items: [],
    };
    const path = join(api.build.virtualCacheDir, api.storeId, `${relativePath || "_root"}.json`);
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
  for (const child of resources) {
    if (child.source.type !== "disk" || !generatedFolders.has(dirname(child.source.filePath))) continue;
    const source = await api.files.loadJson(child.path);
    const id = source.id || source["@id"];
    if (!id) throw new Error(`Missing IIIF id in ${child.path}`);
    addMember(dirname(child.source.filePath), { id, type: child.type, label: source.label });
  }
  for (const child of generated) {
    addMember(dirname(child.folder), { id: child.json.id, type: "Collection", label: child.json.label });
  }
  for (const { folder, json, resource } of generated) {
    json.items = members.get(folder) || [];
    await mkdir(dirname(resource.path), { recursive: true });
    await writeFile(resource.path, JSON.stringify(json));
  }
  return [...resources, ...generated.map(({ resource }) => resource)];
}

import {
  createProtoDirectory,
  ParsedResource,
  ProtoResourceDirectory,
  Store,
  StoreApi,
} from "../util/store";
import { readAllFiles } from "../util/read-all-files";
import micromatch from "micromatch";
import { readFile, stat } from "node:fs/promises";
import { Vault } from "@iiif/vault";
import { existsSync } from "fs";
import { join } from "node:path";
import { cwd } from "process";
import { copy, pathExists } from "fs-extra/esm";
import { isEmpty } from "../util/is-empty";
import objectHash from "object-hash";

interface IIIFJSONStore {
  type: "iiif-json";
  path: string;
  pattern?: string;
  ignore?: string;
  subFiles?: boolean;
}

async function parse(
  store: IIIFJSONStore,
  api: StoreApi,
): Promise<ParsedResource[]> {
  const allStoreFiles = readAllFiles(store.path);
  let allFiles = Array.from(allStoreFiles);
  if (store.pattern) {
    allFiles = micromatch(allFiles, store.pattern, { ignore: store.ignore });
  }

  const newAllFiles: Array<[string, string]> = [];
  const subFileMap: Record<string, string[]> = {};
  if (store.subFiles) {
    // Check for sub-files
    const allFilesWithoutExtension = allFiles.map((f) =>
      f.replace(/\.[A-Za-z0-9]+$/, ""),
    );
    for (let i = 0; i < allFilesWithoutExtension.length; i++) {
      const file = allFilesWithoutExtension[i];
      let dupe = false;
      for (const toCompare of allFilesWithoutExtension) {
        if (file === toCompare) continue;
        if (file.startsWith(toCompare)) {
          dupe = true;
          if (!subFileMap[toCompare]) {
            subFileMap[toCompare] = [];
          }
          subFileMap[toCompare].push(allFiles[i]);
          break;
        }
      }
      if (!dupe) {
        newAllFiles.push([allFiles[i], allFilesWithoutExtension[i]]);
      }
    }
  } else {
    for (const file of allFiles) {
      newAllFiles.push([file, file.replace(/\.[A-Za-z0-9]+$/, "")]);
    }
  }

  const manifests: ParsedResource[] = [];
  for (const [file, fileWithoutExtension] of newAllFiles) {
    manifests.push({
      path: file,
      slug: fileWithoutExtension,
      type: "Manifest",
      storeId: api.storeId,
      subFiles: subFileMap[fileWithoutExtension],
      source: { type: "disk", path: file },
    });
  }

  return manifests;
}

export async function getKey(
  store: { subFiles?: boolean },
  resource: ParsedResource,
) {
  const file = await stat(resource.path);
  const key = file.mtime + "-" + file.ctime + "-" + file.size;

  if (store.subFiles) {
    const subFilesFolder = existsSync(resource.slug);
    if (subFilesFolder) {
      const allFiles = readAllFiles(resource.slug);
      const keys = [];
      for (const fileName of allFiles) {
        const file = await stat(fileName);
        keys.push(file.mtime + "-" + file.ctime + "-" + file.size);
      }

      const dirHash = objectHash(keys);
      return key + "_dir: " + dirHash;
    }
  }
  return key;
}

async function invalidate(
  store: IIIFJSONStore,
  resource: ParsedResource,
  caches: ProtoResourceDirectory["caches.json"],
) {
  if (!caches.load) {
    return true;
  }

  const key = await getKey(store, resource);
  return key !== caches.load;
}

async function load(
  store: IIIFJSONStore,
  resource: ParsedResource,
  directory: string,
): Promise<ProtoResourceDirectory> {
  // 1. Load from disk.
  const file = await readFile(resource.path, "utf-8");
  const cacheKey = await getKey(store, resource);
  const json = JSON.parse(file);
  const vault = new Vault();
  const id = json.id || json["@id"];

  if (!id) {
    throw new Error("No id found in json");
  }

  if (store.subFiles) {
    const subFilesFolder = existsSync(resource.slug);
    if (subFilesFolder) {
      if (
        subFilesFolder &&
        (await pathExists(resource.slug)) &&
        !isEmpty(resource.slug)
      ) {
        const destination = join(cwd(), directory, "files");
        await copy(resource.slug, destination, { overwrite: true });
      }
    }
  }

  await vault.load(id, json);

  return createProtoDirectory(
    {
      id,
      type: "Manifest",
      path: resource.path,
      slug: resource.slug,
      storeId: resource.storeId,
      saveToDisk: true,
      source: { type: "disk", path: resource.path },
    },
    vault,
    { load: cacheKey },
  );
}

export const IIIFJSONStore: Store<IIIFJSONStore> = {
  parse,
  invalidate,
  load,
};

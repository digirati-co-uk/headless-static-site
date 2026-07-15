import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import {
  BUILD_RESULT_VERSION,
  OUTPUT_CONTRACT_VERSION,
  OUTPUT_FORMAT_VERSION,
  type BuildManifest,
  type HssBuildResult,
  type ResourceOutputDescriptor,
} from "./output-contract.ts";

export class HssOutputValidationError extends Error {
  constructor(
    public file: string,
    public field: string,
    message: string
  ) {
    super(`${file} (${field}): ${message}`);
    this.name = "HssOutputValidationError";
  }
}

export interface ValidateBuildOutputOptions {
  sha256?: boolean;
}

function fail(file: string, field: string, message: string): never {
  throw new HssOutputValidationError(file, field, message);
}

export function isSafeOutputPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !/^[A-Za-z]:\//.test(path) &&
    !path.includes("\\") &&
    posix.normalize(path) === path &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function requireObject(value: unknown, file: string, field: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(file, field, "must be an object");
  }
  return value as Record<string, any>;
}

function requireString(value: unknown, file: string, field: string) {
  if (typeof value !== "string" || !value) {
    fail(file, field, "must be a non-empty string");
  }
}

function requireStringArray(value: unknown, file: string, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(file, field, "must be an array of strings");
  }
}

function requireUrl(value: unknown, file: string, field: string) {
  requireString(value, file, field);
  try {
    new URL(value as string);
  } catch {
    fail(file, field, "must be an absolute URL");
  }
}

function validatePortableRuntimeHints(value: unknown, file: string) {
  if (!value || typeof value !== "object" || !("hss:runtime" in value)) {
    return;
  }
  const runtime = requireObject((value as Record<string, any>)["hss:runtime"], file, "hss:runtime");
  if (typeof runtime.source === "undefined") {
    return;
  }
  const source = requireObject(runtime.source, file, "hss:runtime.source");
  if (source.type === "disk") {
    if (Object.keys(source).some((key) => key !== "type")) {
      fail(file, "hss:runtime.source", "disk runtime hints must not expose source paths");
    }
    return;
  }
  if (source.type === "remote") {
    if (Object.keys(source).some((key) => key !== "type" && key !== "url")) {
      fail(file, "hss:runtime.source", "remote runtime hints may contain only type and url");
    }
    requireUrl(source.url, file, "hss:runtime.source.url");
    return;
  }
  fail(file, "hss:runtime.source.type", 'must be "disk" or "remote"');
}

export function validateBuildManifest(value: unknown, file = "meta/build.json"): BuildManifest {
  const manifest = requireObject(value, file, "$");
  if (manifest.formatVersion !== OUTPUT_FORMAT_VERSION) {
    fail(file, "formatVersion", `expected ${OUTPUT_FORMAT_VERSION}`);
  }
  if (manifest.contractVersion !== OUTPUT_CONTRACT_VERSION) {
    fail(file, "contractVersion", `expected ${OUTPUT_CONTRACT_VERSION}`);
  }
  requireString(manifest.hssVersion, file, "hssVersion");
  if (manifest.mode !== "full" && manifest.mode !== "partial") {
    fail(file, "mode", 'must be "full" or "partial"');
  }
  try {
    new URL(manifest.canonicalBaseUrl);
  } catch {
    fail(file, "canonicalBaseUrl", "must be an absolute URL");
  }
  if (typeof manifest.completedAt !== "string" || Number.isNaN(Date.parse(manifest.completedAt))) {
    fail(file, "completedAt", "must be an ISO date-time string");
  }
  for (const field of ["stores", "features", "search", "analysis"]) {
    requireStringArray(manifest[field], file, field);
  }

  const resources = requireObject(manifest.resources, file, "resources");
  for (const field of ["manifests", "collections", "canvases"] as const) {
    if (!Number.isInteger(resources[field]) || resources[field] < 0) {
      fail(file, `resources.${field}`, "must be a non-negative integer");
    }
  }

  if (!Array.isArray(manifest.files)) {
    fail(file, "files", "must be an array");
  }
  const inventoryPaths = new Set<string>();
  for (let index = 0; index < manifest.files.length; index++) {
    const item = requireObject(manifest.files[index], file, `files[${index}]`);
    if (!isSafeOutputPath(item.path)) {
      fail(file, `files[${index}].path`, "must be a normalized safe relative path");
    }
    if (inventoryPaths.has(item.path)) {
      fail(file, `files[${index}].path`, "must be unique");
    }
    inventoryPaths.add(item.path);
    if (!Number.isInteger(item.bytes) || item.bytes < 0) {
      fail(file, `files[${index}].bytes`, "must be a non-negative integer");
    }
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      fail(file, `files[${index}].sha256`, "must be a lowercase SHA-256 digest");
    }
  }

  const entrypoints = requireObject(manifest.entrypoints, file, "entrypoints");
  for (const field of [
    "rootCollection",
    "manifestsCollection",
    "collectionsCollection",
    "resources",
    "resourceDescriptors",
    "sitemap",
    "indices",
    "facets",
    "canvasSearch",
  ]) {
    const path = entrypoints[field];
    if (typeof path === "undefined" && manifest.mode === "partial") {
      continue;
    }
    if (!isSafeOutputPath(path)) {
      fail(file, `entrypoints.${field}`, "must be a normalized safe relative path");
    }
    if (!inventoryPaths.has(path)) {
      fail(file, `entrypoints.${field}`, `is not present in files (${path})`);
    }
  }
  for (const field of ["search", "analysis"] as const) {
    for (let index = 0; index < manifest[field].length; index++) {
      const path = manifest[field][index];
      if (!isSafeOutputPath(path) || !inventoryPaths.has(path)) {
        fail(file, `${field}[${index}]`, `must be a safe path present in files (${path})`);
      }
    }
  }

  return manifest as unknown as BuildManifest;
}

export async function readBuildManifest(directory: string): Promise<BuildManifest> {
  const manifestPath = resolve(directory, "meta/build.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof SyntaxError ? `invalid JSON: ${error.message}` : (error as Error).message;
    fail("meta/build.json", "$", message);
  }
  return validateBuildManifest(parsed);
}

export async function readBuildResult(directory: string): Promise<HssBuildResult> {
  try {
    const manifest = await readBuildManifest(directory);
    return {
      resultVersion: BUILD_RESULT_VERSION,
      status: "complete",
      directory: resolve(directory),
      manifestPath: "meta/build.json",
      manifest,
      diagnostics: { cache: "unknown" },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT/.test((error as Error).message)) {
      return { resultVersion: BUILD_RESULT_VERSION, status: "not-emitted" };
    }
    throw error;
  }
}

function descriptorPaths(descriptor: ResourceOutputDescriptor) {
  const files = descriptor.files;
  return [
    files.iiif,
    files.meta,
    files.indices,
    files.canvasIndex,
    files.searchRecord,
    ...files.searchData,
    ...files.extracted,
  ].filter(Boolean) as string[];
}

function validateResourceDescriptors(value: unknown, file: string) {
  const descriptors = requireObject(value, file, "$");
  for (const [slug, rawDescriptor] of Object.entries(descriptors)) {
    const descriptor = requireObject(rawDescriptor, file, slug);
    if (descriptor["hss:slug"] !== slug) {
      fail(file, `${slug}.hss:slug`, "must match its lookup key");
    }
    requireString(descriptor.id, file, `${slug}.id`);
    if (descriptor.type !== "Manifest" && descriptor.type !== "Collection") {
      fail(file, `${slug}.type`, 'must be "Manifest" or "Collection"');
    }
    if (descriptor.origin !== "source" && descriptor.origin !== "generated") {
      fail(file, `${slug}.origin`, 'must be "source" or "generated"');
    }
    const provenance = requireObject(descriptor.provenance, file, `${slug}.provenance`);
    if (provenance.type === "local") {
      if (Object.keys(provenance).some((key) => key !== "type")) {
        fail(file, `${slug}.provenance`, "local provenance must not expose source details");
      }
    } else if (provenance.type === "remote") {
      if (Object.keys(provenance).some((key) => key !== "type" && key !== "url")) {
        fail(file, `${slug}.provenance`, "remote provenance may contain only type and url");
      }
      requireUrl(provenance.url, file, `${slug}.provenance.url`);
    } else if (provenance.type === "override") {
      if (Object.keys(provenance).some((key) => key !== "type" && key !== "upstream")) {
        fail(file, `${slug}.provenance`, "override provenance may contain only type and upstream");
      }
      requireUrl(provenance.upstream, file, `${slug}.provenance.upstream`);
    } else {
      fail(file, `${slug}.provenance.type`, 'must be "local", "remote", or "override"');
    }
    if (typeof descriptor.saved !== "boolean") {
      fail(file, `${slug}.saved`, "must be a boolean");
    }
    if (typeof descriptor.inputKey !== "undefined" && typeof descriptor.inputKey !== "string") {
      fail(file, `${slug}.inputKey`, "must be a string");
    }
    const files = requireObject(descriptor.files, file, `${slug}.files`);
    requireStringArray(files.searchData, file, `${slug}.files.searchData`);
    requireStringArray(files.extracted, file, `${slug}.files.extracted`);
    for (const field of ["iiif", "meta", "indices", "canvasIndex", "searchRecord"]) {
      if (typeof files[field] !== "undefined" && typeof files[field] !== "string") {
        fail(file, `${slug}.files.${field}`, "must be a string");
      }
    }
  }
  return descriptors as Record<string, ResourceOutputDescriptor>;
}

export async function validateBuildOutput(
  directory: string,
  options: ValidateBuildOutputOptions = {}
): Promise<HssBuildResult & { status: "complete" }> {
  const root = resolve(directory);
  const rootRealPath = await realpath(root);
  const manifest = await readBuildManifest(root);
  const inventoryPaths = new Set(manifest.files.map((item) => item.path));

  for (let index = 0; index < manifest.files.length; index++) {
    const item = manifest.files[index];
    const absolutePath = resolve(root, item.path);
    let fileRealPath: string;
    let stats;
    try {
      stats = await lstat(absolutePath);
      fileRealPath = await realpath(absolutePath);
    } catch (error) {
      fail(item.path, `files[${index}].path`, (error as Error).message);
    }
    const relativeRealPath = relative(rootRealPath, fileRealPath!);
    if (!isSafeOutputPath(relativeRealPath.split("\\").join("/")) || !stats!.isFile()) {
      fail(item.path, `files[${index}].path`, "must resolve to a regular file inside the output root");
    }
    if (stats!.size !== item.bytes) {
      fail(item.path, `files[${index}].bytes`, `expected ${item.bytes}, found ${stats!.size}`);
    }
    const isMeta = item.path.endsWith("/meta.json");
    const data = options.sha256 || isMeta ? await readFile(absolutePath) : null;
    if (options.sha256 && data) {
      const digest = createHash("sha256").update(data).digest("hex");
      if (digest !== item.sha256) {
        fail(item.path, `files[${index}].sha256`, `expected ${item.sha256}, found ${digest}`);
      }
    }
    if (isMeta && data) {
      let meta: unknown;
      try {
        meta = JSON.parse(data.toString("utf8"));
      } catch (error) {
        fail(item.path, "$", `invalid JSON: ${(error as Error).message}`);
      }
      validatePortableRuntimeHints(meta, item.path);
    }
  }

  const descriptorFile = manifest.entrypoints.resourceDescriptors;
  if (!descriptorFile) {
    fail("meta/build.json", "entrypoints.resourceDescriptors", "is required for output validation");
  }
  let descriptorJson: unknown;
  try {
    descriptorJson = JSON.parse(await readFile(resolve(root, descriptorFile), "utf8"));
  } catch (error) {
    fail(descriptorFile, "$", `invalid JSON: ${(error as Error).message}`);
  }
  const descriptors = validateResourceDescriptors(descriptorJson, descriptorFile);
  for (const [slug, descriptor] of Object.entries(descriptors)) {
    for (const path of descriptorPaths(descriptor)) {
      if (!isSafeOutputPath(path) || !inventoryPaths.has(path)) {
        fail(descriptorFile, `${slug}.files`, `contains a path not present in files (${path})`);
      }
    }
  }

  return {
    resultVersion: BUILD_RESULT_VERSION,
    status: "complete",
    directory: root,
    manifestPath: "meta/build.json",
    manifest,
    diagnostics: { cache: "unknown" },
  };
}

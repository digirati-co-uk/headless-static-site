import { createHash } from "node:crypto";
import type { ExtractionReturn } from "./extract.ts";

export const EXTRACTION_CACHE = "__hssExtractionResults";
export const EXTRACTION_CACHE_COMMIT = "extraction-cache-commit.txt";
export type ExtractionCacheEntry = { generation: string; key: string; result: ExtractionReturn; digest: string };
export type ExtractionCache = Record<string, ExtractionCacheEntry>;

export function digestExtraction(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validExtractionCache(value: unknown, generation?: string): value is ExtractionCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry: any) =>
      entry &&
      typeof entry.key === "string" &&
      typeof generation === "string" &&
      entry.generation === generation &&
      entry.result &&
      typeof entry.result === "object" &&
      !Array.isArray(entry.result) &&
      typeof entry.digest === "string" &&
      digestExtraction(entry.result) === entry.digest
  );
}

/** Snapshot before collectors or downstream steps can mutate the returned objects. */
export function cacheExtractionResult(key: string, result: ExtractionReturn, generation: string): ExtractionCacheEntry {
  const snapshot = JSON.parse(
    JSON.stringify(result, (_key, value) => {
      if (["function", "symbol", "bigint"].includes(typeof value))
        throw new Error("Cacheable extraction results must be JSON data");
      return value;
    })
  );
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    throw new Error("Cacheable extraction results must be objects");
  const allowed = new Set(["temp", "meta", "indices", "search", "caches", "collections"]);
  if (Object.keys(snapshot).some((field) => !allowed.has(field))) {
    throw new Error("Cacheable extractions must return data only; Vault mutations are not cacheable.");
  }
  if (snapshot.caches && EXTRACTION_CACHE in snapshot.caches) {
    throw new Error(`${EXTRACTION_CACHE} is reserved for HSS`);
  }
  return { generation, key, result: snapshot, digest: digestExtraction(snapshot) };
}

/** Cached steps own their returned fields; reset those fields before replaying this run. */
export async function clearExtractionContributions(
  cache: ExtractionCache,
  resource: {
    meta: { value: Promise<any> };
    indices: { value: Promise<any> };
    caches: { value: Promise<any> };
    searchRecord: { value: Promise<any> };
  }
) {
  for (const { result } of Object.values(cache)) {
    for (const name of ["meta", "indices", "caches"] as const) {
      const keys = Object.keys(result[name] || {});
      if (keys.length) {
        const current = await resource[name].value;
        for (const key of keys) delete current[key];
      }
    }
    if (result.search) {
      const current = await resource.searchRecord.value;
      for (const key of Object.keys(result.search.record || {})) delete current.record?.[key];
      for (const key of Object.keys(result.search.remoteRecords || {})) delete current.remoteRecords?.[key];
      current.indexes = (current.indexes || []).filter((index: string) => !result.search?.indexes?.includes(index));
    }
  }
}

/** Detect overlapping returned fields when either participant opts into ownership. */
export function claimExtractionFields(
  claims: Map<string, { id: string; cached: boolean }>,
  id: string,
  cached: boolean,
  result: ExtractionReturn
) {
  const fields = [
    ...["meta", "indices", "caches"].flatMap((name) =>
      Object.keys((result as any)[name] || {}).map((key) => `${name}.${key}`)
    ),
    ...Object.keys(result.search?.record || {}).map((key) => `search.record.${key}`),
    ...Object.keys(result.search?.remoteRecords || {}).map((key) => `search.remoteRecords.${key}`),
    ...(result.search?.indexes || []).map((key) => `search.indexes.${key}`),
  ];
  for (const field of fields) {
    const previous = claims.get(field);
    if (previous && previous.id !== id && (cached || previous.cached)) {
      throw new Error(`Cacheable extraction output collision at ${field}: ${previous.id} and ${id}`);
    }
    claims.set(field, { id, cached });
  }
}

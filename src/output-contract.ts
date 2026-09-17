export const OUTPUT_FORMAT_VERSION = 1;
export const OUTPUT_CONTRACT_VERSION = "1.2";
export const BUILD_RESULT_VERSION = 1;

export interface OutputFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BuildEntrypoints {
  rootCollection?: string;
  manifestsCollection?: string;
  collectionsCollection?: string;
  featuredCollection?: string;
  resources?: string;
  resourceDescriptors?: string;
  sitemap?: string;
  indices?: string;
  facets?: string;
  canvasSearch?: string;
}

export interface BuildManifest {
  formatVersion: number;
  contractVersion: typeof OUTPUT_CONTRACT_VERSION;
  hssVersion: string;
  mode: "full" | "partial";
  canonicalBaseUrl: string;
  completedAt: string;
  stores: string[];
  features: string[];
  search: string[];
  analysis: string[];
  entrypoints: BuildEntrypoints;
  resources: {
    manifests: number;
    collections: number;
    canvases: number;
  };
  files: OutputFile[];
}

export type HssBuildResult =
  | {
      resultVersion: typeof BUILD_RESULT_VERSION;
      status: "complete";
      directory: string;
      manifestPath: "meta/build.json";
      manifest: BuildManifest;
      diagnostics: { cache: "enabled" | "disabled" | "unknown" };
    }
  | {
      resultVersion: typeof BUILD_RESULT_VERSION;
      status: "not-emitted";
    };

export interface ResourceOutputFiles {
  iiif?: string;
  meta?: string;
  indices?: string;
  canvasIndex?: string;
  searchRecord?: string;
  searchData: string[];
  extracted: string[];
}

export interface ResourceOutputDescriptor {
  "hss:slug": string;
  id: string;
  type: "Manifest" | "Collection";
  inputKey?: string;
  origin: "source" | "generated";
  provenance:
    | { type: "local" }
    | { type: "remote"; url: string }
    | { type: "override"; upstream: string };
  saved: boolean;
  files: ResourceOutputFiles;
  parents?: string[];
  children?: string[];
}

export interface ResourceSnippet {
  id: string;
  type: "Manifest" | "Collection";
  label?: unknown;
  summary?: unknown;
  rights?: string;
  requiredStatement?: unknown;
  provider?: unknown;
  homepage?: unknown;
  navDate?: string;
  behavior?: string[];
  thumbnail?: unknown;
  "hss:slug": string;
  "hss:totalItems"?: number;
}

export interface CanvasDiscoveryItem {
  id: string;
  position: number;
  label?: unknown;
  width?: number;
  height?: number;
  thumbnail?: unknown;
  meta?: string;
  files: string[];
  search: unknown[];
}

export interface SearchDescriptor {
  name: string;
  format: "record-jsonl";
  scope: "resource";
  idStrategy: "resource-id";
  schema: string;
  data?: string;
  facets: string[];
  canvasRegistry: string;
}

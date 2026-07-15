export const OUTPUT_FORMAT_VERSION = 1;

export interface OutputFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BuildManifest {
  formatVersion: number;
  hssVersion: string;
  mode: "full" | "partial";
  canonicalBaseUrl: string;
  completedAt: string;
  stores: string[];
  features: string[];
  search: string[];
  analysis: string[];
  resources: {
    manifests: number;
    collections: number;
    canvases: number;
  };
  files: OutputFile[];
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

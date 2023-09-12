import { cwd } from "process";
import { existsSync } from "fs";
import { join } from "node:path";

export interface IIIFRC {
  server?: {
    url: string;
  };
  stores: Record<
    string,
    {
      path: string;
      type: string;
      pattern?: string;
      options?: Record<string, any>;
      metadata?: {
        label: string;
        description?: string;
      };
      slugTemplates?: string[];
    }
  >;
  slugs?: Record<
    string,
    {
      type: "Manifest" | "Collection";
      prefix: string;
      pattern: string;
      slugTemplate: string;
      parseOptions?: any;
      examples?: string[];
    }
  >;
}

const DEFAULT_CONFIG: IIIFRC = {
  stores: {
    default: {
      path: "content",
      type: "iiif-json",
      pattern: "**/*.json",
    },
  },
};

let config: IIIFRC | null = null;

export async function getConfig() {
  if (!config) {
    if (existsSync(join(cwd(), ".iiifrc.yml"))) {
      config = await import(join(cwd(), ".iiifrc.yml"));
    } else if (existsSync(join(cwd(), ".iiifrc.yaml"))) {
      config = await import(join(cwd(), ".iiifrc.yaml"));
    } else if (existsSync(join(cwd(), "iiif.config.js"))) {
      config = await import(join(cwd(), "iiif.config.js"));
    } else if (existsSync(join(cwd(), "iiif.config.ts"))) {
      config = await import(join(cwd(), "iiif.config.ts"));
    }
  }

  if (!config || !config.stores) {
    config = DEFAULT_CONFIG;
  }

  return config as IIIFRC;
}

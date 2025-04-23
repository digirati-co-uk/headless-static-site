import fs from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import type { Collection } from "@iiif/presentation-3";
import { parse } from "yaml";
import { FileHandler } from "./file-handler.ts";
import type { SlugConfig } from "./slug-engine.ts";

export interface IIIFRC {
  server?: {
    url: string;
  };
  run?: string[];
  generators?: Record<string, GeneratorConfig>;
  stores: Record<string, GenericStore>;
  slugs?: Record<string, SlugConfig>;
  config?: Record<string, any>;
  collections?: {
    index?: Partial<Collection>;
    manifests?: Partial<Collection>;
    collections?: Record<string, Partial<Collection>>;
    topics?: Record<string, Partial<Collection>>;
  };
}

export interface GenericStore {
  path: string;
  type: string;
  pattern?: string;
  options?: Record<string, any>;
  metadata?: {
    label: string;
    description?: string;
  };
  slugTemplates?: string[];
  // Step options
  skip?: string[];
  run?: string[];
  config?: Record<string, any>;
}

interface GeneratorConfig {
  type: string;
  output?: string;
  config?: Record<string, any>;
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

export const supportedConfigFiles = [
  ".iiifrc.yml",
  ".iiifrc.yaml",
  "iiif.config.js",
  "iiif.config.ts",
];

export async function getConfig(
  files: FileHandler = new FileHandler(fs, cwd(), true),
) {
  if (!config) {
    for (const configFileName of supportedConfigFiles) {
      if (files.exists(files.resolve(configFileName))) {
        if (
          configFileName.endsWith(".yaml") ||
          configFileName.endsWith(".yml")
        ) {
          const file = (
            await files.readFile(files.resolve(configFileName))
          ).toString();
          config = parse(file);
          break;
        }

        config = await import(files.resolve(configFileName));
        break;
      }
    }
  }

  if (!config || !config.stores) {
    config = DEFAULT_CONFIG;
  }

  return config as IIIFRC;
}

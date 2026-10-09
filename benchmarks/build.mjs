import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { build, resolveConfigSource } from "../build/library.js";

const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    report: { type: "string" },
    "no-cache": { type: "boolean", default: false },
    "no-extraction-cache": { type: "boolean", default: false },
    "no-sqlite": { type: "boolean", default: false },
    descriptors: { type: "boolean", default: false },
  },
});
if (!values.cwd || !values.report)
  throw new Error(
    "Usage: node benchmarks/build.mjs --cwd <fixture> --report <file.json> [--no-cache] [--no-sqlite] [--descriptors] [--no-extraction-cache]"
  );
const cwd = resolve(values.cwd),
  report = resolve(values.report);
process.chdir(cwd);
const { config } = await resolveConfigSource(undefined, cwd);
if (values["no-sqlite"]) {
  config.run = config.run?.filter((id) => id !== "manifest-sqlite");
  for (const store of Object.values(config.stores)) store.run = store.run?.filter((id) => id !== "manifest-sqlite");
}
config.output = { ...config.output, includeResourceDescriptors: values.descriptors };
const phases = {};
const started = performance.now();
const startedCpu = process.cpuUsage();
const result = await build(
  { cwd, out: "./build", cache: !values["no-cache"], extractionCache: !values["no-extraction-cache"], ui: false },
  undefined,
  {
    customConfig: config,
    onEvent(event) {
      if (event.type === "phase-completed") {
        phases[event.phase] = event.durationMs;
        console.log(`${event.phase}: ${event.durationMs} ms`);
      }
    },
  }
);
if (result.result.status !== "complete" || !result.stores.allResources.length)
  throw new Error("Benchmark produced no source resources; check the fixture and store patterns.");
const cpu = process.cpuUsage(startedCpu);
const measurement = {
  cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
  runtime: process.version,
  resourceCache: !values["no-cache"],
  extractionCacheEnabled: !values["no-extraction-cache"],
  sqliteDisabled: values["no-sqlite"],
  wallMs: performance.now() - started,
  maxRssKiB: process.resourceUsage().maxRSS,
  phases,
  timings: result.timings,
  load: result.stores.stats,
  resources: result.result.manifest.resources,
  files: result.result.manifest.files.length,
  bytes: result.result.manifest.files.reduce((total, file) => total + file.bytes, 0),
  extract: result.extractions.stats,
  extractionCache: result.extractions.cacheStats,
  enrich: result.enrichments.stats,
};
await writeFile(report, JSON.stringify(measurement, null, 2));
console.log(`Report: ${report}`);

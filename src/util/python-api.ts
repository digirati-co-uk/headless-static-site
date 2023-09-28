import { extract } from "../../lib/scripts";
import { runPython } from "./run-python.ts";

export async function pythonExtract(pythonScript: string, log?: boolean) {
  const metaPython: any = await runPython(pythonScript, ["--meta"]);

  extract(metaPython, async (context, api) => {
    const caches = await api.caches.value;
    const cacheKey = metaPython.cacheKey;
    if (api.build.options.cache && cacheKey && caches[cacheKey]) {
      return {};
    }
    const meta = await api.meta.value;
    const indicies = await api.indicies.value;
    const config = api.config;
    const resource = api.resource;
    const response = await runPython(pythonScript, [], {
      context,
      meta,
      indicies,
      caches,
      config,
      resource,
    });

    if (log) {
      const { logs = [], ...data } = (response || {}) as any;
      if (logs.length) {
        console.log(logs.join("\n"));
      }

      return data || {};
    }
    return response || {};
  });
}

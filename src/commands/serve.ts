import { getConfig } from "../util/get-config.ts";
import { cwd } from "process";
import { join } from "node:path";
import { BuildOutput } from "bun";
import { existsSync } from "fs";
import { build } from "./build.ts";

export async function serve() {
  const config = await getConfig();
  let cachedBundle: BuildOutput | null = null;

  const options = {
    enrich: true,
    extract: true,
    emit: true,
  };

  const fullBuild = () =>
    build({ dev: true, watch: false, ...options }, null as any);

  await fullBuild();

  build(
    {
      dev: true,
      watch: true,
      skipFirstBuild: true,
      async onBuild() {
        editable = await Bun.file(
          join(cwd(), ".iiif/dev/build", "/editable.json"),
        ).json();

        siteMap = await Bun.file(
          join(cwd(), ".iiif/dev/build", "/sitemap.json"),
        ).json();
      },
      ...options,
    },
    null as any,
  );

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  let editable = await Bun.file(
    join(cwd(), ".iiif/dev/build", "/editable.json"),
  ).json();

  let siteMap = await Bun.file(
    join(cwd(), ".iiif/dev/build", "/sitemap.json"),
  ).json();

  console.log("Serving on http://localhost:7111");

  Bun.serve({
    port: 7111,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/favicon.ico") {
        return new Response("", { status: 404 });
      }

      if (url.pathname === "/client.js" || url.pathname === "/client.ts") {
        if (!cachedBundle) {
          cachedBundle = await Bun.build({
            entrypoints: ["./src/lib/client.ts"],
            sourcemap: "inline",
            target: "browser",
          });
        }

        return new Response(cachedBundle.outputs[0]);
      }

      const html = existsSync(join("src/dev", url.pathname + ".html"));
      if (html) {
        const index = Bun.file(join(cwd(), "src/dev", url.pathname + ".html"));
        return new Response(index.stream());
      }

      if (url.pathname.startsWith("/clover/")) {
        const index = Bun.file(join(cwd(), "src/dev/clover.html"));
        return new Response(index.stream());
      }

      if (url.pathname.startsWith("/editor/")) {
        const index = Bun.file(join(cwd(), "src/dev/editor.html"));
        return new Response(index.stream());
      }

      if (url.pathname === "/") {
        const index = Bun.file(join(cwd(), "src/dev/index.html"));
        return new Response(index.stream());
      }

      const file = Bun.file(join(cwd(), ".iiif/dev/build", url.pathname));

      if (req.method === "POST") {
        if (!url.pathname.endsWith("manifest.json")) {
          return new Response("", { status: 404 });
        }

        let withoutExt = url.pathname.replace(/\/manifest.json$/, "");
        if (withoutExt.startsWith("./")) {
          withoutExt = withoutExt.slice(2);
        }
        if (withoutExt.startsWith("/")) {
          withoutExt = withoutExt.slice(1);
        }

        const relativeWithoutExt = "./" + withoutExt;
        let editablePath = editable[withoutExt] || editable[relativeWithoutExt];

        if (!editablePath) {
          const file = siteMap[withoutExt] || siteMap[relativeWithoutExt];
          if (!file?.source?.overrides) {
            return new Response("", { status: 404 });
          } else {
            editablePath = join(
              file?.source?.overrides,
              relativeWithoutExt + ".json",
            );
          }
        }

        console.log("trying to save..", editablePath);

        const body = await req.json();
        if (body) {
          await Bun.write(
            join(cwd(), editablePath),
            JSON.stringify(body, null, 2),
          );
          await fullBuild();
          return new Response("ok");
        }
        return new Response("", { status: 404 });
      }

      return new Response(file.stream(), { headers: corsHeaders });
    },
  });
}

import { getConfig } from "../util/get-config.ts";
import { cwd } from "process";
import { join } from "node:path";
import { BuildOutput } from "bun";
import { existsSync } from "fs";
import { build } from "./build.ts";

export async function serve() {
  const config = await getConfig();
  let cachedBundle: BuildOutput | null = null;

  build({ dev: true, watch: true }, null as any);

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

      if (url.pathname === "/") {
        const index = Bun.file(join(cwd(), "src/dev/index.html"));
        return new Response(index.stream());
      }

      const file = Bun.file(join(cwd(), ".iiif/dev/build", url.pathname));

      return new Response(file.stream());
    },
  });
}

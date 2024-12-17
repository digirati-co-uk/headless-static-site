import { serve } from "@hono/node-server";
import app from "../server";

type ServeOptions = unknown;

export async function serveCommand(options: ServeOptions) {
  console.log("Building initial assets...");

  // @todo make this optional?
  await app.request("/build?cache=true&emit=true&ui=true");
  await app.request("/watch");

  console.log(`Server running: http://localhost:${app.port}`);
  serve(app);
}

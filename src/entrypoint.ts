import { serve } from "@hono/node-server";
import app from "./server";

// @todo make this optional?
await app.request("/build?cache=true&emit=true");

console.log(`Server running: http://localhost:${app.port}`);
serve(app);

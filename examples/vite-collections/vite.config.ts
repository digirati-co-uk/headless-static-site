import { defineConfig } from "vite";
// Use the checkout directly so changes to the pipeline are demonstrated immediately.
import iiif from "../../src/vite-plugin";

export default defineConfig({
  plugins: [iiif({ serverUrl: "https://example.org/iiif" })],
});

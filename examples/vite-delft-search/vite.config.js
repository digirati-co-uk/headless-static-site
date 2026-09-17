import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import iiif from "../../src/vite-plugin";

export default defineConfig({
  plugins: [react(), iiif({ serverUrl: "http://localhost:5178/iiif" })],
  server: { port: 5178, strictPort: true },
  preview: { port: 5178, strictPort: true },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 7798,
    proxy: {
      "/api": "http://127.0.0.1:7799",
      "/files": "http://127.0.0.1:7799",
    },
  },
});

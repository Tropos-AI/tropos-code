// web/vite.config.ts — the browser app of the dashboard. Its build output (web/dist) is embedded in the tcode binary.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("."),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // UI-agnostic modules shared with the terminal UI (transcript reducer, tool views, slash commands…).
      "@core": here("../src"),
      "@": here("./src"),
      // tool-view.ts uses node:path for relative paths; pathe is the same API for the browser.
      "node:path": "pathe",
    },
  },
  build: {
    outDir: here("./dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // `bun run dev:web` with `tcode gateway --dev` (webPort 4318) running: the dev server proxies the socket.
    proxy: { "/ws": { target: "ws://127.0.0.1:4318", ws: true } },
  },
});

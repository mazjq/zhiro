import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  // relative asset URLs: the same bundle is served by the daemon under /app/ and by Tauri at the root
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: Object.fromEntries(["/api", "/health", "/bookmarklet", "/capture", "/mcp"].map((p) => [p, { target: process.env.JOBOS_URL ?? "http://127.0.0.1:8787", changeOrigin: true }])),
  },
}));

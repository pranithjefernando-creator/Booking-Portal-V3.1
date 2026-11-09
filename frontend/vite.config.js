import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({ plugins: [react()], server: { port: 5173, fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] }, proxy: { "/api": { target: process.env.API_PROXY_TARGET || "http://localhost:4000", changeOrigin: true } } } });

import { defineConfig } from "vite";

// Relative paths so the same build works on GitHub Pages and on a phone.
export default defineConfig({ base: "./", build: { outDir: "dist", emptyOutDir: true } });

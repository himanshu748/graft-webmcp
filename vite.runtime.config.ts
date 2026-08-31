import { defineConfig } from "vite";

/**
 * Built separately from the app because the output is inlined as text into
 * every exported adapter, which keeps an owner's site free of any runtime
 * dependency on Graft's own host.
 */
export default defineConfig({
  build: {
    lib: {
      entry: "src/runtime.ts",
      formats: ["iife"],
      name: "GraftRuntime",
      fileName: () => "graft-runtime.js",
    },
    outDir: "src/generated",
    emptyOutDir: false,
    minify: "esbuild",
    sourcemap: false,
  },
});

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// For GitHub Pages project sites the URL is https://<user>.github.io/<repo>/.
// Set VITE_BASE="/<repo>/" when building for that target. Defaults to "/" so dev works.
export default defineConfig(({ mode }) => {
   const env = loadEnv(mode, process.cwd(), "");
   return {
      plugins: [react()],
      base: env.VITE_BASE ?? "/",
      server: { port: 5173 },
   };
});

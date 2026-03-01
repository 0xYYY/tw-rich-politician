// @ts-check
import { defineConfig } from "astro/config";

import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";

// https://astro.build/config
export default defineConfig({
  integrations: [react(), tailwind()],
  adapter: cloudflare(),
  vite: {
    server: {
      allowedHosts: ["tw-rich-politician.haotongye.com"],
    },
  },
});

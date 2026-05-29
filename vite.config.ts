import AutoImport from "unplugin-auto-import/vite";
import Icons from "unplugin-icons/vite";
import IconsResolver from "unplugin-icons/resolver";
import Components from "unplugin-vue-components/vite";
import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import {defineConfig} from "vite";

const host = process.env.TAURI_DEV_HOST;
const devServerHost = host || "127.0.0.1";
const isTauriDebug = process.env.TAURI_DEBUG === "true";

export default defineConfig({
  plugins: [
    AutoImport({
      imports: ["vue"],
      dts: "src/auto-imports.d.ts",
    }),
    Components({
      dts: "src/components.d.ts",
      resolvers: [
        IconsResolver({
          prefix: "Icon",
          enabledCollections: ["mdi"],
        }),
      ],
    }),
    Icons({
      compiler: "vue3",
    }),
    vue(),
    UnoCSS(),
  ],
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    host: devServerHost,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1422,
      }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  preview: {
    port: 1422,
    strictPort: true,
  },
  build: {
    target: "es2020",
    minify: isTauriDebug ? false : "esbuild",
    sourcemap: isTauriDebug,
  },
  optimizeDeps: {
    exclude: ["@tauri-apps/api"],
  },
});

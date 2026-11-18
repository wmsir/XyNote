import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// 版本号只维护在 package.json 一处，界面里通过 __APP_VERSION__ 读取
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: ["es2020", "safari13.1", "chrome87", "edge88", "firefox78"],
    cssTarget: "safari13.1",
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          katex: ["katex"],
          // lucide-react 不放进 vendor：界面用到的图标随主包加载，
          // 页面图标选择器里的全部图标由 src/icons/lucideLibrary.ts 单独按需加载
          vendor: ["react", "react-dom"],
        },
      },
    },
  },
});

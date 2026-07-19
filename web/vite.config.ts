import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // ── JASSUB（libass 的 wasm 版）的打包配置 ────────────────────────────
  // jassub 内部用 `new Worker(url, { type: 'module' })` 起 worker。Vite 默认
  // 把 worker 打成 iife，那样 `type: 'module'` 的 worker 里 import 会直接报错，
  // 现象是预览框一片空白、控制台只有一句 worker 加载失败。必须显式声明 es。
  worker: { format: 'es' },

  optimizeDeps: {
    // jassub 必须绕开 esbuild 预打包：它靠 `new URL('./xxx.wasm', import.meta.url)`
    // 定位 wasm 和 worker，预打包会把这些相对 URL 重写到 .vite/deps 下，
    // 结果就是 404。我们在 Preview.tsx 里用 ?url 显式喂 workerUrl/wasmUrl，
    // 但入口模块本身也不能被改写。
    exclude: ['jassub'],
  },

  // wasm 的 MIME 必须是 application/wasm，否则 instantiateStreaming 会报
  // "Incorrect response MIME type"——阶段 0 的 JASSUB spike 就死在这。
  // dev server（内部 mrmime）和生产的 @fastify/static（mime-db）都已正确
  // 处理 .wasm，nginx 侧 mime.types 也加过；三处都有对应测试/记录，
  // 这里不需要额外配置，但改动服务端静态托管时务必回头确认这一条。

  // 构建产物给 Fastify 托管（同域，cookie 自动生效、无 CORS）
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 5173,
    host: true,   // 允许从局域网/外部访问 dev server，方便在真机上看效果
    // 开发时把 /api 代理到后端，前端仍以为是同域
    proxy: { '/api': { target: 'http://127.0.0.1:8809', changeOrigin: true } },
  },
})

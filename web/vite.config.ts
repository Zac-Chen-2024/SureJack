import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 构建产物给 Fastify 托管（同域，cookie 自动生效、无 CORS）
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    port: 5173,
    host: true,   // 允许从局域网/外部访问 dev server，方便在真机上看效果
    // 开发时把 /api 代理到后端，前端仍以为是同域
    proxy: { '/api': { target: 'http://127.0.0.1:8809', changeOrigin: true } },
  },
})

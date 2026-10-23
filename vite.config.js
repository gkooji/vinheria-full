import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IP da sua instância AWS (onde rodam o Orion e o STH-Comet)
const HOST = '3.238.18.175'

export default defineConfig({
  plugins: [react()],
  server: {
    // O proxy faz o navegador falar com o próprio localhost, o que evita erro de CORS
    proxy: {
      '/iota': {
        target: `http://${HOST}:4041`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/iota/, ''),
      },
      '/orion': {
        target: `http://${HOST}:1026`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/orion/, ''),
      },
      '/sth': {
        target: `http://${HOST}:8666`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/sth/, ''),
      },
    },
  },
})
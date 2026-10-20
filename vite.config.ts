import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Relative base so the same build works at a domain root (Cloudflare Pages)
// and under a sub-path (GitHub Pages: /cardistry-identifier/).
export default defineConfig({
  base: './',
  plugins: [react()],
})

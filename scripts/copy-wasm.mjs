// Copies MediaPipe's WASM runtime into public/ so the app is fully self-hosted
// (works on Cloudflare Pages and GitHub Pages without a third-party CDN).
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const dest = join(root, 'public/mediapipe/wasm')
mkdirSync(dest, { recursive: true })
for (const f of [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]) {
  cpSync(join(src, f), join(dest, f))
}
console.log('Copied MediaPipe WASM to public/mediapipe/wasm')

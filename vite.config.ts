import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base matches a GitHub Pages project site (https://<user>.github.io/wingtips/).
// Switch to '/' if this ever moves to a custom domain, same as Pillow Report's setup.
export default defineConfig({
  base: '/wingtips/',
  plugins: [react()],
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// '/' because this is served from wingtips.nl at the domain root (CNAME file + GitHub Pages
// custom domain), same setup as Pillow Report.
export default defineConfig({
  base: '/',
  plugins: [react()],
})

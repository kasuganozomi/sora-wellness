import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendTarget = process.env.VITE_BACKEND_URL || `http://127.0.0.1:${process.env.BACKEND_PORT || '3000'}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/api/v1': backendTarget } },
  preview: { proxy: { '/api/v1': backendTarget } },
})

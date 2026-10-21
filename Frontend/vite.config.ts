import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { testCasesPlugin } from './vite.testcases.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), testCasesPlugin(path.resolve(import.meta.dirname, '../Localization/test_cases'))],
  build: { chunkSizeWarningLimit: 800 },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
})

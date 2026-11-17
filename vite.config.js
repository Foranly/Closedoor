import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import ogTagsPlugin from './plugins/ogTagsPlugin'
import livekitTokenPlugin from './plugins/livekitTokenPlugin'
import klipyDevApiPlugin from './plugins/klipyDevApiPlugin'
import preloadRouteChunks from './plugins/preloadRouteChunks'
import inlineCssPlugin from './plugins/inlineCssPlugin'
import musicDevApiPlugin from './plugins/musicDevApiPlugin'
import buildIdPlugin from './plugins/buildIdPlugin'
import { cspPlugin } from './plugins/cspPlugin'

// Versión de la web (Ajustes → Información). Sale de package.json para no
// duplicar el número en el código; en dev y en build queda igual.
const pkg = createRequire(import.meta.url)('./package.json')

// https://vite.dev/config/
export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  server: {
    proxy: {
      '^/cdn2(/|$)': {
        target: process.env.CDN2_TARGET || 'http://api2.foranly.cloud:24633',
        changeOrigin: true,
      },
      '^/cdn(/|$)': {
        target: process.env.CDN_TARGET || 'http://api.foranly.cloud:24587',
        changeOrigin: true,
      },
      '/api/image-proxy': {
        target: 'http://mapi.foranly.space:24633',
        changeOrigin: true,
      },
    },
    allowedHosts: [
      '.ngrok-free.app',
      '.ngrok.io',
      '.ngrok.app',
      true,
    ],
  },
  build: {
    cssMinify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vendor splitting — keep stable libraries in separate chunks
          if (id.includes('/node_modules/react-dom') || id.includes('/node_modules/react/')) {
            return 'vendor-react';
          }
          if (id.includes('/node_modules/@supabase/supabase-js')) {
            return 'vendor-supabase';
          }
          if (id.includes('/node_modules/react-router')) {
            return 'vendor-router';
          }
          if (id.includes('/node_modules/react-toastify')) {
            return 'vendor-toastify';
          }
        },
      },
    },
  },
  plugins: [
    ogTagsPlugin(),
    livekitTokenPlugin(),
    klipyDevApiPlugin(),
    preloadRouteChunks(),
    inlineCssPlugin(),
    musicDevApiPlugin(),
    buildIdPlugin(),
    cspPlugin(),
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})

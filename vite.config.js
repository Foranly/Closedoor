import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import ogTagsPlugin from './plugins/ogTagsPlugin'
import livekitTokenPlugin from './plugins/livekitTokenPlugin'
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
      '/cdn': {
        target: 'http://api.foranly.space:24587',
        changeOrigin: true,
      },
      // ⚠️ /api/music* y /api/music-search NO se proxian: los sirve
      // musicDevApiPlugin (abajo) con la misma lógica que producción
      // (api/music/*.js + api/_music.js). Antes se proxiavan a server.js
      // (:3000) y, sin `npm start`, devolvían 502 → la card caía siempre al
      // preview de 30 s.
      // Proxy de imágenes CORS (wallhaven, etc. bloquean el fetch del navegador):
      // el server baja la imagen y la devuelve con CORS *, igual que en Vercel.
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
    preloadRouteChunks(),
    inlineCssPlugin(),
    musicDevApiPlugin(),
    buildIdPlugin(),
    cspPlugin(),
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})

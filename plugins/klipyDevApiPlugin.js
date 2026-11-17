import { loadEnv } from 'vite';
import { handleKlipyRequest } from '../api/_klipy.js';

export default function klipyDevApiPlugin() {
  let apiKey = '';

  return {
    name: 'klipy-dev-api',
    apply: 'serve',

    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir, '');
      apiKey = env.KLIPY_API_KEY || globalThis.process?.env?.KLIPY_API_KEY || '';
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        if (path !== '/api/klipy') {
          next();
          return;
        }

        handleKlipyRequest(req, res, { apiKey }).catch(() => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: 'GIF service error' }));
          } else {
            res.destroy();
          }
        });
      });
    },
  };
}

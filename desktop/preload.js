/**
 * preload.js — único puente entre la app de escritorio y la web publicada.
 *
 * Expone en `window` UN objeto plano y congelado, sin funciones ni acceso a
 * nada del sistema:
 *
 *   window.foranlyDesktop = {
 *     app: 'foranly-desktop',
 *     version: '0.1.0',
 *     electron: '29.4.6',                      // versions.electron
 *     chrome: '122.0.6261.156',                // versions.chrome
 *     platform: 'linux' | 'win32' | 'darwin',
 *     musicApiUrl: 'http://127.0.0.1:5990',  // base de /api/music/*
 *     musicReady: true,                      // el servidor local respondió
 *     titlebarHeight: 40,                    // alto de la barra de título propia
 *   }
 *
 * También publica `window.electron` con el control de la ventana
 * (minimize/maximize/close/onWindowState) que usa la titlebar personalizada,
 * `zoom` (get/reset/in/out) para el zoom de la interfaz y `activity`
 * (get/subscribe) para la actividad local detectada por main.js.
 *
 * El cliente lo usa para (a) NO ofrecer la descarga a quien ya está en la app y
 * (b) resolver las canciones completas contra el loopback. La fuente de verdad
 * de esos datos es main.js: aquí solo se pregunta por IPC síncrono, así que no
 * hay copia de la configuración que se pueda desincronizar.
 *
 * Sin `contextBridge` la web remota vería el `window` aislado, así que este
 * archivo es la ÚNICA superficie expuesta — mantenerla mínima.
 */

const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE_INFO_CHANNEL = 'foranly:desktop-info';

let info = null;
try {
  info = ipcRenderer.sendSync(BRIDGE_INFO_CHANNEL);
} catch {
  info = null; // sin puente la web se comporta como un navegador normal
}

if (info && typeof info === 'object') {
  contextBridge.exposeInMainWorld('foranlyDesktop', Object.freeze({ ...info }));
}

// ── Window controls API (titlebar personalizada) ──
// Solo Windows/Linux dibujan botones propios; en macOS la web conserva los
// semáforos nativos, pero exponemos el API igualmente para no romper el código.
contextBridge.exposeInMainWorld('electron', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.sendSync('window-is-maximized'),
  platform: process.platform,
  // Notifica cambios de estado (maximizado/restaurado) sin exponer el ipcRenderer.
  onWindowState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('window-state', listener);
    return () => ipcRenderer.removeListener('window-state', listener);
  },
  // Actividad local del equipo (música/vídeo/juegos), detectada en main.js.
  // `get()` da el estado actual (o null) y `subscribe(cb)` avisa de los cambios;
  // devuelve una función para desuscribirse. En la web esto no existe.
  activity: {
    get: () => ipcRenderer.invoke('foranly:activity-get'),
    // Programas abiertos en el equipo (Ajustes → Actividad). Devuelve string[].
    listApps: () => ipcRenderer.invoke('foranly:apps-list'),
    subscribe: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('foranly:activity', listener);
      return () => ipcRenderer.removeListener('foranly:activity', listener);
    },
  },
  // Zoom de la ventana (Ajustes → Zoom y el atajo Ctrl+0 de la web).
  // Devuelve siempre el estado resultante: { ok, factor, percent, level }.
  zoom: {
    get: () => ipcRenderer.invoke('window-zoom', 'get'),
    reset: () => ipcRenderer.invoke('window-zoom', 'reset'),
    in: () => ipcRenderer.invoke('window-zoom', 'in'),
    out: () => ipcRenderer.invoke('window-zoom', 'out'),
  },
});

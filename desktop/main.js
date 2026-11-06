/**
 * Foranly Desktop — envoltorio Electron de la web + servidor de música local.
 *
 * POR QUÉ EXISTE (y por qué NO es el helper manual):
 * YouTube decide si sirve el stream completo según la REPUTACIÓN DE LA IP.
 * Desde un datacenter (Vercel, Hetzner, cualquier VPS) la resolución acaba en
 * "Sign in to confirm you're not a bot", y los PO tokens no lo arreglan. Desde
 * la IP residencial del usuario sí funciona. La web no puede lanzar procesos en
 * la máquina del usuario; una app de escritorio sí.
 *
 * ARQUITECTURA (la de mejor rendimiento y menos mantenimiento):
 *   - La VENTANA carga la web publicada (WEB_URL). Un solo código: cada deploy
 *     de la web llega al instante a la app, sin recompilar ni republicar nada.
 *     No hay bundle duplicado ni builds desincronizados.
 *   - En PARALELO se levanta el MISMO servidor de música del repo
 *     (scripts/music-api-server.mjs) escuchando SOLO en 127.0.0.1:5990. Mismo
 *     código que producción: no hay una segunda implementación que mantener.
 *   - El cliente (src/assets/services/desktopApp.js) detecta
 *     `window.foranlyDesktop` y manda las peticiones de /api/music/* al
 *     loopback, así que el audio sale por la conexión del usuario y YouTube ve
 *     una IP residencial.
 *
 * SEGURIDAD: contextIsolation + sandbox activos, sin nodeIntegration, y el
 * puente expone SOLO un objeto plano (versión, plataforma y la URL del loopback)
 * — la web publicada nunca recibe acceso a Node, al disco ni a IPC.
 * Los enlaces externos se abren en el navegador del sistema.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, session, shell } = require('electron');
// Detección de actividad local (Spotify, vídeo, juegos): vive en el proceso
// principal porque solo ahí se puede leer el sistema (ver desktop/activity.js).
const activity = require('./activity');

// ── Configuración (todo por env, con valores por defecto de producción) ──
const WEB_URL = process.env.FORANLY_WEB_URL || 'https://app.foranly.space';
// Alto de la barra de título personalizada (la web reserva este espacio con
// `--fc-titlebar-h`; el valor viaja en bridgeInfo para no desincronizar CSS y JS).
const TITLEBAR_HEIGHT = Number(process.env.FORANLY_TITLEBAR_HEIGHT || 40);
const MUSIC_HOST = '127.0.0.1';
// Puerto FIJO a propósito: es el que autorizan la CSP (plugins/cspPlugin.js) y
// el CORS del servidor; con un puerto aleatorio el navegador bloquearía el audio.
const MUSIC_PORT = Number(process.env.FORANLY_MUSIC_PORT || 5990);
const MUSIC_API_URL = `http://${MUSIC_HOST}:${MUSIC_PORT}`;
const BRIDGE_INFO_CHANNEL = 'foranly:desktop-info';
const APP_VERSION = require('./package.json').version;

// ── Identidad del proceso/ventana ──
// Sin esto, Windows muestra "Electron" en el Administrador de tareas y agrupa
// la app bajo el icono genérico de Electron (sobre todo al ejecutar en dev).
// setName afecta al nombre visible (ventana, bandeja, diálogos) y el AppUserModelID
// es lo que usa Windows para agrupar la tarea con SU icono en la barra.
app.setName('Closedoor');
if (process.platform === 'win32') {
  app.setAppUserModelId('space.foranly.desktop');
}

// ── Iconos (ventana, taskbar, bandeja e instaladores) ──
// Viven en desktop/assets y viajan DENTRO del asar (build.files), así que la
// misma ruta vale en dev y empaquetado. tray.png es el mismo logo recortado a
// 32x32 porque la bandeja no escala tan bien como la ventana.
const APP_ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray.png');

// Chromium ya considera 127.0.0.1 un origen seguro (así que no hay bloqueo de
// mixed content en una página https→http://127.0.0.1), pero las versiones nuevas
// pasan las peticiones a red local por "Local Network Access". El servidor
// responde CORS `*` + Access-Control-Allow-Private-Network; este switch es la
// red de seguridad para que nada bloquee el audio en el equipo del usuario.
app.commandLine.appendSwitch('disable-features', 'LocalNetworkAccessChecks,PrivateNetworkAccessChecks');

let mainWindow = null;
/** Icono de la bandeja: mantiene la app viva con la ventana oculta. */
let tray = null;
/**
 * `true` solo cuando la app está saliendo DE VERDAD (tray → Salir / app.quit()).
 * Distingue "cerrar la ventana" (se oculta a la bandeja) de "salir"; sin esta
 * bandera el handler de 'close' secuestraría también el cierre real.
 */
let isQuitting = false;
/** Servidor que arrancamos NOSOTROS (null si lo reutilizamos de otra instancia). */
let ownMusicServer = null;
/** Resultado del arranque: la web decide con esto si puede pedir canción completa. */
let musicReady = false;
const DEBUG = process.env.FORANLY_DEBUG === '1';

/** Ruta del módulo del servidor de música: repo en dev, extraResources al empaquetar. */
function musicServerModulePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'scripts', 'music-api-server.mjs')
    : path.join(__dirname, '..', 'scripts', 'music-api-server.mjs');
}

/** ¿Hay ya un servidor de música respondiendo en el puerto? (otra instancia / dev) */
async function isMusicServerAlive() {
  try {
    const res = await fetch(`${MUSIC_API_URL}/api/music/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const info = await res.json();
    return info?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Levanta el servidor de música local. Nunca lanza: si no puede, la app sigue
 * funcionando como el navegador (preview de 30 s) y la web lo sabe por
 * `musicReady: false`.
 */
async function startLocalMusicServer() {
  // 1) ¿Ya hay uno escuchando (otra ventana de la app, `npm run music-api` en dev)?
  if (await isMusicServerAlive()) {
    console.log(`[desktop] reutilizando el servidor de música existente en ${MUSIC_API_URL}`);
    musicReady = true;
    return;
  }

  try {
    const modulePath = musicServerModulePath();
    const { startMusicServer } = await import(pathToFileURL(modulePath).href);
    const running = await startMusicServer({
      host: MUSIC_HOST,
      port: MUSIC_PORT,
      quiet: true, // sin log por petición en la consola del usuario
      log: false,
    });
    ownMusicServer = running;
    musicReady = true;
    console.log(`[desktop] servidor de música local en ${running.url}`);
  } catch (err) {
    musicReady = false;
    console.error('[desktop] no se pudo arrancar el servidor de música:', err?.message || err);
    console.error('[desktop] las canciones se reproducirán con el preview de 30 s');
  }
}

/**
 * Comprueba DESDE LA PÁGINA que el renderer puede hablar con el servidor de
 * música local. No es lo mismo que comprobarlo desde aquí: la petición sale del
 * documento cargado, así que la decide su Content-Security-Policy (la web
 * publicada trae la suya en un `<meta>` del HTML).
 *
 * Si ese documento está desplegado SIN autorizar el loopback (una versión
 * anterior a `plugins/cspPlugin.js` con 127.0.0.1), Chromium responde
 * "Refused to connect" / "violates ... media-src" y la canción del perfil cae
 * al preview de 30 s aunque este servidor esté perfecto. Es el fallo más fácil
 * de confundir con un bug del audio, por eso se avisa con la causa y el remedio.
 */
async function checkPageCanReachLocalAudio(page) {
  if (musicReady && (await canPageReachLocalAudio(page))) return;
  console.warn(
    `[desktop] la web cargada (${WEB_URL}) no puede leer el servidor de música local.`
  );
  console.warn(
    '[desktop] causa habitual: está desplegada una versión ANTERIOR de la web, cuya CSP' +
      ' no autoriza 127.0.0.1:5990 (connect-src/media-src → `Refused to connect`).' +
      ' Despliega esta misma versión de la web y la canción sonará completa.'
  );
}

/** `true` si la página puede hacer GET al health del servidor local. */
async function canPageReachLocalAudio(page) {
  try {
    const health = await page.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${MUSIC_API_URL}/api/music/health`)}).then((r) => r.status).catch((e) => 'error: ' + (e?.message || e))`
    );
    return typeof health === 'number' && health >= 200 && health < 300;
  } catch {
    return false;
  }
}

/**
 * Diagnóstico detallado (`FORANLY_DEBUG=1`): health + un `<audio>` real contra
 * el loopback, con los mensajes de CSP del renderer. Sirve para distinguir en un
 * vistazo "el servidor local no está" de "la web no lo autoriza".
 */
async function debugLocalAudioFromPage(page) {
  const blocked = [];
  const onConsole = (event) => {
    const text = typeof event === 'string' ? event : event?.message || '';
    if (!/(refused|blocked|violates)/i.test(text)) return;
    // Mirar el DESTINO bloqueado, no el texto entero: cuando el documento viola
    // la CSP por otra cosa (p. ej. Supabase en una build local sin variables), el
    // mensaje imprime la directiva violada… y esa directiva menciona nuestro
    // 127.0.0.1. Filtrar por el texto daba falsos positivos.
    const target = text.match(/'([^']+)'/)?.[1] || text.match(/(https?:\/\/\S+)/)?.[1] || '';
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(target)) return;
    blocked.push(text.slice(0, 200));
  };
  page.webContents.on('console-message', onConsole);

  const query = 'artist=Feid&title=Ferxxo%20100&duration=168';
  try {
    const result = await page.webContents.executeJavaScript(`(async () => {
      const out = { health: null, audio: null };
      try {
        const res = await fetch(${JSON.stringify(`${MUSIC_API_URL}/api/music/health`)});
        out.health = res.status;
      } catch (e) { out.health = 'bloqueado: ' + (e?.message || e); }
      out.audio = await new Promise((resolve) => {
        const a = new Audio(${JSON.stringify(`${MUSIC_API_URL}/api/music/stream?${query}`)});
        const timer = setTimeout(() => resolve('sin respuesta (15 s)'), 15000);
        a.onloadeddata = () => { clearTimeout(timer); resolve('cargado'); };
        a.oncanplay = () => { clearTimeout(timer); resolve('cargado'); };
        a.onerror = () => { clearTimeout(timer); resolve('error code=' + (a.error?.code)); };
        a.load();
      });
      return JSON.stringify(out);
    })()`);
    console.log('[desktop] audio local visto por la página:', result);
  } catch (err) {
    console.warn('[desktop] no se pudo sondear el audio local:', err?.message || err);
  } finally {
    page.webContents.off('console-message', onConsole);
  }

  if (blocked.length) {
    console.warn('[desktop] el documento bloqueó peticiones al loopback (CSP desplegada):');
    for (const line of blocked) console.warn(`   · ${line}`);
  }
}

/** Información que el cliente usa para detectar la app (se expone en preload.js). */
function bridgeInfo() {
  return {
    app: 'foranly-desktop',
    version: APP_VERSION,
    // Versiones del runtime, para Ajustes → Información (y para diagnosticar
    // incidencias de webview sin pedirle al usuario que abra DevTools).
    electron: process.versions.electron || null,
    chrome: process.versions.chrome || null,
    platform: process.platform,
    musicApiUrl: MUSIC_API_URL,
    musicReady,
    titlebarHeight: TITLEBAR_HEIGHT,
  };
}

/** Icono de la bandeja (con respaldo al de la app si faltara el recorte 32x32). */
function trayIcon() {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  return icon.isEmpty() ? nativeImage.createFromPath(APP_ICON_PATH) : icon;
}

/**
 * Muestra y enfoca la ventana. La usan la bandeja, el segundo lanzamiento y la
 * reactivación en macOS; si la ventana no existe (aún) la crea.
 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Icono de bandeja: es lo que hace que la app pueda quedarse en segundo plano.
 * Con la ventana oculta siguen vivos la sesión, el audio y el servidor de música
 * local; el menú de la bandeja (Abrir / Salir) es la única forma de cerrar del
 * todo, porque la X solo oculta.
 */
function createTray() {
  if (tray) return;

  const icon = trayIcon();
  if (icon.isEmpty()) {
    console.warn('[desktop] no se pudo cargar el icono de bandeja (desktop/assets/tray.png)');
  }

  tray = new Tray(icon);
  tray.setToolTip('Closedoor');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Closedoor', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Salir',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  // Clic izquierdo: trae la ventana al frente (convención Windows/Linux).
  tray.on('click', showMainWindow);

  console.log('[desktop] icono de bandeja listo (cerrar la ventana deja la app en segundo plano)');
}

function openExternal(url) {
  // Solo http(s): nunca file:// ni esquemas raros desde contenido remoto.
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1490,
    height: 805,
    minWidth: 1490,
    minHeight: 805,
    backgroundColor: '#0b0b0f', // mismo fondo que la app: sin flash blanco al abrir
    title: 'Closedoor',
    icon: APP_ICON_PATH, // taskbar/alt-tab en dev; empaquetado lo fija el .exe
    autoHideMenuBar: true,
    show: false, // se muestra en ready-to-show (arranque sin pantalla en blanco)
    // Titlebar personalizada: nada de la barra del compositor/OS.
    //   - Windows/Linux: ventana SIN marco; los botones los dibuja la web
    //     (TitleBar.jsx) sobre una franja arrastrable de TITLEBAR_HEIGHT px.
    //   - macOS: se conservan los semáforos nativos (hiddenInset) porque ahí
    //     son la convención; la web solo reserva la franja superior.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: (TITLEBAR_HEIGHT - 14) / 2 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // La ventana abre MAXIMIZADA: es la única forma de aprovechar la pantalla del
  // usuario sin depender de su resolución (width/height quedan como tamaño de
  // restauración). Se maximiza ANTES de mostrar para que no haya reescalado
  // visible, y la titlebar personalizada recibe el estado real: su useState
  // inicial consulta `window-is-maximized` por IPC síncrono y el evento
  // 'maximize' mantiene el icono maximizar/restaurar al día.
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    console.log(`[desktop] ventana lista (maximizada: ${mainWindow.isMaximized()})`);
  });

  // Avisa a la web cuando cambia el estado maximizado: así el título puede
  // alternar el icono maximizar/restaurar (doble clic en la franja superior).
  const sendWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window-state', { maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);

  // Cerrar la ventana NO cierra la app: se oculta a la bandeja y sigue en
  // segundo plano (sesión, audio y servidor de música intactos). La salida real
  // es bandeja → Salir, que marca isQuitting antes de app.quit().
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    console.log('[desktop] ventana oculta en la bandeja');
  });

  // Enlaces externos → navegador del sistema (dentro de la app son incómodos y
  // rompen el login de terceros).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== new URL(WEB_URL).origin) {
        event.preventDefault();
        openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  // Comprobaciones tras cargar el documento:
  //  - siempre: ¿puede la página leer el servidor de música local? (si no, avisa
  //    con la causa, que casi siempre es una web desplegada más vieja que la CSP)
  //  - con FORANLY_DEBUG=1: puente + salud del audio local (health y <audio>)
  mainWindow.webContents.once('did-finish-load', async () => {
    if (DEBUG) {
      try {
        const seen = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify(window.foranlyDesktop ?? null)'
        );
        console.log('[desktop] puente visto por la web:', seen);
      } catch (err) {
        console.warn('[desktop] no se pudo leer el puente:', err?.message || err);
      }
      await debugLocalAudioFromPage(mainWindow);
    }

    if (musicReady) await checkPageCanReachLocalAudio(mainWindow);
  });

  mainWindow.loadURL(WEB_URL);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Una sola instancia: dos procesos peleando por el puerto 5990 no aportan nada ──
if (!app.requestSingleInstanceLock()) {
  // Sin este aviso, un segundo `npm run desktop` se cerraba en silencio (parece
  // que no arranca) mientras la primera ventana sigue abierta y sin foco.
  console.log('[desktop] ya hay una ventana de Foranly abierta: se enfoca esa.');
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    // El puente se responde por IPC síncrono (sendSync): en preload sandboxeado
    // `process.argv` no es fiable, ipcRenderer sí.
    ipcMain.on(BRIDGE_INFO_CHANNEL, (event) => {
      event.returnValue = bridgeInfo();
    });

    // Permisos: el micro es necesario para las llamadas (LiveKit); todo lo demás
    // (geolocalización, cámara, USB…) se deniega por defecto.
    const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen', 'notifications', 'clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    );

    // El servidor de música se arranca ANTES de abrir la ventana: cuando la web
    // consulta el puente, `musicReady` ya es definitivo (sin carreras).
    await startLocalMusicServer();
    createWindow();
    createTray();

    // Actividad local: sondeo cada 10 s y aviso a la ventana SOLO cuando cambia.
    // Si el usuario cierra la ventana a la bandeja, el watcher sigue vivo (el
    // envío simplemente no tiene destinatario) para que al reabrir la actividad
    // ya esté al día.
    activity.startActivityWatcher({
      onChange: (current) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('foranly:activity', current);
        }
      },
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });

  // Salida real (tray → Salir, Ctrl+Q, cierre del sistema): a partir de aquí el
  // handler de 'close' deja pasar el cierre en vez de ocultar.
  app.on('before-quit', () => {
    isQuitting = true;
    activity.stopActivityWatcher();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.on('window-all-closed', async () => {
    // Cerrar el servidor libera el puerto y deja el proceso salir limpio.
    if (ownMusicServer) {
      try {
        await ownMusicServer.close();
      } catch {
        /* ya estaba cerrado */
      }
      ownMusicServer = null;
    }
    app.quit();
  });
}

// ── Zoom de la ventana ──
// Electron trae el zoom en el menú por defecto (Ctrl + / Ctrl -), pero en una
// ventana sin marco (frame: false) el acelerador de "Reset Zoom" (Ctrl+0) no
// siempre llega al proceso. La web expone por eso Ayustes → Zoom y su propio
// atajo Ctrl+0, ambos a través de este IPC. El nivel se recuerda por origen
// (lo persiste Electron), así que restablecer deja el 100% para siempre.
const ZOOM_LEVEL_MIN = -3; // 1.2^-3 ≈ 58%
const ZOOM_LEVEL_MAX = 3; // 1.2^3 ≈ 173%
const ZOOM_STEP = 0.5;

/** Nivel/factor de zoom actuales de la ventana principal. */
function zoomState() {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!wc || wc.isDestroyed()) return { ok: false, level: 0, factor: 1, percent: 100, min: ZOOM_LEVEL_MIN, max: ZOOM_LEVEL_MAX };
  const factor = wc.getZoomFactor();
  return {
    ok: true,
    level: wc.getZoomLevel(),
    factor,
    percent: Math.round(factor * 100),
    min: ZOOM_LEVEL_MIN,
    max: ZOOM_LEVEL_MAX,
  };
}

ipcMain.handle('window-zoom', (_event, action = 'get') => {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!wc || wc.isDestroyed()) return { ok: false };

  if (action === 'reset') wc.setZoomLevel(0);
  else if (action === 'in') wc.setZoomLevel(Math.min(ZOOM_LEVEL_MAX, wc.getZoomLevel() + ZOOM_STEP));
  else if (action === 'out') wc.setZoomLevel(Math.max(ZOOM_LEVEL_MIN, wc.getZoomLevel() - ZOOM_STEP));

  return zoomState();
});

// ── Actividad local (música / vídeo / juegos) ──
// La web pide el estado actual al montar (invoke) y a partir de ahí recibe los
// cambios por el evento 'foranly:activity'. Devuelve null si no hay nada activo.
ipcMain.handle('foranly:activity-get', () => activity.getActivity());

// Programas abiertos para Ajustes → Actividad. Se consulta bajo demanda (no en
// cada sondeo): solo hace falta cuando el usuario abre esa categoría.
//
// Cada programa lleva además su icono real, sacado del ejecutable con
// app.getFileIcon y serializado a data URL (la web no puede leer el .exe). Se
// cachea por ruta: abrir Ajustes varias veces no vuelve a consultar el shell.
const appIconCache = new Map();

async function attachAppIcons(apps) {
  return Promise.all(
    (apps || []).map(async (item) => {
      const clean = { name: item?.name, exe: item?.exe };
      const filePath = item?.path;
      if (!filePath) return clean;

      let icon = appIconCache.get(filePath);
      if (icon === undefined) {
        try {
          const image = await app.getFileIcon(filePath, { size: 'small' });
          icon = image && !image.isEmpty() ? image.toDataURL() : null;
        } catch {
          icon = null; // ruta protegida o archivo ya cerrado
        }
        appIconCache.set(filePath, icon);
      }

      return icon ? { ...clean, icon } : clean;
    }),
  );
}

ipcMain.handle('foranly:apps-list', async () => {
  const apps = await activity.listRunningApps();
  try {
    return await attachAppIcons(apps);
  } catch {
    // Sin iconos la lista sigue siendo válida: el renderer pone uno genérico.
    return apps.map(({ name, exe }) => ({ name, exe }));
  }
});

// ── Window controls handlers ──
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});
ipcMain.on('window-is-maximized', (event) => {
  event.returnValue = mainWindow ? mainWindow.isMaximized() : false;
});

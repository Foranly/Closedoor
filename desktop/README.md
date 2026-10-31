# Closedoor Desktop (`desktop/`)

Envoltorio **Electron** de la web, con un **servidor de música local**.

## Por qué existe

YouTube decide si entrega el stream completo según la **reputación de la IP**. Desde
un datacenter (Vercel, cualquier VPS) la resolución termina en *"Sign in to confirm
you're not a bot"*; los PO tokens no lo arreglan. Desde la IP residencial del usuario
sí funciona, y la web no puede lanzar procesos en su máquina. La app de escritorio
sí: la ventana carga la web publicada y, en paralelo, levanta el servidor de música
del propio repo (el mismo que usa producción) escuchando **solo en
`127.0.0.1:5990`**.

```
┌────────────────────────── Closedoor Desktop ───────────────────────┐
│  BrowserWindow ──► https://app.foranly.space  (la web publicada)    │
│        │ window.foranlyDesktop = { musicApiUrl, musicReady, … }     │
│        ▼                                                            │
│  src/assets/services/desktopApp.js  (detección en el cliente)       │
│        │ /api/music/stream →                                         │
│        ▼                                                            │
│  http://127.0.0.1:5990  ◄── scripts/music-api-server.mjs (proceso    │
│                              principal, IP residencial del usuario) │
└─────────────────────────────────────────────────────────────────────┘
```

## Uso

```bash
npm run desktop:install                                  # electron + electron-builder (una vez)
npm run desktop                                          # web de producción
FORANLY_WEB_URL=http://localhost:5173 npm run desktop     # dev (requiere `npm run dev`)
```

La ventana abre **maximizada** (1280×820 es el tamaño de restauración); el botón de
la titlebar o el doble clic en la franja superior la restauran.

**Segundo plano:** cerrar la ventana (X) **no** cierra la app — la oculta en la
**bandeja del sistema** y todo sigue vivo (sesión, audio y servidor de música local).
Se recupera con clic en el icono de la bandeja, con *Abrir Closedoor* en su menú, o
relanzando `npm run desktop` (instancia única: la trae al frente). Para salir del
todo: **bandeja → Salir**.

**Zoom:** `Ctrl +` / `Ctrl −` cambian el tamaño de la interfaz (menú de Electron) y
`Ctrl + 0` — o **Ajustes → Zoom de la ventana** — lo devuelve al 100%. El atajo lo
maneja la web (`TitleBar.jsx`) además del menú, porque en una ventana sin marco el
acelerador de "Reset Zoom" no siempre llega; ambos usan el IPC `window-zoom` de
`desktop/main.js`. El nivel se recuerda por origen.

**CSS de escritorio:** los ajustes de layout que solo valen dentro de la app viven en
`src/assets/Resources/Components/css/titleBar.css`, todos bajo `html.fc-desktop` (la
clase que pone `TitleBar.jsx`). Ahí se descuenta la franja de la titlebar de las
alturas de página (`100vh`, `--app-height`); sin eso, el documento gana 40 px de
scroll y en `/chat` el composer y la sidebar flotante quedan cortados.

## Variables de entorno

`FORANLY_WEB_URL` (qué web carga la ventana), `FORANLY_MUSIC_PORT` (puerto local,
**no cambiar sin tocar la CSP**) y `FORANLY_DEBUG=1` (diagnóstico del puente y del
audio desde la página). Tabla completa y valores por defecto:
[ELECTRON_BUILD.md §7](../docs/deployment/ELECTRON_BUILD.md#7-variables-de-entorno).

## Piezas acopladas (si tocas una, revisa la otra)

- **Puerto fijo `5990`**: la CSP de la web solo autoriza `http://127.0.0.1:5990`
  (`plugins/cspPlugin.js`).
- **`scripts/music-api-server.mjs`**: exporta `startMusicServer()`; su CLI sigue
  funcionando igual (`npm run music-api`) para el host propio. Al empaquetar se copia
  a `resources/app/scripts/` junto a `resources/app/api/`, y `app-package.json` se
  copia como `resources/app/package.json` para declarar que esos `.js` son ESM (sin
  él, Node los reparsea y avisa con `MODULE_TYPELESS_PACKAGE_JSON`).
- **Detección en la web**: `src/assets/services/desktopApp.js` lee
  `window.foranlyDesktop` para (1) usar el stream local y (2) no ofrecer la descarga
  a quien ya está en la app.
- **Iconos**: `desktop/assets/icon.png` (512, ventana/taskbar/instalador) y
  `desktop/assets/tray.png` (32, bandeja), declarados en `build.win/mac/linux.icon`
  y empaquetados vía `build.files`. Se generan con `npm run desktop:icons` desde el
  tile de marca `public/mini_icon.png`. ⚠️ No uses `public/logo.svg`: su PNG embebido
  es un trazo blanco finísimo (0,59% de píxeles con alpha) y a 32 px desaparece.
- **Orden de despliegue**: la ventana carga la web publicada, así que **la web se
  despliega primero** (lleva la detección del escritorio y la CSP). Ver
  [ELECTRON_BUILD.md §6.1](../docs/deployment/ELECTRON_BUILD.md#61-orden-de-despliegue-importante).

## Empaquetado

```bash
npm --prefix desktop run build:linux    # .AppImage / .deb
npm --prefix desktop run build:win      # .exe (NSIS)
npm --prefix desktop run build:mac      # .dmg (arm64 + x64; solo en macOS)
```

Salida en `desktop/dist/`. Sin firma de código, Windows/macOS muestran avisos al
abrir el instalador. Guía paso a paso (requisitos, prueba sin pantalla, firma,
publicación del Release): [`docs/deployment/ELECTRON_BUILD.md`](../docs/deployment/ELECTRON_BUILD.md).

## Alcance actual

- La ventana carga la web **publicada**: cada deploy llega al instante, sin
  republicar la app. Solo cambia el binario cuando cambia el envoltorio.
- El servidor local sirve **solo** `/api/music/*` y `/api/music-search`; el resto de
  la API sigue siendo la de producción.
- No sustituye a las llamadas ni al chat: es la misma web, con mejor acceso al audio.

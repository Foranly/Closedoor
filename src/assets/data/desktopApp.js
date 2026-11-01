/**
 * desktopApp.js (datos) — versión y enlaces de descarga de la app de escritorio.
 */

export const DESKTOP_VERSION = '0.1.1';

/** Tag del Release que contiene los instaladores. */
export const DESKTOP_RELEASE_TAG = `v${DESKTOP_VERSION}`;

/** Página del Release (fallback si un asset concreto no existe). */
export const DESKTOP_RELEASE_URL =
  `https://github.com/Frantt21/Closedoor/releases/tag/${DESKTOP_RELEASE_TAG}`;

/** Base de descarga directa de los assets del Release. */
export const DESKTOP_DOWNLOAD_BASE =
  `https://github.com/Frantt21/Closedoor/releases/download/${DESKTOP_RELEASE_TAG}`;

/** Ruta de la página de descargas (a la que apunta el aviso del reproductor). */
export const DESKTOP_DOWNLOAD_PATH = '/download';

/**
 * Instaladores ofrecidos, en el orden en que se muestran.
 * `os` indexa las etiquetas traducidas (download.os_*); `arch` es texto plano.
 */
export const DESKTOP_DOWNLOADS = [
  {
    id: 'windows-x64',
    os: 'windows',
    arch: 'x64',
    file: `Closedoor-${DESKTOP_VERSION}.exe`,
  },
  {
    id: 'macos-arm64',
    os: 'macos',
    arch: 'Apple Silicon',
    file: `Closedoor-${DESKTOP_VERSION}-arm64.dmg`,
  },
  {
    id: 'macos-x64',
    os: 'macos',
    arch: 'Intel',
    file: `Closedoor-${DESKTOP_VERSION}-x64.dmg`,
  },
  {
    id: 'linux-appimage',
    os: 'linux',
    arch: 'AppImage · x86_64',
    file: `Closedoor-${DESKTOP_VERSION}-x86_64.AppImage`,
  },
  {
    id: 'linux-deb',
    os: 'linux',
    arch: '.deb · amd64 · Debian/Ubuntu',
    file: `Closedoor-${DESKTOP_VERSION}-amd64.deb`,
  },
];

/**
 * Agrupación por plataforma para el aviso del reproductor: macOS y Linux
 * ofrecen sus dos variantes (cada una con su enlace).
 */
export const DESKTOP_PLATFORM_GROUPS = [
  {
    os: 'windows',
    labelKey: 'download.os_windows',
    options: [
      { id: 'windows-x64', arch: 'x64', file: `Closedoor-${DESKTOP_VERSION}.exe` },
    ],
  },
  {
    os: 'macos',
    labelKey: 'download.os_macos',
    options: [
      { id: 'macos-arm64', arch: 'Apple Silicon', file: `Closedoor-${DESKTOP_VERSION}-arm64.dmg` },
      { id: 'macos-x64', arch: 'Intel', file: `Closedoor-${DESKTOP_VERSION}-x64.dmg` },
    ],
  },
  {
    os: 'linux',
    labelKey: 'download.os_linux',
    options: [
      { id: 'linux-appimage', arch: 'AppImage', file: `Closedoor-${DESKTOP_VERSION}-x86_64.AppImage` },
      { id: 'linux-deb', arch: '.deb', file: `Closedoor-${DESKTOP_VERSION}-amd64.deb` },
    ],
  },
];

/** URL final del instalador ('' si todavía no está publicado). */
export function getDownloadUrl(entry) {
  if (!entry?.file) return '';
  if (!DESKTOP_DOWNLOAD_BASE) return '';
  return `${DESKTOP_DOWNLOAD_BASE.replace(/\/+$/, '')}/${entry.file}`;
}

/** Ventajas que lista el aviso del reproductor y la página de descargas. */
export const DESKTOP_FEATURES = [
  'desktop.feature_full',
  'desktop.feature_connection',
  'desktop.feature_same',
];

/**
 * Sistema operativo del visitante ('windows' | 'macos' | 'linux' | null).
 * Se usa en /download para enseñar solo el instalador que le corresponde.
 */
export function detectDesktopOS() {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();

  if (platform.includes('win') || /windows nt/i.test(ua)) return 'windows';

  if (platform.includes('mac') || /macintosh|mac os x/i.test(ua)) {
    if (/iphone|ipad|ipod/i.test(ua)) return null;
    return 'macos';
  }

  if (/android/i.test(ua)) return null;

  if (platform.includes('linux') || /linux|x11/i.test(ua)) return 'linux';

  return null;
}

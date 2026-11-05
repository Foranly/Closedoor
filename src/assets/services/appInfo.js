/**
 * appInfo.js — versión de la web, deploy actual y releases de la app de escritorio.
 *
 * De dónde sale cada dato:
 *   - Versión web: `package.json` inyectado como `import.meta.env.VITE_APP_VERSION`
 *     (vite.config.js → `define`), así el número vive en un solo sitio.
 *   - Deploy actual: el `<meta name="build-id">` que escribe
 *     plugins/buildIdPlugin.js en el build, y `/version.json` (mismo `buildId` +
 *     `builtAt`) para la fecha. En dev no existen: se devuelve '' / null.
 *   - App de escritorio: la última release del repo en GitHub. Sin token, así que
 *     comparte los 60 req/h por IP de la API pública — de sobra para un botón
 *     que el usuario pulsa a mano.
 *
 * Todo degrada sin lanzar: sin red, sin meta o sin release, el llamador recibe
 * '' / null / una excepción controlada y la UI muestra "no se pudo comprobar".
 */

import { getDesktopBridge } from './desktopApp';

/** Repo del que se leen las releases de la app de escritorio. */
const RELEASES_REPO = 'Frantt21/Closedoor';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

const VERSION_URL = '/version.json';

/** Versión del bundle web que está corriendo ('dev' si falta el define). */
export function getWebVersion() {
  try {
    return import.meta.env.VITE_APP_VERSION || 'dev';
  } catch {
    return 'dev';
  }
}

/** `build-id` con el que se generó ESTE bundle ('' en dev / builds antiguos). */
export function getBuildId() {
  try {
    return document.querySelector('meta[name="build-id"]')?.getAttribute('content') || '';
  } catch {
    return '';
  }
}

/**
 * Lo que el servidor está sirviendo ahora mismo.
 * @returns {Promise<{buildId: string, builtAt: string|null}|null>} null si no se pudo leer
 */
export async function fetchDeployInfo() {
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const buildId = typeof data?.buildId === 'string' ? data.buildId : '';
    if (!buildId) return null;
    return {
      buildId,
      builtAt: typeof data?.builtAt === 'string' ? data.builtAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Última release publicada en GitHub.
 * @returns {Promise<{tag: string, version: string, name: string, url: string, publishedAt: string|null}>}
 * @throws si GitHub no responde o no hay releases
 */
export async function fetchLatestRelease() {
  const res = await fetch(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`github_${res.status}`);
  const data = await res.json();
  const tag = typeof data?.tag_name === 'string' ? data.tag_name : '';
  if (!tag) throw new Error('github_no_tag');
  return {
    tag,
    version: normalizeVersion(tag),
    name: typeof data?.name === 'string' && data.name ? data.name : tag,
    url:
      typeof data?.html_url === 'string' && data.html_url
        ? data.html_url
        : `https://github.com/${RELEASES_REPO}/releases/tag/${tag}`,
    publishedAt: typeof data?.published_at === 'string' ? data.published_at : null,
  };
}

/** 'v1.2.3-beta.1' → '1.2.3' (quita la 'v' y el sufijo de pre-release). */
export function normalizeVersion(value) {
  const raw = String(value ?? '').trim().replace(/^v/i, '');
  return raw.split('-')[0].split('+')[0];
}

/**
 * Compara dos versiones numéricas tipo '1.2.3'.
 * @returns {number} 1 si `a` es mayor, -1 si es menor, 0 si son iguales.
 */
export function compareVersions(a, b) {
  const parse = (v) => normalizeVersion(v).split('.').map((part) => parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/** Versión de la app de escritorio según el puente (`null` en el navegador). */
export function getDesktopVersion() {
  const bridge = getDesktopBridge();
  return typeof bridge?.version === 'string' ? bridge.version : null;
}

/**
 * FastChange CDN Service
 * Handles image uploads to the Go CDN server at api.foranly.cloud
 * Supports: avatar, banner, post, chat images
 *
 * Upload results are cached in encrypted localStorage by CONTENT HASH
 * (userId + type + sha256(file content)) so that re-uploading the same file
 * returns instantly without a network request. No se usa nombre/tamaño/fecha
 * como clave porque las capturas de Windows pegadas al chat comparten esos
 * campos y colisionaban devolviendo la imagen anterior.
 *
 * Cache: permanente. El backend CDN usa dedup por hash, así que las URLs
 * cacheadas NUNCA se vuelven obsoletas. Cada entrada ocupa ~300 bytes en
 * encrypted localStorage — caben miles antes de llenar la cuota (~5MB).
 */

import { getItem, setItem, removeItem } from './secureStorage';
import { supabase } from './supabaseclient';

const CDN_BASE = import.meta.env.VITE_CDN_URL || '';

// ── Límites de subida (cliente) ──
// El CDN también valida/auth, pero esto corta el spam antes de gastar red:
// tamaño máximo por tipo y cuántas imágenes por minuto puede subir un usuario.
// (Los videos no se suben: van siempre por URL, y su frecuencia la limita el
// rate limit de posts de la migración 092.)
const MB = 1024 * 1024;
const UPLOAD_WINDOW_MS = 60 * 1000;
const UPLOAD_LIMITS = {
  avatar: { maxBytes: 8 * MB, perMinute: 5 },
  banner: { maxBytes: 12 * MB, perMinute: 5 },
  post: { maxBytes: 15 * MB, perMinute: 10 },
  chat: { maxBytes: 10 * MB, perMinute: 20 },
};

const UPLOAD_LIMIT_MESSAGES = {
  es: {
    tooLarge: 'La imagen pesa {size} MB y el máximo es {max} MB.',
    rate: 'Has subido demasiadas imágenes. Espera {seconds} s antes de subir otra.',
    server: 'No se puede subir la imagen: el servidor de imágenes no tiene la verificación de sesión configurada.',
  },
  en: {
    tooLarge: 'The image is {size} MB and the limit is {max} MB.',
    rate: 'Too many uploads. Wait {seconds}s before uploading another image.',
    server: 'The image cannot be uploaded: the image server has no session verification configured.',
  },
  pt: {
    tooLarge: 'A imagem tem {size} MB e o limite é {max} MB.',
    rate: 'Muitos envios. Aguarde {seconds}s antes de enviar outra imagem.',
    server: 'Não é possível enviar a imagem: o servidor de imagens não tem a verificação de sessão configurada.',
  },
  ru: {
    tooLarge: 'Изображение весит {size} МБ, максимум — {max} МБ.',
    rate: 'Слишком много загрузок. Подождите {seconds} с перед следующей.',
    server: 'Не удалось загрузить изображение: на сервере изображений не настроена проверка сессии.',
  },
  ja: {
    tooLarge: '画像は {size} MB です。上限は {max} MB です。',
    rate: 'アップロードが多すぎます。次の画像まで {seconds} 秒お待ちください。',
    server: '画像をアップロードできません: 画像サーバーにセッション検証が設定されていません。',
  },
};

function uploadLimitText(key, params) {
  let locale = 'es';
  try {
    locale = getItem('fc_locale') || 'es';
  } catch { /* sin storage: español */ }
  const dict = UPLOAD_LIMIT_MESSAGES[locale] || UPLOAD_LIMIT_MESSAGES.es;
  let text = dict[key] || UPLOAD_LIMIT_MESSAGES.es[key];
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}

function readUploadTimes(userId, type) {
  try {
    const raw = getItem(`fc_media_uploads_${userId}_${type}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'number') : [];
  } catch {
    return [];
  }
}

function recordUpload(userId, type) {
  try {
    const now = Date.now();
    const times = readUploadTimes(userId, type)
      .filter((t) => now - t < UPLOAD_WINDOW_MS)
      .concat(now);
    setItem(`fc_media_uploads_${userId}_${type}`, JSON.stringify(times));
  } catch { /* sin storage: el límite se aplica igualmente por sesión */ }
}

/**
 * Valida tamaño y frecuencia antes de tocar la red. Lanza un Error con el
 * mensaje ya traducido (el locale sale de secureStorage, igual que useI18n).
 */
function assertUploadAllowed(file, userId, type) {
  const limits = UPLOAD_LIMITS[type] || UPLOAD_LIMITS.post;

  if (file.size > limits.maxBytes) {
    throw new Error(uploadLimitText('tooLarge', {
      size: (file.size / MB).toFixed(1),
      max: Math.round(limits.maxBytes / MB),
    }));
  }

  const now = Date.now();
  const recent = readUploadTimes(userId, type).filter((t) => now - t < UPLOAD_WINDOW_MS);
  if (recent.length >= limits.perMinute) {
    const wait = Math.max(1, Math.ceil((recent[0] + UPLOAD_WINDOW_MS - now) / 1000));
    throw new Error(uploadLimitText('rate', { seconds: wait }));
  }
}
const CACHE_PREFIX = 'cdn_upload_';

/**
 * Access token de Supabase para autenticar uploads/borrados contra el CDN.
 * El CDN verifica el JWT (SUPABASE_JWT_SECRET) y exige que el sub coincida
 * con el user_id del form → sin sesión válida no se puede llamar al API.
 */
async function getAccessToken() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || '';
  } catch {
    return '';
  }
}
// TTL de la caché de uploads: si la copia del CDN se pierde (borrado manual,
// limpieza de storage del server…), la entrada caduca sola y no se reutiliza
// una URL muerta para siempre (la caché era permanente antes de esto).
const UPLOAD_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 días

/**
 * Genera un hash SHA-256 del contenido del archivo.
 * Devuelve null si crypto.subtle no está disponible (contexto no seguro) —
 * en ese caso se usa el fallback de nombre/tamaño/fecha.
 */
async function getFileContentHash(file) {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Generate a cache key for the upload result.
 * Se identifica por el HASH del CONTENIDO (no por nombre/tamaño/fecha):
 * las capturas de Windows (Win+Shift+S) pegadas al chat comparten nombre,
 * tamaño y lastModified, lo que hacía colisionar la clave y devolver la
 * imagen anterior. Con el hash, contenido distinto → clave distinta, y
 * re-subir el MISMO archivo sigue devolviendo la URL cacheada al instante.
 */
async function getUploadCacheKey(userId, type, file) {
  const contentHash = await getFileContentHash(file);
  const fingerprint = contentHash || `${file.name}_${file.size}_${file.lastModified}`;
  return `${CACHE_PREFIX}${userId}_${type}_${fingerprint}`;
}

/**
 * Try to get a cached upload result for the given file.
 * Returns the cached result or null if not found/expired.
 * Ahora con TTL: una entrada antigua (>30 días) se descarta y se re-suben
 * los bytes de verdad, en vez de reutilizar una URL posiblemente muerta.
 */
async function getCachedUpload(userId, type, file) {
  try {
    const key = await getUploadCacheKey(userId, type, file);
    const parsed = await getItem(key);
    if (!parsed) return null;
    if (Date.now() - (parsed.timestamp || 0) > UPLOAD_CACHE_TTL) {
      await removeItem(key);
      return null;
    }
    return parsed.result;
  } catch {
    return null;
  }
}

/**
 * Drop a cached upload result (e.g. after validating it is a dead URL).
 */
async function removeCachedUpload(userId, type, file) {
  try {
    const key = await getUploadCacheKey(userId, type, file);
    await removeItem(key);
  } catch {
    // Ignorar
  }
}

/**
 * Verify that a CDN file still exists on the server (HEAD request).
 * Devuelve true si el archivo responde OK, o si la URL NO es del CDN
 * (no se puede/puede que no deba validarse una URL externa).
 *
 * Esto permite sanear URLs muertas: si la copia del CDN se perdió, la caché
 * de uploads dejará de reutilizarla y la re-subida creará un archivo nuevo.
 */
export async function verifyCdnFile(url) {
  if (!url) return false;
  const path = getCdnUrl(url);
  if (!path.startsWith('/cdn/files/')) return true; // No es CDN → no validar
  try {
    const res = await fetch(path, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Save an upload result to the cache.
 */
async function setCachedUpload(userId, type, file, result) {
  try {
    const key = await getUploadCacheKey(userId, type, file);
    await setItem(key, {
      result,
      timestamp: Date.now(),
    });
  } catch {
    // localStorage might be full
  }
}

/**
 * Upload an image to the CDN server with optimistic local preview.
 * Creates a blob:// URL from the file instantly for immediate display,
 * then uploads to CDN in the background.
 *
 * @param {File} file - The image file to upload
 * @param {string} userId - The user's UUID
 * @param {'avatar'|'banner'|'post'|'chat'} type - Image type for sizing
 * @returns {{localUrl: string, realUrlPromise: Promise<string>, realResultPromise: Promise<{url: string, id: string, width?: number, height?: number}>}}
 *
 * Usage:
 *   const { localUrl, realUrlPromise } = uploadWithLocalPreview(file, userId, type);
 *   setPreview(localUrl);           // show instantly
 *   const realUrl = await realUrlPromise;  // wait for CDN in background
 *   setPreview(realUrl);            // swap with real URL
 */
export function uploadWithLocalPreview(file, userId, type) {
  // Create local object URL instantly for preview
  const localUrl = URL.createObjectURL(file);

  // Una sola promesa de subida compartida (evita uploads duplicados)
  const resultPromise = uploadImage(file, userId, type);

  // Resultado completo ({url,id,width,height,...}) para quien necesite dims
  const realResultPromise = resultPromise;

  // Start CDN upload in background
  const realUrlPromise = resultPromise
    .then(result => {
      // ⚠️ Delayed cleanup: esperar a que React commitée la URL real
      // antes de revocar el blob URL, para evitar ERR_FILE_NOT_FOUND
      // en <img> que todavía apuntan al blob.
      requestAnimationFrame(() => URL.revokeObjectURL(localUrl));
      return result.url;
    })
    .catch(err => {
      // Clean up on error: el blob ya no sirve
      URL.revokeObjectURL(localUrl);
      throw err;
    });

  return { localUrl, realUrlPromise, realResultPromise };
}

/**
 * Fetch autenticado contra el CDN con reintento automático ante 401: refresca
 * la sesión de Supabase (sana sesiones viejas o expiradas — p. ej. creadas con
 * una signing key anterior a una rotación ECC) y reintenta una vez con el
 * token nuevo. Si el refresh falla, la sesión está muerta → lanza
 * session_expired (el usuario debe volver a iniciar sesión).
 *
 * NOTA: el retry solo ocurre en 401, y el CDN rechaza ANTES de procesar la
 * petición (verifica el token antes de leer el body), así que no hay riesgo
 * de duplicar una subida.
 */
async function authedCdnFetch(url, init, token) {
  const doFetch = (tok) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}` },
    });

  // Lee el motivo del rechazo del body (token expirado, firma inválida, kid
  // rotado, rol no permitido…). Se captura ANTES del reintento para no perderlo
  // si el reintento falla por infraestructura (502).
  const readReason = async (res) => {
    try {
      const body = await res.clone().json();
      return body.reason || body.error || '';
    } catch {
      return '';
    }
  };

  let response = await doFetch(token);
  let firstReason = '';

  if (response.status === 401) {
    firstReason = await readReason(response);
    try {
      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
      const freshToken = refreshData?.session?.access_token;
      if (!refreshError && freshToken) {
        response = await doFetch(freshToken);
      }
    } catch {
      // Ignorar: se propaga el 401 original
    }
  }

  if (response.status === 401) {
    const reason = (await readReason(response)) || firstReason;
    throw new Error(`session_expired${reason ? ` (${reason})` : ''}: vuelve a iniciar sesión para subir o borrar imágenes`);
  }

  // El reintento falló por infraestructura pero el 401 original era de auth:
  // preservar la razón para no perder el diagnóstico.
  if ((response.status === 502 || response.status === 503 || response.status === 504) && firstReason) {
    throw new Error(`cdn_unavailable (auth rechazó: ${firstReason}) — reintenta en unos segundos`);
  }
  return response;
}

/**
 * Upload an image to the CDN server.
 * Results are cached by file fingerprint — re-uploading the same file returns
 * the cached URL immediately without a network request.
 * @param {File} file - The image file to upload
 * @param {string} userId - The user's UUID
 * @param {'avatar'|'banner'|'post'|'chat'} type - Image type for sizing
 * @returns {Promise<{url: string, id: string, width?: number, height?: number}>}
 */
export async function uploadImage(file, userId, type) {
  if (!file || !userId || !type) {
    throw new Error('Missing required parameters: file, userId, type');
  }

  // Validate file type + size ANTES del hash/caché: así un archivo inválido
  // (tipo no soportado o >20MB) falla rápido sin leer su contenido completo
  // para calcular el hash de la clave de caché.
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP`);
  }

  // Tamaño máximo y frecuencia por usuario/tipo (mensaje ya traducido)
  assertUploadAllowed(file, userId, type);

  // ── Check local cache first (instant return for re-uploads) ──
  const cached = await getCachedUpload(userId, type, file);
  if (cached) {
    const url = normalizeCdnUrl(cached.url);
    // Validar que el archivo SIGUE existiendo en el CDN: si la copia del CDN
    // se perdió (borrado manual, limpieza de storage…), el URL cacheado está
    // muerto y reutilizarlo guardaría una imagen rota para todos los usuarios
    // (solo visible para quien la subió, por la caché del navegador).
    // En ese caso se descarta la entrada y se re-suben los bytes de verdad
    // (nuevo id en el CDN) — así la re-subida sana el banner/avatar roto.
    if (await verifyCdnFile(url)) {
      return { ...cached, url };
    }
    await removeCachedUpload(userId, type, file);
  }

  // El CDN exige autenticación JWT en upload (ratelimit + verificación incluidos)
  const token = await getAccessToken();
  if (!token) {
    throw new Error('auth_required: inicia sesión para subir imágenes');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('user_id', userId);
  formData.append('type', type);

  const response = await authedCdnFetch(`${CDN_BASE}/cdn/upload`, {
    method: 'POST',
    body: formData,
    // No Content-Type header - browser sets it with boundary for FormData
  }, token);

  // El CDN responde JSON siempre, pero un 502/504 del proxy (server reiniciando
  // o caído) llega con body vacío → no asumir que el body es parseable.
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      response.status === 502 || response.status === 503 || response.status === 504
        ? 'cdn_unavailable: el servidor de imágenes no está disponible, intenta de nuevo'
        : `upload_failed: el servidor respondió ${response.status}`
    );
  }

  if (!data.success) {
    // Servidor sin credenciales JWT (fail-closed): sin esto el toast mostraba
    // el código crudo `server_not_configured`.
    if (data.error === 'server_not_configured') {
      throw new Error(uploadLimitText('server', {}));
    }
    // Límites del CDN (la decisión real, no solo el chequeo del cliente).
    if (data.error === 'rate_limited') {
      const wait = data.retry_after || response.headers.get('Retry-After') || 60;
      throw new Error(uploadLimitText('rate', { seconds: wait }));
    }
    if (response.status === 413) {
      const limits = UPLOAD_LIMITS[type] || UPLOAD_LIMITS.post;
      throw new Error(uploadLimitText('tooLarge', {
        size: (file.size / MB).toFixed(1),
        max: Math.round(limits.maxBytes / MB),
      }));
    }
    // reason llega del CDN (token expirado, kid rotado, firma inválida…)
    throw new Error(data.reason || data.error || 'Upload failed');
  }

  // Si el CDN devolvió url (nueva subida) la normalizamos a ruta relativa.
  // Si no (dedup hit: el CDN reusó un archivo existente y solo devolvió el id),
  // construimos la URL relativa desde el id.
  const result = {
    url: data.url ? normalizeCdnUrl(data.url) : `/cdn/files/${data.id}`,
    id: data.id,
    width: data.width,
    height: data.height,
    sizeKB: data.size_kb,
  };

  // Contar la subida real (los hits de caché no gastan red ni cuentan)
  recordUpload(userId, type);

  // Cache the result so re-uploading the same file is instant
  setCachedUpload(userId, type, file, result).catch(() => {});

  return result;
}

/**
 * Delete an image from the CDN server.
 * @param {string} imageId - The image UUID
 * @returns {Promise<boolean>}
 */
export async function deleteImage(imageId) {
  if (!imageId) return false;

  try {
    // El CDN exige autenticación JWT en DELETE + ser el dueño del archivo
    const token = await getAccessToken();
    if (!token) return false;
    const response = await authedCdnFetch(`${CDN_BASE}/cdn/files/${imageId}`, {
      method: 'DELETE',
    }, token);
    let data = {};
    try {
      data = await response.json();
    } catch {
      // 502/504 con body vacío → considerar fallo silencioso
    }
    return data.success === true;
  } catch (err) {
    console.warn('Error deleting image from CDN:', err);
    return false;
  }
}

/**
 * Get the full CDN URL for a file ID.
 * @param {string} fileId - The file UUID
 * @returns {string}
 */
/**
 * Convert a CDN URL to a same-origin relative path so the browser loads it
 * through the Vite proxy (dev) or Vercel rewrites (production) instead of
 * hitting the HTTP-only CDN server directly over HTTPS.
 *  *   http://api.foranly.cloud:24587/cdn/files/xxx → /cdn/files/xxx
 *
 * ⚠️ SIEMPRE devuelve un string (nunca undefined/null) para evitar que
 *    componentes llamen .trim() sobre undefined y lancen TypeError.
 */
export function normalizeCdnUrl(url) {
  if (!url) return ''; // ← devolver '' en vez del valor falsy
  // Si es una URL absoluta HTTP/HTTPS, extraer solo el path relativo
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    // No es una URL parseable → probablemente ya es relativa o un ID
    return url;
  }
}

/**
 * Get the CDN URL for a file ID, always returning a same-origin relative path.
 * Úsala en TODOS los componentes que rendericen imágenes del CDN para
 * garantizar que nunca se cargue una URL HTTP directa (previene Mixed Content).
 *
 * ⚠️ IMPORTANTE: Solo normaliza URLs que sean realmente del CDN.
 * URLs externas (Pinterest, GIPHY, Tenor, etc.) se devuelven intactas.
 *
 * @param {string} fileId - The file UUID, full URL, or relative path
 * @returns {string} - Relative path like "/cdn/files/xxx" or the original URL
 */
export function getCdnUrl(fileId) {
  if (!fileId) return '';

  // Si NO es URL del CDN, devolver tal cual (imágenes externas: Pinterest, GIPHY, etc.)
  if (!isCdnUrl(fileId)) return fileId;

  // Es URL del CDN → normalizar a ruta relativa
  if (fileId.startsWith('http://') || fileId.startsWith('https://')) {
    const normalized = normalizeCdnUrl(fileId);
    if (normalized.startsWith('/cdn/')) return normalized;
    // Si normalizeCdnUrl devolvió algo inesperado, reconstruir desde el ID
    return `/cdn/files/${fileId.split('/').pop()}`;
  }
  // Si ya es /cdn/files/xxx, devolver tal cual
  if (fileId.startsWith('/cdn/')) return fileId;
  // Es solo un ID → construir ruta completa
  return `/cdn/files/${fileId}`;
}

/**
 * Check if a URL is from our CDN.
 * Reconoce rutas relativas (/cdn/files/xxx), URLs del CDN_BASE configurado,  * y URLs absolutas con path /cdn/ (ej: http://api.foranly.cloud:24587/cdn/files/xxx).
 * @param {string} url
 * @returns {boolean}
 */
export function isCdnUrl(url) {
  if (!url) return false;
  // Relativa: /cdn/files/xxx
  if (url.startsWith('/cdn/')) return true;
  // Desde VITE_CDN_URL (si está configurado)
  if (CDN_BASE && url.startsWith(CDN_BASE)) return true;
  // URLs absolutas con /cdn/ en el path (backend devuelve http://api.foranly.cloud:24587/cdn/files/xxx)
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/cdn/')) return true;
  } catch {
    // No se puede parsear como URL — no es CDN
  }
  return false;
}

/**
 * Extract file ID from a CDN URL.
 * @param {string} url
 * @returns {string|null}
 */
export function getFileIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/cdn\/files\/([^/?#]+)/);
  return match ? match[1] : null;
}

/**
 * Build the feed-thumbnail URL for a CDN image.
 * Devuelve `/cdn/files/<id>/thumb` (variante ~480w generada por el CDN).
 * Si la imagen no es del CDN (Pinterest, GIPHY…) o no se puede extraer el
 * ID, devuelve la URL original. El endpoint de thumb hace fallback al
 * archivo completo cuando la variante no existe (uploads legacy), así que
 * esta URL es siempre segura de usar.
 * @param {string} url
 * @returns {string}
 */
export function getCdnThumbUrl(url) {
  if (!url) return '';
  const normalized = getCdnUrl(url);
  const fileId = getFileIdFromUrl(normalized);
  if (!fileId || !isCdnUrl(normalized)) return normalized;
  return `/cdn/files/${fileId}/thumb`;
}

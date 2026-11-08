/**
 * activityService.js — actividad local del usuario (música / vídeo / juegos).
 *
 * CONTEXTO: la web no puede leer sesiones multimedia ni procesos del sistema.
 * La app de escritorio sí (desktop/activity.js) y la publica por IPC
 * (window.electron.activity, ver desktop/preload.js). Este módulo se encarga de
 * la parte de DATOS:
 *
 *   1. Normalizar lo que llega del bridge a un shape estable y acotado.
 *   2. Decidir si un registro guardado en `profiles.activity` sigue siendo
 *      válido (si no, se oculta como si no hubiera actividad).
 *   3. Escribirlo en la fila del usuario, con dedupe.
 *
 * El shape guardado es el mismo que devuelve el detector, sin `detectedAt` (esa
 * marca es local; lo que caduca el registro es `activity_updated_at`, que pone
 * la base de datos al escribir).
 *
 * Requiere la migración services/migrations/079_profiles_activity.sql (columnas
 * `activity` / `activity_updated_at`). No hace falta GRANT: la 071 dejó los
 * privilegios de `profiles` a nivel tabla.
 */

import { supabase } from './supabaseclient';

/**
 * Cuánto vale una actividad guardada. Si el equipo se apagó, la app crasheó o
 * el usuario cerró sesión sin limpiar, el registro se queda huérfano; pasado
 * este tiempo se ignora en vez de mostrar algo que ya no está pasando.
 */
export const ACTIVITY_TTL_MS = 1000 * 60 * 15;

/** Límites de longitud: lo que se guarda se pinta a otros usuarios. */
const MAX_TITLE = 160;
const MAX_SUBTITLE = 160;
const MAX_ALBUM = 160;
const MAX_APP = 60;
const MAX_URL = 500;

/**
 * `app` no lo detecta el watcher: es el programa que el usuario elige a mano en
 * Ajustes → Actividad. Se guarda en su propia columna (`program_activity`) para
 * que conviva con la canción, y se normaliza aquí para reutilizar el mismo shape.
 */
const KINDS = new Set(['music', 'video', 'game', 'app']);

function clip(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
}

/**
 * Normaliza una actividad (del bridge o de la fila de la DB).
 *
 * Acepta cualquier cosa: si falta `kind` o `title`, o el kind no es conocido,
 * devuelve `null`. Así un dato corrupto en la fila no rompe la card.
 *
 * @returns {null | {kind: 'music'|'video'|'game', title: string, subtitle: string|null, album: string|null, app: string|null, url: string|null}}
 */
export function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = typeof raw.kind === 'string' ? raw.kind.toLowerCase() : '';
  if (!KINDS.has(kind)) return null;
  const title = clip(raw.title, MAX_TITLE);
  if (!title) return null;
  return {
    kind,
    title,
    subtitle: clip(raw.subtitle, MAX_SUBTITLE),
    album: clip(raw.album, MAX_ALBUM),
    app: clip(raw.app, MAX_APP),
    url: clip(raw.url, MAX_URL),
  };
}

/**
 * ¿El registro guardado sigue siendo actual?
 *
 * Sin `updatedAt` se considera caducado: mejor no mostrar nada que mostrar algo
 * de hace días.
 */
export function isActivityFresh(activity, updatedAt, now = Date.now()) {
  if (!activity) return false;
  if (!updatedAt) return false;
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) return false;
  // Tolerancia de 1 min hacia el futuro por desajustes de reloj del cliente.
  return now - ts < ACTIVITY_TTL_MS && ts - now < 60 * 1000;
}

/**
 * Programa elegido a mano por el dueño del perfil (columna `program_activity`).
 *
 * No caduca como la actividad detectada: es una elección explícita del usuario y
 * sigue vigente hasta que la cambie o la quite.
 *
 * @returns {null | {kind: 'app', title: string, subtitle: null, album: null, app: string, url: null}}
 */
export function programFromProfile(profile) {
  if (!profile) return null;
  return normalizeActivity(profile.program_activity);
}

/**
 * Guarda (o quita con `null`) el programa que el usuario quiere mostrar.
 *
 * Va aparte de `persistActivity` porque esa columna la sobreescribe el watcher
 * cada vez que cambia la canción; si compartieran columna, elegir un programa
 * borraría la música y viceversa.
 *
 * @param {string} userId
 * @param {string|null} appName
 * @returns {Promise<object|null>} el valor normalizado que se escribió
 */
export async function persistProgramActivity(userId, appName) {
  if (!userId) return null;

  const name = typeof appName === 'string' ? appName.trim().slice(0, MAX_APP) : '';
  const program = name ? normalizeActivity({ kind: 'app', title: name, app: name }) : null;

  const { error } = await supabase
    .from('profiles')
    .update({ program_activity: program })
    .eq('id', userId);

  if (error) throw error;
  return program;
}

/**
 * Actividad de un perfil leído de la DB, ya validada y caducada si toca.
 *
 * @param {{activity?: object|null, activity_updated_at?: string|null}} profile
 * @returns {null | {kind: string, title: string, ...}}
 */
export function activityFromProfile(profile) {
  if (!profile) return null;
  const activity = normalizeActivity(profile.activity);
  if (!activity) return null;
  return isActivityFresh(activity, profile.activity_updated_at) ? activity : null;
}

/** Firma de una actividad normalizada — para detectar cambios sin comparar objetos. */
export function activitySignature(activity) {
  if (!activity) return '';
  return [activity.kind, activity.title, activity.subtitle || '', activity.album || '', activity.app || '', activity.url || ''].join('\u0001');
}

// Última escritura confirmada. Vive a nivel de módulo para que navegar entre
// perfiles (que desmonta y remonta la card) no repita el mismo UPDATE.
let lastWrittenKey = null;

/**
 * Olvida la última escritura confirmada.
 *
 * Se llama al reportar 'disconnected': esa escritura limpia `activity` en la
 * fila, así que el dedupe quedaría mintiendo y, al volver, la misma canción no
 * se republicaría (la card se vería vacía hasta el siguiente cambio de tema).
 */
export function resetActivityDedupe() {
  lastWrittenKey = null;
}

/**
 * Guarda la actividad en la fila del usuario (o la limpia con `null`).
 *
 * Dedupe: si el valor es idéntico al último escrito con éxito no se vuelve a
 * escribir. El detector sondea cada 10 s, pero solo avisa cuando cambia, así que
 * en la práctica esto es una escritura por cambio real de canción/juego.
 *
 * @param {string} userId
 * @param {null | object} rawActivity
 * @returns {Promise<boolean>} true si se escribió, false si no había nada que hacer
 */
export async function persistActivity(userId, rawActivity) {
  if (!userId) return false;

  const activity = normalizeActivity(rawActivity);
  const key = `${userId}:${activitySignature(activity)}`;
  if (key === lastWrittenKey) return false;

  const { error } = await supabase
    .from('profiles')
    .update({
      activity,
      activity_updated_at: activity ? new Date().toISOString() : null,
    })
    .eq('id', userId);

  if (error) {
    // Sin marca de "escrito" para que el siguiente cambio (o reintento) sí lo intente.
    lastWrittenKey = null;
    throw error;
  }


  lastWrittenKey = key;
  return true;
}

// ── Ajustes de privacidad (migración 080) ──

/**
 * Ajustes de actividad del perfil con los valores por defecto de la 080
 * aplicados a filas antiguas o incompletas.
 *
 * @returns {{enabled: boolean, visibility: 'followers'|'nobody'}}
 */
export function getActivitySettings(profile) {
  return {
    enabled: profile?.activity_enabled !== false,
    visibility: profile?.activity_visibility === 'nobody' ? 'nobody' : 'followers',
  };
}

/**
 * ¿Debe escribirse en la fila? Con `nobody` no: si nadie la va a ver, lo correcto
 * es no guardarla (y limpiar la que hubiera), no guardarla y esconderla.
 */
export function shouldPublishActivity(profile) {
  const { enabled, visibility } = getActivitySettings(profile);
  return enabled && visibility !== 'nobody';
}

/**
 * ¿Puede este visitante ver la card de actividad del dueño?
 *
 * Es el mismo criterio que aplica ActivityCard, extraído aquí para que la regla
 * viva en un solo sitio.
 *
 * @param {object} params
 * @param {object} params.profile - Fila del dueño (activity_enabled / visibility).
 * @param {boolean} params.isOwnProfile
 * @param {boolean|null} params.viewerIsFollower - null = todavía no se sabe.
 */
export function canViewActivity({ profile, isOwnProfile, viewerIsFollower }) {
  const { enabled, visibility } = getActivitySettings(profile);
  if (!enabled) return false;
  if (isOwnProfile) return true;
  if (visibility === 'nobody') return false;
  return viewerIsFollower === true;
}

// ── Historial local (solo app de escritorio) ──
//
// Vive en localStorage del renderer de Electron, como pidió el producto. Prefijo
// `fca_` (no `fc_`) a propósito: clearAllAppCaches() borra todo `fc_*` y `_s*` al
// cerrar sesión o al limpiar caché, y el historial es DATO del usuario, no caché.
// La clave incluye el id de usuario para que dos cuentas en el mismo equipo no
// mezclen historiales.
const HISTORY_PREFIX = 'fca_activity_history_';
const HISTORY_LIMIT = 40;

const historyKey = (userId) => `${HISTORY_PREFIX}${userId}`;

/**
 * Historial del usuario, de más reciente a más antiguo.
 *
 * Cada entrada: { kind, title, subtitle, album, app, url, startedAt, endedAt }.
 * `endedAt` es null mientras sigue en curso.
 *
 * @returns {Array<object>}
 */
export function readActivityHistory(userId) {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(historyKey(userId));
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((entry) => entry && typeof entry.title === 'string' && entry.title).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeActivityHistory(userId, list) {
  try {
    localStorage.setItem(historyKey(userId), JSON.stringify(list.slice(0, HISTORY_LIMIT)));
    return true;
  } catch {
    return false; // storage lleno o bloqueado: el historial es best-effort
  }
}

/**
 * Registra un cambio de actividad: cierra la entrada abierta y abre la nueva.
 *
 * Si llega `null` (dejó de sonar) solo cierra la entrada abierta. Si la
 * actividad es la misma que la abierta, no hace nada — el detector ya deduplica,
 * pero el efecto que llama aquí puede reejecutarse al remontar el componente.
 *
 * @returns {boolean} true si el historial cambió
 */
export function recordActivity(userId, rawActivity) {
  if (!userId) return false;

  const activity = normalizeActivity(rawActivity);
  const list = readActivityHistory(userId);
  const openEntry = list[0] && !list[0].endedAt ? list[0] : null;
  const signature = activitySignature(activity);

  if (openEntry && activitySignature(openEntry) === signature) return false;

  const now = new Date().toISOString();
  let next = list;

  if (openEntry) next = [{ ...openEntry, endedAt: now }, ...list.slice(1)];
  if (activity) next = [{ ...activity, startedAt: now, endedAt: null }, ...next];

  return writeActivityHistory(userId, next);
}

/** Borra el historial del usuario en este equipo. */
export function clearActivityHistory(userId) {
  if (!userId) return;
  try {
    localStorage.removeItem(historyKey(userId));
  } catch {
    /* storage bloqueado */
  }
}

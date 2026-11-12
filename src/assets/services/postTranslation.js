/**
 * Traducción de posts. Dos motores:
 *
 *  1. El del navegador (`LanguageDetector` + `Translator`, Chrome/Edge 138+).
 *     Corre en el dispositivo, el texto no sale de él.
 *  2. El endpoint interno de Google Translate (`clients5.google.com`, el que usa
 *     la extensión de diccionario de Chrome). Responde con
 *     `access-control-allow-origin: *`, así que se puede llamar desde la página
 *     sin proxy; es lo que permite traducir en Brave, Firefox y Safari, donde el
 *     navegador no expone `Translator`. No es una API oficial: puede limitar o
 *     cortar el servicio sin avisar, y por eso el post se queda en su idioma si
 *     falla.
 */
import { getItem, setItem, waitForKeyReady } from './secureStorage';

// '' en el origen = detectar el idioma de cada post.
// '' en el destino = usar el idioma de la app (el que el usuario tiene puesto).
const SOURCE_KEY = 'fc_translate_source';
const TARGET_KEY = 'fc_translate_target';

// Por debajo de esto no merece la pena detectar: "ok", "🔥" o un enlace dan
// resultados ruidosos y gastan el modelo para nada.
export const MIN_TRANSLATE_LENGTH = 24;

const GOOGLE_ENDPOINT = 'https://clients5.google.com/translate_a/t';
const CACHE_LIMIT = 400;

let prefs = { source: '', target: '' };
let hydration = null;
const listeners = new Set();

function readPrefs() {
  try {
    return { source: getItem(SOURCE_KEY) || '', target: getItem(TARGET_KEY) || '' };
  } catch {
    return { source: '', target: '' };
  }
}

export function getTranslationPrefs() {
  return prefs;
}

export function subscribeTranslationPrefs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Relee las preferencias cuando la master key de secureStorage ya está lista
 * (en un arranque en frío la lectura síncrona devuelve null).
 */
export function ensureTranslationPrefs() {
  if (!hydration) {
    hydration = waitForKeyReady().then(() => {
      prefs = readPrefs();
      listeners.forEach((listener) => listener(prefs));
      return prefs;
    });
  }
  return hydration;
}

export function setTranslationPrefs(patch) {
  prefs = { ...prefs, ...patch };
  try {
    if (patch.source !== undefined) setItem(SOURCE_KEY, patch.source);
    if (patch.target !== undefined) setItem(TARGET_KEY, patch.target);
  } catch {
    // secureStorage no disponible (modo privado): la preferencia dura la sesión.
  }
  listeners.forEach((listener) => listener(prefs));
}

/** 'es-MX' → 'es': los modelos trabajan con el código base. */
export function baseLanguage(language) {
  return (language || '').toLowerCase().split('-')[0];
}

/** ¿El navegador trae traductor on-device? (Chrome/Edge 138+) */
export function hasLocalTranslator() {
  return (
    typeof window !== 'undefined' &&
    typeof window.Translator?.create === 'function' &&
    typeof window.LanguageDetector?.create === 'function'
  );
}

// Un único detector para todos los posts: crearlo descarga y carga el modelo.
let detectorPromise = null;

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = window.LanguageDetector.create().catch((err) => {
      detectorPromise = null;
      throw err;
    });
  }
  return detectorPromise;
}

/** Idioma detectado ('' si no hay confianza suficiente). */
export async function detectLanguage(text) {
  const detector = await getDetector();
  const results = await detector.detect(text);
  const best = results?.[0];
  if (!best || best.confidence < 0.5) return '';
  return baseLanguage(best.detectedLanguage);
}

// Un traductor por par de idiomas: cada uno es un modelo en memoria.
const translatorCache = new Map();

function getTranslator(sourceLanguage, targetLanguage) {
  const key = `${sourceLanguage}|${targetLanguage}`;
  if (!translatorCache.has(key)) {
    const promise = (async () => {
      const availability = await window.Translator.availability({
        sourceLanguage,
        targetLanguage,
      });
      if (availability === 'unavailable') return null;
      return window.Translator.create({ sourceLanguage, targetLanguage });
    })().catch((err) => {
      translatorCache.delete(key);
      throw err;
    });
    translatorCache.set(key, promise);
  }
  return translatorCache.get(key);
}

/**
 * Traduce `text` de `sourceLanguage` a `targetLanguage`.
 * Devuelve null si el navegador no puede con ese par de idiomas.
 */
async function translateLocal(text, sourceLanguage, targetLanguage) {
  const from = baseLanguage(sourceLanguage);
  const to = baseLanguage(targetLanguage);
  if (!from || !to || from === to) return null;
  const translator = await getTranslator(from, to);
  if (!translator) return null;
  return translator.translate(text);
}

// ── Motor de respaldo (Google) ──

// Caché por texto + destino: el feed remonta los posts al cambiar de pestaña y
// no queremos repetir la misma petición.
const cache = new Map();

// Una sola petición en vuelo: el feed lanza 20 posts a la vez y el endpoint no
// es una API oficial, así que no conviene ráfagarlo.
let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function parseGoogleResponse(data, source) {
  if (!Array.isArray(data) || data.length === 0) return null;
  // Con sl=auto la respuesta es [["texto", "es"]]; con sl fijo, ["texto"].
  if (Array.isArray(data[0])) {
    const [text, detected] = data[0];
    if (typeof text !== 'string') return null;
    return { text, from: baseLanguage(detected) || baseLanguage(source) };
  }
  if (typeof data[0] === 'string') {
    return { text: data[0], from: baseLanguage(source) };
  }
  return null;
}

async function translateWithGoogle(text, source, target) {
  const params = new URLSearchParams({
    client: 'dict-chrome-ex',
    sl: baseLanguage(source) || 'auto',
    tl: target,
    q: text,
  });
  const response = await fetch(`${GOOGLE_ENDPOINT}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;
  return parseGoogleResponse(await response.json(), source);
}

/**
 * Traduce el texto de un post al idioma de destino.
 * Devuelve `{ text, from }`, o null si ya está en ese idioma o no se pudo.
 */
export async function translatePostText(text, { source = '', target }) {
  const to = baseLanguage(target);
  if (!text || !to) return null;

  if (hasLocalTranslator()) {
    const from = baseLanguage(source) || (await detectLanguage(text));
    if (!from || from === to) return null;
    const translated = await translateLocal(text, from, to);
    return translated ? { text: translated, from } : null;
  }

  const cacheKey = `${to}|${source}|${text}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = await enqueue(() => translateWithGoogle(text, source, to));
  if (!result || result.from === to) return null;

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, result);
  return result;
}

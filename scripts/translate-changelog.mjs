/**
 * translate-changelog — traduce las entradas del changelog en BUILD TIME.
 *
 * ¿Por qué build time y no runtime?
 * - La CSP de producción bloquea connect-src a terceros (Google incluido):
 *   una traducción desde el navegador jamás pasaría sin abrir un agujero.
 * - Node no tiene CSP → el script habla con Google aquí, guarda el resultado
 *   en changelog.translations.json y la app lo lee del bundle (0 requests).
 * - Determinista y cacheado: solo se traducen releases nuevos o editados
 *   (fingerprint id:hash); lo demás se reutiliza del JSON.
 *
 * Uso:
 *   node scripts/translate-changelog.mjs     (o npm run translate-changelog)
 * Se ejecuta automáticamente antes de `vite build` vía prebuild.
 *
 * Si Google falla (red, bloqueo), la entrada queda en inglés en runtime —
 * el script NUNCA rompe el build.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RELEASES, getReleaseFingerprint } from '../src/assets/data/changelog.js';

const LOCALES = ['es', 'pt', 'ru', 'ja']; // 'en' es la fuente, no se traduce
const MAX_RELEASES = RELEASES.length; // todas: el modal permite navegar a cualquier release
const CACHE_PATH = fileURLToPath(
  new URL('../src/assets/data/changelog.translations.json', import.meta.url)
);
const ENDPOINT = 'https://clients5.google.com/translate_a/t';

async function googleTranslate(text, target) {
  const url =
    `${ENDPOINT}?client=dict-chrome-ex&sl=en&tl=${encodeURIComponent(target)}` +
    `&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // ["texto"] o segmentos anidados [["t","o"],...]
  if (!Array.isArray(data)) throw new Error('respuesta inesperada');
  return data.map((seg) => (Array.isArray(seg) ? seg[0] : seg) ?? '').join('');
}

// ── Caché previa ──
let cache = {};
try {
  cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
} catch {
  console.log('Sin caché previa — generando desde cero');
}

// Podar fingerprints de releases viejos
const validFps = new Set(
  RELEASES.slice(0, MAX_RELEASES).map((rel) => getReleaseFingerprint(rel))
);
for (const fp of Object.keys(cache)) {
  if (!validFps.has(fp)) delete cache[fp];
}

// ── Detectar qué falta (release nuevo O contenido editado) ──
const pending = [];
for (const rel of RELEASES.slice(0, MAX_RELEASES)) {
  const fp = getReleaseFingerprint(rel);
  cache[fp] ??= {};
  for (const loc of LOCALES) {
    const existing = cache[fp][loc];
    const complete =
      existing?.title &&
      Array.isArray(existing.items) &&
      existing.items.length === rel.items.length;
    if (!complete) pending.push({ rel, fp, loc });
  }
}

if (pending.length === 0) {
  console.log('✓ Changelog ya traducido a todos los idiomas');
} else {
  console.log(`${pending.length} traducción(es) pendientes…`);
}

// ── Traducir (secuencial por release + pausa cortesía anti rate-limit) ──
let okCount = 0;
for (const { rel, fp, loc } of pending) {
  try {
    const [title, ...items] = await Promise.all([
      googleTranslate(rel.title, loc),
      ...rel.items.map((item) => googleTranslate(item, loc)),
    ]);
    if (!title || items.some((it) => !it)) throw new Error('traducción vacía');
    cache[fp][loc] = { title, items };
    okCount++;
    console.log(`  ✓ ${rel.id} → ${loc}`);
  } catch (err) {
    console.warn(`  ✗ ${rel.id} → ${loc}: ${err.message} (quedará en inglés)`);
  }
  await new Promise((r) => setTimeout(r, 150));
}

writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
console.log(`✓ ${okCount}/${pending.length} traducciones guardadas en changelog.translations.json`);

import { useState } from 'react';
import ModalShell from './ModalShell';
import './css/changelogModal.css';
import { useI18n } from '../../services/i18n/useI18n';
import {
  RELEASES,
  getReleaseFingerprint,
  hasSeenRelease,
  markReleaseSeen,
} from '../../data/changelog';
import TRANSLATIONS from '../../data/changelog.translations.json';

/**
 * ChangelogModal — novedades por deploy.
 *
 * Formato idéntico al modal de editar perfil (fc-modal-header +
 * fc-modal-save / fc-modal-close).
 *
 * - SOLO producción: se abre si el fingerprint del último release
 *   ('id:hash-contenido') difiere del guardado en 'fc_changelog_seen'.
 *   Entrada nueva O entrada editada → vuelve a aparecer.
 * - La ✗ cierra SIN marcar como visto (reaparece al recargar).
 * - "Got it" marca como visto → no vuelve a mostrarse.
 * - El selector de versión permite leer releases anteriores sin salir del
 *   modal; "Got it" siempre marca como visto el último release.
 *   Para que las entradas antiguas también estén traducidas, el script de
 *   build traduce TODAS las releases (no solo las últimas N).
 * - Los entries se escriben SIEMPRE en inglés. Las traducciones se generan
 *   EN BUILD TIME (npm run translate-changelog, integrado al build) vía
 *   endpoint nativo de Google Translate y viajan dentro del bundle — la CSP
 *   de producción no permite conectarse a terceros desde el navegador.
 *   Si un idioma no está traducido aún, se muestra inglés (fallback).
 * - En desarrollo solo se abre con ?changelog en la URL.
 */

export default function ChangelogModal() {
  const { t, locale } = useI18n();
  const latest = RELEASES[0] || null;

  const [selectedId, setSelectedId] = useState(() => RELEASES[0]?.id ?? null);

  // Release que se está leyendo (puede ser una anterior elegida en el selector).
  const release = RELEASES.find((r) => r.id === selectedId) || latest;
  const releaseFingerprint = getReleaseFingerprint(release);

  const [open, setOpen] = useState(() => {
    if (!latest) return false;
    if (import.meta.env.DEV) {
      try {
        return new URLSearchParams(window.location.search).has('changelog');
      } catch {
        return false;
      }
    }
    // Helper valida id+contenido contra lo guardado: si difiere,
    // hasSeenRelease() devuelve false aunque haya un "visto" almacenado
    return !hasSeenRelease();
  });

  // Contenido mostrado: traducción de build-time si existe, si no inglés.
  // Derivación pura en render (sin estado ni efectos): el JSON viaja en el
  // bundle, no hay red involucrada.
  let display = null;
  if (release) {
    const tr = locale !== 'en' ? TRANSLATIONS[releaseFingerprint]?.[locale] : null;
    display =
      tr?.title && Array.isArray(tr.items)
        ? tr
        : { title: release.title, items: [...release.items] };
  }

  if (!open || !display) return null;

  const handleAccept = () => {
    markReleaseSeen();
    setOpen(false);
  };

  // La ✗ NO marca como visto: solo cierra esta sesión del popup
  const handleClose = () => setOpen(false);

  const formatReleaseDate = (date) => {
    try {
      return new Date(`${date}T12:00:00`).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    } catch {
      // fecha inválida → mostrar el raw
      return date;
    }
  };

  const dateStr = formatReleaseDate(release.date);

  // Etiqueta de cada opción: fecha + título (traducido si ya existe). Dos
  // releases pueden compartir fecha, así que el título desambigua.
  const releaseLabel = (entry) => {
    const tr = locale !== 'en' ? TRANSLATIONS[getReleaseFingerprint(entry)]?.[locale] : null;
    return `${formatReleaseDate(entry.date)} · ${tr?.title || entry.title}`;
  };

  return (
    <ModalShell
      isOpen={open}
      onClose={handleClose}
      onEscape={handleClose}
      disableBackdropClose={true}
      className="changelog-modal"
    >
      {/* ── Header bar: igual al modal de editar perfil ── */}
      <div className="fc-modal-header">
        <h3 className="fc-modal-title">
          {t('changelog.badge')}
          <span className="changelog-modal-date">{dateStr}</span>
        </h3>
        <div className="fc-modal-header-actions">
          <button className="fc-modal-save" onClick={handleAccept}>
            {t('changelog.accept')}
          </button>
          <button className="fc-modal-close" onClick={handleClose} aria-label={t('common.close')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="changelog-modal-inner">
        {RELEASES.length > 1 && (
          <div className="changelog-modal-release">
            <span className="changelog-modal-release-label">{t('changelog.release')}</span>
            <select
              className="changelog-modal-release-select"
              value={release.id}
              onChange={(e) => setSelectedId(e.target.value)}
              aria-label={t('changelog.release')}
            >
              {RELEASES.map((r) => (
                <option key={r.id} value={r.id}>
                  {releaseLabel(r)}
                </option>
              ))}
            </select>
          </div>
        )}
        <h2 className="changelog-modal-title">{display.title}</h2>
        <ul className="changelog-modal-list">
          {display.items.map((item, i) => (
            <li key={i} className="changelog-modal-item">
              {item}
            </li>
          ))}
        </ul>
      </div>
    </ModalShell>
  );
}

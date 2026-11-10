import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FaWindows,
  FaApple,
  FaLinux,
  FaDesktop,
  FaDownload,
  FaChevronDown,
  FaGlobe,
} from 'react-icons/fa';
import { useI18n } from '../services/i18n/useI18n';
import usePageTitle from '../../hooks/usePageTitle';
import {
  DESKTOP_PLATFORM_GROUPS,
  DESKTOP_RELEASE_URL,
  detectDesktopOS,
  getDownloadUrl,
} from '../data/desktopApp';
import '../Resources/Styles/download.css';

/**
 * Download — página propia de descargas de la app de escritorio.
 *
 * Destino del aviso que sale al reproducir en el navegador
 * (Components/DesktopAppPrompt.jsx) y de los enlaces compartidos fuera de la app.
 *
 * Detecta el sistema del visitante y enseña solo su botón de descarga. En macOS
 * y Linux (dos variantes cada uno) el botón abre un dropdown con ambas opciones.
 * Los archivos y su URL base viven en data/desktopApp.js.
 */

const OS_ICONS = {
  windows: FaWindows,
  macos: FaApple,
  linux: FaLinux,
};

const OS_ORDER = ['windows', 'macos', 'linux'];

const COMPARE_ROWS = [
  {
    id: 'audio',
    labelKey: 'download.compare_audio_label',
    webKey: 'download.compare_audio_web',
    desktopKey: 'download.compare_audio_desktop',
  },
  {
    id: 'auth',
    labelKey: 'download.compare_auth_label',
    webKey: 'download.compare_auth_web',
    desktopKey: 'download.compare_auth_desktop',
  },
  {
    id: 'account',
    labelKey: 'download.compare_account_label',
    webKey: 'download.compare_account_web',
    desktopKey: 'download.compare_account_desktop',
  },
];

export default function Download() {
  const { t } = useI18n();
  usePageTitle(t('download.title') || 'Foranly Desktop');

  const detectedOS = useMemo(() => detectDesktopOS(), []);
  const [os, setOs] = useState(detectedOS || 'windows');
  const [open, setOpen] = useState(false);
  const [macArch, setMacArch] = useState(null);
  const dropdownRef = useRef(null);

  // Etiquetas literales (no `t(\`download.os_${…}\`)`) para que
  // scripts/validate-locales.mjs las vea y no se queden sin traducir.
  const osLabels = {
    windows: t('download.os_windows') || 'Windows',
    macos: t('download.os_macos') || 'macOS',
    linux: t('download.os_linux') || 'Linux',
  };

  // Arquitectura del Mac para marcar la opción recomendada (Safari no la expone).
  useEffect(() => {
    if (os !== 'macos') return undefined;
    const uaData = navigator.userAgentData;
    if (!uaData?.getHighEntropyValues) return undefined;

    let active = true;
    uaData
      .getHighEntropyValues(['architecture'])
      .then((values) => {
        if (!active) return;
        setMacArch(values.architecture === 'x86' ? 'x64' : 'arm64');
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [os]);

  // Cerrar el dropdown al hacer clic fuera o con Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!dropdownRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const group =
    DESKTOP_PLATFORM_GROUPS.find((item) => item.os === os) || DESKTOP_PLATFORM_GROUPS[0];
  const options = group.options
    .map((option) => ({ ...option, url: getDownloadUrl(option) }))
    .filter((option) => option.url);
  const hasDropdown = options.length > 1;
  const primary = options[0] || null;
  const OsIcon = OS_ICONS[group.os] || FaDesktop;
  const downloadLabel = (osLabels[group.os] || group.os);

  const recommendedArch =
    group.os === 'macos' ? macArch : group.os === 'linux' ? 'AppImage' : null;

  return (
    <div className="download-page">
      <div className="download-header">
        <h1 className="download-title">{t('download.title')}</h1>
      </div>

      <p className="download-subtitle">{t('download.subtitle')}</p>

      {/* ── Sistema no reconocido: elegir plataforma ── */}
      {!detectedOS && (
        <div className="download-os-switch" role="tablist" aria-label={t('download.pick_your_os')}>
          {OS_ORDER.map((key) => {
            const Icon = OS_ICONS[key];
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={os === key}
                className={`download-os-chip${os === key ? ' download-os-chip--active' : ''}`}
                onClick={() => {
                  setOs(key);
                  setOpen(false);
                }}
              >
                <Icon />
                {osLabels[key]}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Descarga principal ── */}
      <section className="download-primary-card">
        <span className="download-primary-icon">
          <OsIcon />
        </span>

        <div className="download-primary-body">
          <span className="download-primary-kicker">{t('download.for_your_system')}</span>
          <h2 className="download-primary-title">{osLabels[group.os] || group.os}</h2>
          <span className="download-primary-file">
            {primary ? primary.file : t('download.note_unpublished')}
          </span>
        </div>

        <div className="download-download-wrap" ref={dropdownRef}>
          {hasDropdown ? (
            <>
              <button
                type="button"
                className="download-primary-btn"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
              >
                <FaDownload />
                <span>{t('download.download_for_os').replace('{os}', downloadLabel)}</span>
                <FaChevronDown
                  className={`download-primary-chevron${open ? ' download-primary-chevron--open' : ''}`}
                />
              </button>

              {open && (
                <div className="download-dropdown" role="menu">
                  {options.map((option) => (
                    <a
                      key={option.id}
                      className="download-dropdown-item"
                      href={option.url || DESKTOP_RELEASE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      role="menuitem"
                      onClick={() => setOpen(false)}
                    >
                      <span className="download-dropdown-info">
                        <span className="download-dropdown-name">
                          {option.arch}
                          {recommendedArch === option.arch && (
                            <span className="download-recommended">
                              {t('download.recommended')}
                            </span>
                          )}
                        </span>
                        <span className="download-dropdown-file">{option.file}</span>
                      </span>
                      <FaDownload className="download-dropdown-icon" aria-hidden="true" />
                    </a>
                  ))}
                </div>
              )}
            </>
          ) : primary ? (
            <a
              className="download-primary-btn"
              href={primary.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <FaDownload />
              <span>{t('download.download_for_os').replace('{os}', downloadLabel)}</span>
            </a>
          ) : (
            <span className="download-primary-btn download-primary-btn--soon">
              {t('download.soon')}
            </span>
          )}
        </div>
      </section>

      <p className="download-unsigned">{t('download.note')}</p>

      {/* ── Web vs. app de escritorio ── */}
      <section className="download-section">
        <h2 className="download-section-title">{t('download.compare_title')}</h2>

        <div className="download-compare">
          <article className="download-compare-card">
            <header className="download-compare-head">
              <span className="download-compare-icon">
                <FaGlobe />
              </span>
              <span className="download-compare-title">{t('download.compare_web')}</span>
            </header>
            <ul className="download-compare-list">
              {COMPARE_ROWS.map((row) => (
                <li key={row.id} className="download-compare-row">
                  <span className="download-compare-label">{t(row.labelKey)}</span>
                  <span className="download-compare-value">{t(row.webKey)}</span>
                </li>
              ))}
            </ul>
          </article>

          <article className="download-compare-card download-compare-card--desktop">
            <header className="download-compare-head">
              <span className="download-compare-icon download-compare-icon--accent">
                <FaDesktop />
              </span>
              <span className="download-compare-title">{t('download.compare_desktop')}</span>
            </header>
            <ul className="download-compare-list">
              {COMPARE_ROWS.map((row) => (
                <li key={row.id} className="download-compare-row">
                  <span className="download-compare-label">{t(row.labelKey)}</span>
                  <span className="download-compare-value download-compare-value--desktop">
                    {t(row.desktopKey)}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </section>
    </div>
  );
}

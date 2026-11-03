import React from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';

/**
 * GlobalProfileBg
 *
 * Muestra el fondo de perfil del usuario autenticado (profile_background_url)
 * a pantalla completa en TODAS las páginas del app, no solo en su perfil.
 *
 * Es una preferencia PERSONAL de sesión (localStorage vía useI18n.showGlobalBg,
 * key fc_show_global_bg): cada usuario decide si quiere ver su propio fondo
 * mientras navega; no afecta a otros.
 *
 * Implementación:
 *  - Se monta con createPortal directo a <body> para evitar que cualquier
 *    stacking context del árbol (AppLoader, etc.) afecte al z-index negativo.
 *  - Reutiliza las MISMAS CSS vars --profile-bg-* que .profile-page::before
 *    y las clases .app-global-bg / .app-global-bg-dim (global.css), por lo
 *    que el render es idéntico al del perfil (posición/zoom/blur/dim).
 *  - Se excluyen las rutas de perfil (/profile y /profile/:user): ahí ya se
 *    pinta el fondo del perfil correspondiente (propio o ajeno) y no debe
 *    duplicarse.
 *  - Se excluye también el detalle de comunidad (/c/:slug): usa su propio
 *    banner y el wallpaper detrás ensuciaba la página. El listado
 *    (/Communities) sí lo muestra.
 */
export default function GlobalProfileBg() {
  const location = useLocation();
  const path = location.pathname.toLowerCase();
  const { showGlobalBg } = useI18n();
  const { profile } = useAuth();

  // Preferencia desactivada → nada
  if (!showGlobalBg) return null;

  // Rutas de perfil: el fondo ya lo pinta la propia página
  if (path === '/profile' || path.startsWith('/profile/')) return null;

  // Detalle de comunidad: tiene su propio banner, el fondo global no debe verse
  if (path.startsWith('/c/')) return null;

  const bgUrl = profile?.profile_background_url;
  if (!bgUrl) return null;

  // Parsear posición/zoom (mismo formato y fallbacks que profile.jsx)
  let bgPos = 'center center';
  let bgSize = 'cover';
  try {
    const p = JSON.parse(profile.profile_background_position || '{}');
    bgPos = `${p.x ?? 50}% ${p.y ?? 50}%`;
    bgSize = `${Math.max(p.zoom ?? 1, 1.05) * 100}%`;
  } catch {}

  const bgBlur = profile.profile_background_blur ?? 0;
  const bgDim = (profile.profile_background_dim ?? 50) / 100;

  return createPortal(
    <>
      {/* Capa de imagen fija a pantalla completa (detrás de todo, z-index -2) */}
      <div
        className="app-global-bg"
        style={{
          '--profile-bg-image': `url(${bgUrl})`,
          '--profile-bg-position': bgPos,
          '--profile-bg-size': bgSize,
          '--profile-bg-blur': `${bgBlur}px`,
        }}
      />
      {/* Overlay de dim (entre el fondo y el contenido, z-index -1) */}
      <div
        className="app-global-bg-dim"
        style={{
          background: `linear-gradient(rgba(0,0,0,${bgDim}), rgba(0,0,0,${bgDim}))`,
        }}
      />
    </>,
    document.body
  );
}

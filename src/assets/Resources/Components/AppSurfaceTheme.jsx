import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import { getCachedProfileByUsername, getUserProfileByUsername } from '../../services/userService';

/**
 * AppSurfaceTheme
 *
 * Hace que el sidebar (Header) use el MISMO tratamiento de superficie que
 * las cards de perfil cuando el usuario tiene el modo translúcido/glass
 * activo (accent_surface_glass) o un color de superficie personalizado
 * (accent_surface_color).
 *
 * Las cards (RightPanel / ProfileSidebar) definen las vars --accent-surface-*
 * inline en sí mismas; el sidebar no tiene dónde ponerlas, así que este
 * componente las aplica directamente sobre el elemento `.sidebar` vía
 * useEffect (mismo patrón que las cards, sin duplicar lógica).
 *
 * Si el usuario NO tiene glass/color de superficie activo, se quitan las
 * vars y el sidebar usa su fallback CSS translúcido (color-mix + blur),
 * así el blur se mantiene siempre.
 *
 * Además publica en <html> la receta glass cuando el toggle "Tarjetas
 * transparentes" (showCardsGlass) está activo, para que html.fc-cards-glass
 * (global.css) pinte las cards del resto del app exactamente como las del
 * perfil en modo translúcido.
 */
const SURFACE_VARS = [
  '--accent-surface-rgba',
  '--accent-surface-rgba-hover',
  '--accent-surface-blur',
  '--accent-surface-border',
];

// Superficie base del sidebar (la de header.css): fondo del tema al 60% + blur.
// Se aplica inline cuando NO hay vidrio de perfil, para que el sidebar no
// herede las --accent-surface-* que se publican en <html> para las cards y se
// quede con el vidrio después de apagar el modo translúcido.
const SIDEBAR_THEME = {
  rgba: 'color-mix(in srgb, var(--color-bg, #000000) 60%, transparent)',
  hover: 'rgba(255, 255, 255, 0.06)',
  blur: 'blur(16px)',
};

export default function AppSurfaceTheme() {
  const { profile } = useAuth();
  const {
    showAccent,
    showCardsGlass,
    chatDefaultStyle,
    sidebarDefaultStyle,
    sidebarDefaultColors,
  } = useI18n();
  // Re-aplicar al navegar: si el nodo .sidebar se recreó (remount del Header),
  // las vars del glass se re-aplican al nodo nuevo (el efecto es barato).
  const location = useLocation();

  // Perfil que se está VIENDO: en /profile/:username puede no ser el propio.
  // El sidebar translúcido es una preferencia del dueño del perfil, así que al
  // visitar a otro usuario manda la suya (igual que las post-cards del perfil).
  const path = location.pathname.toLowerCase();
  const routeUsername = useMemo(() => {
    const m = path.match(/^\/profile\/([^/?#]+)/);
    if (!m) return '';
    try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
  }, [path]);
  const isOwnProfileRoute = Boolean(routeUsername)
    && routeUsername === String(profile?.username || '').toLowerCase();

  // Cache-first para no parpadear; el fetch real llega después.
  const [fetchedViewProfile, setFetchedViewProfile] = useState({ username: '', data: null });
  const cachedViewProfile = useMemo(
    () => (routeUsername && !isOwnProfileRoute ? getCachedProfileByUsername(routeUsername) : null),
    [routeUsername, isOwnProfileRoute]
  );
  const viewedProfile = routeUsername
    ? (isOwnProfileRoute
      ? profile
      : (fetchedViewProfile.username === routeUsername
        ? fetchedViewProfile.data
        : cachedViewProfile))
    : profile;

  useEffect(() => {
    if (!routeUsername || isOwnProfileRoute) return undefined;
    let alive = true;
    getUserProfileByUsername(routeUsername)
      .then((data) => {
        if (alive && data) setFetchedViewProfile({ username: routeUsername, data });
      })
      .catch(() => null);
    return () => { alive = false; };
  }, [routeUsername, isOwnProfileRoute]);

  useEffect(() => {
    const el = document.querySelector('.sidebar');
    const root = document.documentElement;
    // Ajuste "Chat con estilos por defecto": /chat ignora vidrio, superficie y
    // color de texto del perfil (mantiene el tema claro/oscuro). Se marca en
    // <html> para que global.css desactive también las reglas de cards.
    // Depende del toggle "Tarjetas transparentes": sin vidrio no hay nada que
    // desactivar en el chat, así que la opción queda inactiva.
    const chatDefault = chatDefaultStyle && showCardsGlass && path === '/chat';
    root.classList.toggle('fc-chat-default', chatDefault);
    // Sin sidebar todavía (primer render de App, login) se aplican igualmente
    // en <html>: salir aquí dejaba a las cards sin vars hasta navegar.
    const nodes = el ? [el, root] : [root];

    const surfColor = profile?.accent_surface_color;
    const profileGlass = profile?.accent_surface_glass === true;

    // Modo translúcido del perfil: se marca en <html> para que los elementos
    // que viven FUERA del árbol del perfil (el dock de chats flotantes se
    // monta en <body>) puedan usar el mismo vidrio que las cards del perfil.
    root.classList.toggle('fc-profile-glass', !chatDefault && showAccent && profileGlass);
    // El vidrio del perfil solo debe pintar lo que hay fuera del árbol del
    // perfil (p. ej. el dock) CUANDO se está viendo un perfil; en el resto de
    // rutas se queda con el tema del app.
    root.classList.toggle('fc-profile-route', path.startsWith('/profile'));

    // Receta del perfil en modo glass (== .profile-page .post-card)
    const GLASS = {
      rgba: 'rgba(255, 255, 255, 0.04)',
      hover: 'rgba(255, 255, 255, 0.07)',
      blur: 'blur(20px)',
    };
    // Superficie que define el perfil (glass o color custom + toggle de acentos)
    const accentSurface = showAccent && (profileGlass || surfColor);
    const profileVars = profileGlass
      ? GLASS
      : surfColor
        ? {
            rgba: surfColor,
            hover: `color-mix(in srgb, ${surfColor} 85%, #000)`,
            blur: 'none',
          }
        : null;

    // "Tarjetas transparentes" (Ajustes) fuerza la receta glass del perfil en
    // las cards de todo el app, sea cual sea el modo de superficie del perfil.
    // Se publica en <html> (las cards la heredan); el sidebar conserva su
    // propio tratamiento para no cambiar el look del shell.
    const rootVars = chatDefault
      ? null
      : showCardsGlass ? GLASS : (accentSurface ? profileVars : null);

    // Sidebar:
    //  - "estilos por defecto" → no recibe ninguna var (global.css neutraliza
    //    además las que hereda de <html>) y desactiva la opción de colores.
    //  - "colores por defecto" → conserva el vidrio del perfil pero ignora el
    //    color de superficie/acento.
    //  - si no, comportamiento normal (superficie del perfil o glass).
    // "Sidebar translúcido" (migración 103): el sidebar usa el vidrio del perfil
    // aunque el modo translúcido de las cards esté apagado. "Estilos por
    // defecto" del chat sigue mandando (neutraliza el vidrio del sidebar).
    // Solo en la ruta de perfil: el resto del tema del app no cambia (el
    // sidebar vuelve a su superficie normal al salir de /profile).
    const sidebarGlassPref = path.startsWith('/profile')
      && !chatDefault
      && !sidebarDefaultStyle
      && viewedProfile?.sidebar_glass === true;
    // Marca en <html>: header.css la usa para que el vidrio gane a
    // `.sidebar--solid` (fondo global apagado), que si no pinta negro plano
    // y deja el toggle sin efecto.
    root.classList.toggle('fc-sidebar-glass', sidebarGlassPref);
    const sidebarVars = chatDefault || sidebarDefaultStyle
      ? null
      : sidebarGlassPref
        ? GLASS
        : sidebarDefaultColors
          ? (showAccent && profileGlass ? GLASS : null)
          : (accentSurface ? profileVars : null);

    // El sidebar con estilos por defecto tampoco hereda las vars publicadas en
    // <html> por "Tarjetas transparentes" (ver html.fc-sidebar-default).
    root.classList.toggle('fc-sidebar-default', sidebarDefaultStyle);

    const applyVars = (node, vars) => {
      node.style.setProperty('--accent-surface-rgba', vars.rgba);
      node.style.setProperty('--accent-surface-rgba-hover', vars.hover);
      node.style.setProperty('--accent-surface-blur', vars.blur);
      node.style.setProperty('--accent-surface-border', 'none');
    };
    const clearVars = (node) => {
      SURFACE_VARS.forEach((v) => node.style.removeProperty(v));
    };

    // Sin vars → el fallback CSS (color de superficie del tema) aplica.
    if (rootVars) applyVars(root, rootVars); else clearVars(root);
    if (el) {
      if (sidebarVars) {
        applyVars(el, sidebarVars);
      } else if (sidebarDefaultStyle || chatDefault) {
        // Esas dos opciones pintan el sidebar por CSS; no debe heredar nada.
        clearVars(el);
      } else {
        // Fondo normal del tema: se fija inline para que no herede el vidrio
        // que "Tarjetas transparentes" o la superficie del perfil publican en
        // <html> (si no, apagar el modo translúcido no lo devolvía a la normalidad).
        applyVars(el, SIDEBAR_THEME);
      }
    }

    // Color de texto de las cards: el mismo que el dueño eligió para su perfil
    // (profile_text_color, en el modal de edición). Si está en "Automático"
    // (sin valor) no se marca la clase y las cards usan el texto del tema,
    // igual que el perfil.
    const textColor = chatDefault ? null : (profile?.profile_text_color || null);
    if (textColor) {
      root.style.setProperty('--fc-cards-text', textColor);
      root.classList.add('fc-cards-text');
    } else {
      root.style.removeProperty('--fc-cards-text');
      root.classList.remove('fc-cards-text');
    }

    // Iconos del sidebar: se pintan con ese mismo color en todas las rutas,
    // salvo en las pantallas donde manda el color de otra cosa (perfil que se
    // está viendo y detalle de comunidad).
    // El sidebar con estilos por defecto también deja iconos y logo con el
    // color del tema (sin afectar al resto de cards, que conservan el suyo).
    // Igual con "colores por defecto": si el sidebar ignora el acento y la
    // superficie del perfil, tampoco debe heredar su color de texto — si no,
    // los iconos quedan con un color que no contrasta con el fondo del tema.
    const sidebarTextAllowed = Boolean(textColor)
      && !sidebarDefaultStyle
      && !sidebarDefaultColors
      && !path.startsWith('/profile')
      && !path.startsWith('/c/');
    root.classList.toggle('fc-sidebar-text', sidebarTextAllowed);

    return () => {
      nodes.forEach(clearVars);
      root.style.removeProperty('--fc-cards-text');
      root.classList.remove('fc-cards-text');
      root.classList.remove('fc-sidebar-text');
      root.classList.remove('fc-chat-default');
      root.classList.remove('fc-sidebar-default');
      root.classList.remove('fc-profile-glass');
      root.classList.remove('fc-profile-route');
      root.classList.remove('fc-sidebar-glass');
    };
  }, [profile, viewedProfile, showAccent, showCardsGlass, chatDefaultStyle, sidebarDefaultStyle, sidebarDefaultColors, path]);

  return null;
}

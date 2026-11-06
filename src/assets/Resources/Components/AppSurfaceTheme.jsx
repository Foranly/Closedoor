import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';

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

  useEffect(() => {
    const el = document.querySelector('.sidebar');
    const root = document.documentElement;
    // Ajuste "Chat con estilos por defecto": /chat ignora vidrio, superficie y
    // color de texto del perfil (mantiene el tema claro/oscuro). Se marca en
    // <html> para que global.css desactive también las reglas de cards.
    const path = location.pathname.toLowerCase();
    // Depende del toggle "Tarjetas transparentes": sin vidrio no hay nada que
    // desactivar en el chat, así que la opción queda inactiva.
    const chatDefault = chatDefaultStyle && showCardsGlass && path === '/chat';
    root.classList.toggle('fc-chat-default', chatDefault);
    // Sin sidebar todavía (primer render de App, login) se aplican igualmente
    // en <html>: salir aquí dejaba a las cards sin vars hasta navegar.
    const nodes = el ? [el, root] : [root];

    const surfColor = profile?.accent_surface_color;
    const profileGlass = profile?.accent_surface_glass === true;

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
    const sidebarVars = chatDefault || sidebarDefaultStyle
      ? null
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
      if (sidebarVars) applyVars(el, sidebarVars); else clearVars(el);
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
    };
  }, [profile, showAccent, showCardsGlass, chatDefaultStyle, sidebarDefaultStyle, sidebarDefaultColors, location.pathname]);

  return null;
}

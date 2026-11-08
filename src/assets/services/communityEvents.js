/**
 * communityEvents.js — eventos puntuales de la UI de comunidades.
 *
 * El panel derecho (CommunitySidebar) y la página (CommunityPage) son
 * componentes hermanos: la página es quien tiene la lista de miembros y el
 * estado del diálogo, y el sidebar solo muestra una preview. Para que pulsar esa
 * preview abra el diálogo se manda un CustomEvent por `window`, el mismo patrón
 * que ya usan deployWatcher.js y desktopApp.js.
 */

export const COMMUNITY_MEMBERS_EVENT = 'fc:community-members';

/**
 * Pide abrir el diálogo de miembros de una comunidad (lo escucha CommunityPage).
 *
 * @param {string} slug - slug de la comunidad, para que solo responda su página.
 */
export function requestMembersDialog(slug) {
  if (!slug) return;
  try {
    window.dispatchEvent(new CustomEvent(COMMUNITY_MEMBERS_EVENT, { detail: { slug } }));
  } catch {
    /* CustomEvent no disponible: se ignora */
  }
}

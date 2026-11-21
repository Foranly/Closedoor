import { useI18n } from '../../services/i18n/useI18n';
import EmojiText from './EmojiText';
import SafeImage from './SafeImage';

/**
 * ChatCommunityCard — invitación a una comunidad compartida en un mensaje.
 *
 * La usan tanto el chat completo (Chat.jsx) como la ventana flotante
 * (FloatingChat.jsx), para que una invitación no aparezca como una burbuja
 * vacía en ninguna de las dos. Extraída del JSX inline que vivía en Chat.jsx
 * sin cambios de diseño.
 *
 * Props:
 *  - community: fila de `communities` (null mientras se carga → esqueleto)
 *  - inviteToken: `messages.shared_invite_token`; viaja en la URL para que el
 *    receptor pueda unirse con la invitación
 *  - isOwn: true si el mensaje es tuyo (botón deshabilitado, no te unes a tu
 *    propia comunidad desde el chat)
 */
export default function ChatCommunityCard({ community, inviteToken = null, isOwn = false }) {
  const { t } = useI18n();

  if (!community) {
    return (
      <div className="chat-message-shared-community chat-message-shared-community--loading">
        <div className="chat-message-shared-post-spinner" />
        <span>{t('common.loading')}</span>
      </div>
    );
  }

  // El token viaja en el mensaje → el receptor canjea al unirse
  const inviteQs = inviteToken ? `?invite=${inviteToken}` : '';

  return (
    <div className="chat-message-shared-community">
      {/* Banner: imagen real o gradiente con el acento de la comunidad (igual que CommunityPage) */}
      <div className="chat-community-card-banner">
        {community.banner_url ? (
          <img src={community.banner_url} alt="" />
        ) : (
          <div
            className="chat-community-card-banner-fallback"
            style={community.accent_color ? { background: `linear-gradient(135deg, ${community.accent_color}, ${community.accent_color_secondary || community.accent_color})` } : undefined}
          />
        )}
        <div className="chat-community-card-banner-overlay" />
      </div>
      <div className="chat-community-card-body">
        <div className="chat-community-card-header">
          {community.avatar_url ? (
            <SafeImage className="chat-community-card-avatar" src={community.avatar_url} alt={community.name} />
          ) : (
            <div className="chat-community-card-avatar chat-community-card-avatar--letter">
              {community.name?.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="chat-community-card-info">
            <span className="chat-community-card-name"><EmojiText text={community.name} /></span>
            <span className="chat-community-card-slug">c/{community.slug}</span>
          </div>
        </div>
        {/* Bloque de 2 líneas fijo (clamp en CSS) para que todas las tarjetas midan igual */}
        <p className="chat-community-card-desc"><EmojiText text={community.description || ''} /></p>
        <div className="chat-community-card-stats">
          <span>{community.member_count || 0} {t('comunidades.members')}</span>
          <span>{community.post_count || 0} {t('comunidades.posts')}</span>
        </div>
        {isOwn ? (
          <span className="chat-community-card-btn chat-community-card-btn--disabled" aria-disabled="true">
            {t('comunidades.join_btn')}
          </span>
        ) : (
          <a
            href={`/c/${community.slug}${inviteQs}`}
            className="chat-community-card-btn"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `/c/${community.slug}${inviteQs}`; }}
          >
            {t('comunidades.join_btn')}
          </a>
        )}
      </div>
    </div>
  );
}

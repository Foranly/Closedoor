import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { FaLock } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { getImageStyle } from '../../services/helpers';
import Avatar from './Avatar';
import EmojiText from './EmojiText';
import Badge from './Badge';
import SafeImage from './SafeImage';
import FollowButton from './FollowButton';
// La card se usa en la página de Explore y también fuera de ella (la cuenta del
// pie del chat abre la tuya en un modal), así que los estilos viajan con ella.
import '../Styles/explore.css';

/**
 * ExploreCard — tarjeta de perfil del grid de Explore.
 *
 * Extraída de Pages/Explore.jsx para poder reutilizarla sin arrastrar la página
 * entera (lazy) al bundle del chat. Toda la card navega al perfil; el área del
 * FollowButton se excluye del click para no seguir sin querer.
 *
 * @param {object} props
 * @param {object} props.profile - Fila del perfil (username, banner_url, interests…).
 * @param {{followers: number}} [props.counts] - Contadores frescos de follows.
 * @param {boolean} [props.isOwnProfile] - Oculta el botón de seguir en tu propia card.
 * @param {boolean} [props.showAccent] - Aplica el color de acento del perfil.
 * @param {Function} [props.getDisplayName] - Resuelve el nombre mostrado (nicknames).
 */
export default function ExploreCard({ profile, counts, isOwnProfile, showAccent, getDisplayName }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const bio = profile.bio || "";
  const followers = counts?.followers ?? 0;
  const roles = profile.roles || ["user"];
  const hasAccent = showAccent && profile.accent_color;
  const cardStyle = hasAccent
    ? {
        '--accent-color': profile.accent_color,
        '--accent-color-2': profile.accent_color_secondary || profile.accent_color,
      }
    : {};

  const handleCardClick = useCallback((e) => {
    // Dont navigate if clicking inside the FollowButton area
    if (e.target.closest('.explore-card-action')) return;
    navigate(`/profile/${profile.username}`);
  }, [navigate, profile.username]);

  return (
    <div className={`explore-card${hasAccent ? ' explore-card--accent' : ''}`} style={cardStyle} onClick={handleCardClick}>
      <div className="explore-card-banner">
        {profile.banner_url && (
          <SafeImage
            className="explore-card-banner-img"
            src={profile.banner_url}
            alt=""
            style={getImageStyle(profile.banner_position)}
          />
        )}
        <div className="explore-card-overlay" />
      </div>

      <div className="explore-card-body">
        <Avatar
          className="explore-card-avatar"
          src={profile.avatar_url}
          alt={profile.username}
          frame={profile.avatar_frame_url}
          framePosition={profile.avatar_frame_position}
          style={getImageStyle(profile.avatar_position)}
        />

        <div className="explore-card-info">
          <div className="explore-card-name-row">
            <span className="explore-card-name"><EmojiText text={getDisplayName ? getDisplayName(profile) : (profile.displayname || profile.username)} /></span>
            <span style={{ fontSize: '0.68rem', fontWeight: 400, opacity: 0.5, color: 'white' }}> · @{profile.username}</span>
            {profile.is_private === true && (
              <span className="explore-card-private-icon" title={t('profile.private_profile')}>
                <FaLock />
              </span>
            )}
            <Badge roles={roles} />
          </div>

          <span className="explore-card-followers">
            {followers} {followers === 1 ? t('explore.followers_singular') : t('explore.followers_plural')}
          </span>                          {bio || profile.pronouns ? (
                            <p className="explore-card-bio">
                              <EmojiText text={bio} />
                              {bio && profile.pronouns && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.5 }}> · <EmojiText text={profile.pronouns} /></span>}
                              {!bio && profile.pronouns && <span style={{ fontSize: '0.7rem', fontWeight: 400, opacity: 0.5 }}><EmojiText text={profile.pronouns} /></span>}
                            </p>
                          ) : null}

          {/* ── Interests (max 3, then "see more" → profile) ── */}
          {profile.interests?.length > 0 && (
            <div className="explore-card-interests">
              {profile.interests.slice(0, 3).map((interest, i) => (
                <span key={interest} className="explore-card-interest">{interest}</span>
              ))}
              {profile.interests.length > 3 && (
                <button
                  type="button"
                  className="explore-card-interests-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/profile/${profile.username}`);
                  }}
                >
                  {t('profile.show_more', { count: profile.interests.length - 3 })}
                </button>
              )}
            </div>
          )}
        </div>

        {!isOwnProfile && (
          <div className="explore-card-action">
            <FollowButton targetUserId={profile.id} />
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FaLock } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import '../Styles/explore.css';
import './css/communityCard.css';

const gradientFor = (c) =>
  `linear-gradient(135deg, ${c.accent_color || '#333'}, ${c.accent_color_secondary || c.accent_color || '#222'})`;

/**
 * CommunityCard — card de comunidad del grid.
 * La usan la página de comunidades y la pestaña "Comunidades" del perfil.
 */
export default function CommunityCard({ community: c }) {
  const { t } = useI18n();
  const [bannerBroken, setBannerBroken] = useState(false);

  const accentStyle = c.accent_color
    ? {
        '--accent-color': c.accent_color,
        '--accent-color-2': c.accent_color_secondary || c.accent_color,
      }
    : {};

  return (
    <Link
      to={`/c/${c.slug}`}
      className={`explore-card${c.accent_color ? ' explore-card--accent' : ''}`}
      style={accentStyle}
    >
      <div className="explore-card-banner">
        {c.banner_url && !bannerBroken ? (
          <img
            className="explore-card-banner-img"
            src={c.banner_url}
            alt=""
            onError={() => setBannerBroken(true)}
          />
        ) : (
          <div
            className="comunidades-card-banner-fallback"
            style={{ background: gradientFor(c) }}
          />
        )}
        <div className="explore-card-overlay" />
      </div>

      <div className="explore-card-body">
        {c.avatar_url ? (
          <img className="explore-card-avatar" src={c.avatar_url} alt={c.name} />
        ) : (
          <div
            className="explore-card-avatar comunidades-card-avatar-letter"
            style={{ background: gradientFor(c) }}
          >
            {c.name.charAt(0).toUpperCase()}
          </div>
        )}

        <div className="explore-card-info">
          <div className="explore-card-name-row">
            <span className="explore-card-name">{c.name}</span>
            <span className="comunidades-card-slug">c/{c.slug}</span>
            {c.is_private && (
              <span className="explore-card-private-icon" title={t('comunidades.private')}>
                <FaLock />
              </span>
            )}
            {c.is_mature && (
              <span className="comunidades-card-mature" title={t('comunidades.mature')}>
                +18
              </span>
            )}
          </div>

          <span className="explore-card-followers">
            {c.member_count || 0} {t('comunidades.members')} · {c.post_count || 0} {t('comunidades.posts')}
          </span>

          {c.description && <p className="explore-card-bio">{c.description}</p>}

          {c.interests?.length > 0 && (
            <div className="explore-card-interests">
              {c.interests.slice(0, 3).map((interest) => (
                <span key={interest} className="explore-card-interest">{interest}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

import { useEffect, useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { useI18n } from '../../services/i18n/useI18n';
import { getUserCommunities } from '../../services/communityService';
import CommunityCard from './CommunityCard';

/**
 * ProfileCommunities — pestaña "Comunidades" del perfil: las comunidades
 * activas a las que pertenece el usuario. Quién puede verla ya lo decide
 * `canViewProfileCommunities` en la página de perfil.
 */
export default function ProfileCommunities({ userId, isOwnProfile }) {
  const { t } = useI18n();
  const [communities, setCommunities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    getUserCommunities(userId)
      .then((list) => {
        if (alive) setCommunities(list);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  if (loading) {
    return (
      <div className="posts-skeleton">
        {[1, 2, 3].map((i) => (
          <div key={i} className="posts-skeleton-card">
            <div className="skeleton posts-skeleton-avatar" />
            <div className="posts-skeleton-lines">
              <div className="skeleton posts-skeleton-line posts-skeleton-line--short" />
              <div className="skeleton posts-skeleton-line" />
              <div className="skeleton posts-skeleton-line posts-skeleton-line--medium" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (communities.length === 0) {
    return (
      <div className="posts-empty">
        <span className="posts-empty-icon"><FaUsers /></span>
        <p className="posts-empty-text">
          {isOwnProfile
            ? t('profile.no_communities_own')
            : t('profile.no_communities_other')}
        </p>
        <p className="posts-empty-subtext">
          {isOwnProfile
            ? t('profile.no_communities_sub')
            : t('profile.no_communities_sub_other')}
        </p>
      </div>
    );
  }

  return (
    <div className="explore-grid profile-communities-grid">
      {communities.map((community) => (
        <CommunityCard key={community.id} community={community} />
      ))}
    </div>
  );
}

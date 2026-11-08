import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useI18n } from '../../services/i18n/useI18n';
import {
  getCachedCommunity,
  getCachedCommunityMembers,
  getCachedCommunityRanking,
  getCommunity,
  getCommunityMembers,
  getActiveMembersRanking,
} from '../../services/communityService';
import { supabase } from '../../services/supabaseclient';
import { requestMembersDialog } from '../../services/communityEvents';
import Avatar from './Avatar';
import { FaUsers, FaTrophy, FaShieldAlt } from 'react-icons/fa';
import './css/profileSidebar.css';

function extractSlug(pathname) {
  const match = pathname.match(/^\/c\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function CommunitySidebar() {
  const location = useLocation();
  const slug = useMemo(() => extractSlug(location.pathname), [location.pathname]);
  const { t } = useI18n();

  const [community, setCommunity] = useState(() => slug ? getCachedCommunity(slug) : null);
  const [members, setMembers] = useState(() => {
    if (!slug) return [];
    const c = getCachedCommunity(slug);
    return c ? getCachedCommunityMembers(c.id) || [] : [];
  });
  const [ranking, setRanking] = useState(() => {
    if (!slug) return [];
    const c = getCachedCommunity(slug);
    return c ? getCachedCommunityRanking(c.id) || [] : [];
  });
  const [loading, setLoading] = useState(() => slug ? !getCachedCommunity(slug) : false);

  const fetchData = useCallback(async () => {
    if (!slug) return;
    try {
      const c = await getCommunity(slug, { refresh: true });
      if (!c) return;
      setCommunity(c);

      const [membersRes, rankingRes] = await Promise.all([
        getCommunityMembers(c.id, { refresh: true }).catch(() => []),
        getActiveMembersRanking(c.id, { refresh: true }).catch(() => []),
      ]);
      setMembers(membersRes);
      setRanking(rankingRes);
    } catch (err) {
      console.error('[CommunitySidebar] Error:', err);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    // Reset state when slug changes
    if (slug) {
      const cached = getCachedCommunity(slug);
      setCommunity(cached);
      setMembers(cached ? getCachedCommunityMembers(cached.id) || [] : []);
      setRanking(cached ? getCachedCommunityRanking(cached.id) || [] : []);
      setLoading(!cached);
    } else {
      setCommunity(null);
      setMembers([]);
      setRanking([]);
      setLoading(false);
    }
    fetchData();
  }, [slug, fetchData]);

  // ── Live: el sidebar se quedaba con la comunidad del montaje ──
  // Al guardar los ajustes (nombre, reglas, privacidad…) la página actualiza su
  // propio estado, pero este panel es otro componente y no se enteraba hasta
  // recargar. `communities` está en la publicación supabase_realtime (058), así
  // que se escucha la fila y se mezcla lo que cambie; también cubre ediciones
  // hechas desde otro cliente.
  useEffect(() => {
    const id = community?.id;
    if (!id) return undefined;

    const channel = supabase
      .channel(`community-sidebar-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'communities', filter: `id=eq.${id}` }, (payload) => {
        const updated = payload.new;
        if (!updated?.id) return;
        setCommunity((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [community?.id]);

  if (!slug) return null;

  if (loading && !community) {
    return (
      <>
        <div className="right-panel-card">
          <div className="skeleton right-panel-skeleton-title" />
          <div className="skeleton right-panel-skeleton-pill" style={{ width: '70%' }} />
          <div className="skeleton right-panel-skeleton-pill" style={{ width: '50%' }} />
        </div>
      </>
    );
  }

  if (!community) return null;

  const hasRanking = ranking.length > 0;
  const hasRules = community.rules?.length > 0;
  const hasMembers = members.length > 0;

  if (!hasRanking && !hasRules && !hasMembers) return null;

  return (
    <>
      {/* ── Most Active ── */}
      {hasRanking && (
        <div className="profile-sidebar-card">
          <div className="profile-sidebar-title">
            <FaTrophy className="profile-sidebar-title-icon" />
            {t('comunidades.most_active')}
          </div>
          <div className="community-ranking">
            {ranking.map((r, idx) => (
              <Link
                key={r.user_id}
                to={`/profile/${r.profile?.username}`}
                className="community-ranking-item"
              >
                <span className={`community-ranking-pos ${idx < 3 ? `community-ranking-pos--${idx + 1}` : ''}`}>{idx + 1}</span>
                <Avatar className="community-ranking-avatar" src={r.profile?.avatar_url} alt={r.profile?.username} />
                <span className="community-ranking-name">@{r.profile?.username || '…'}</span>
                <span className="community-ranking-score">{r.score}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Rules ── */}
      {hasRules && (
        <div className="profile-sidebar-card">
          <div className="profile-sidebar-title">
            <FaShieldAlt className="profile-sidebar-title-icon" />
            {t('comunidades.rules')}
          </div>
          <ol className="community-rules-list">
            {community.rules.map((rule, i) => (
              <li key={i} className="community-rule-item">{rule}</li>
            ))}
          </ol>
        </div>
      )}

      {/* ── Members ──
          Pulsar la card abre el diálogo de miembros de la página (que es quien
          tiene la lista completa y los filtros). Los avatares siguen siendo
          enlaces al perfil, así que se ignora el clic sobre ellos. ── */}
      {hasMembers && (
        <div
          className="profile-sidebar-card community-members-card"
          role="button"
          tabIndex={0}
          title={t('comunidades.members')}
          onClick={(e) => {
            if (e.target.closest('a')) return;
            requestMembersDialog(slug);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              requestMembersDialog(slug);
            }
          }}
        >
          <div className="profile-sidebar-title">
            <FaUsers className="profile-sidebar-title-icon" />
            {t('comunidades.members')}
          </div>
          <div className="community-members-preview">
            {members.slice(0, 12).map((m) => (
              <Link key={m.user_id} to={`/profile/${m.profiles?.username}`} title={`@${m.profiles?.username || ''}`}>
                <Avatar className="community-members-preview-avatar" src={m.profiles?.avatar_url} alt={m.profiles?.username} />
              </Link>
            ))}
            {members.length > 12 && (
              <span className="community-members-more">+{members.length - 12}</span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

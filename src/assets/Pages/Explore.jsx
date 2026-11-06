import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { useI18n } from "../services/i18n/useI18n";
import usePageTitle from "../../hooks/usePageTitle";
import { supabase, dbPublic } from "../services/supabaseclient";
import { listProfiles } from "../services/userService";
import { getFollowCounts,
  setCachedFollowStatus,
  getCachedExploreData,
  setCachedExploreData,
} from "../services/followService";
import ExploreCard from "../Resources/Components/ExploreCard";
import Avatar from "../Resources/Components/Avatar";
import { getBlockedUserIds, getUsersWhoBlockedMeIds, clearBlockedListsCache, subscribeBlockChanges } from "../services/blockService";
import { getNicknames, getCachedNicknames, cacheNicknames } from "../services/chatService";
import { countInterestOverlap } from "../services/interestDictionary";
import "../Resources/Styles/explore.css";
import "../Resources/Styles/skeleton.css";

function Explore() {
  const { t, showAccent } = useI18n();
  usePageTitle(t('explore.title'));
  const { user, profile, loading: authLoading } = useAuth();

  // ── Constants ──
  const PAGE_SIZE = 8;
  const MAX_VISIBLE = 100;
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  // ── Search & Filters ──
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('relevance');
  const [page, setPage] = useState(1);
  const searchTimeoutRef = useRef(null);

  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!searchQuery) {
      setDebouncedQuery('');
      return;
    }
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 200);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchQuery]);

  // Lazy initializers: leen cache sincrónicamente durante el 1er render
  // Si hay cache, loading arranca en false y el skeleton nunca se muestra.
  // Si user?.id es undefined (auth cargando), la key será 'anon' → cache miss → skeleton.
  const [profiles, setProfiles] = useState(() => {
    const cached = getCachedExploreData(user?.id);
    return cached?.profiles || [];
  });
  const [countsMap, setCountsMap] = useState(() => {
    const cached = getCachedExploreData(user?.id);
    return cached?.counts || {};
  });
  const [likesMap, setLikesMap] = useState(() => {
    const cached = getCachedExploreData(user?.id);
    return cached?.likes || {};
  });
  const [loading, setLoading] = useState(() => {
    const cached = getCachedExploreData(user?.id);
    return !cached;
  });

  // ── Re-filtrar profiles cuando cambia el estado de bloqueo ──
  useEffect(() => {
    if (!user?.id) return;        const unsub = subscribeBlockChanges(async () => {
      try {
        // Limpiar cache para forzar fetch fresco (el cache es para navegacion, no para Realtime)
        clearBlockedListsCache(user.id);
        const [blockedIds, blockedMeIds] = await Promise.all([
          getBlockedUserIds(user.id),
          getUsersWhoBlockedMeIds(user.id),
        ]);
        const excludedIds = new Set([...blockedIds, ...blockedMeIds]);
        setProfiles((prev) => prev.filter(p => !excludedIds.has(p.id)));
      } catch (e) {
        console.warn('Could not re-filter blocked profiles:', e);
      }
    });
    return unsub;
  }, [user?.id]);

  // ── Fetch initial data (profiles + counts + follow statuses) ──
  useEffect(() => {
    if (authLoading) return;

    const fetchAll = async () => {
      const cached = getCachedExploreData(user?.id);
      if (!cached || (cached._fetchedAt && Date.now() - cached._fetchedAt > CACHE_TTL_MS)) {
        setLoading(true);
      }

      try {
        let data = await listProfiles(user?.id);

        // Filtrar usuarios bloqueados (ambas direcciones, con cache 5min)
        if (user?.id) {
          try {
            const [blockedIds, blockedMeIds] = await Promise.all([
              getBlockedUserIds(user.id),
              getUsersWhoBlockedMeIds(user.id),
            ]);
            const excludedIds = new Set([...blockedIds, ...blockedMeIds]);
            data = data.filter(p => !excludedIds.has(p.id));
          } catch (e) {
            console.warn('Could not filter blocked users:', e);
          }
        }

        // Fetch follow counts + follow statuses en paralelo
        const [countsResults, , likesResults] = await Promise.all([
          Promise.allSettled(data.map((p) => getFollowCounts(p.id))),
          user?.id
            ? Promise.allSettled(
                data.map((p) =>
                  supabase
                    .from('follows')
                    .select('follower_id')
                    .eq('follower_id', user.id)
                    .eq('following_id', p.id)
                    .eq('status', 'accepted')
                    .maybeSingle()
                    .then(({ data: d }) => {
                      const status = !!d;
                      setCachedFollowStatus(user.id, p.id, status);
                    })
                )
              )
            : Promise.resolve([]),
          // Aggregate total likes per user
          dbPublic
            .from('posts')
            .select('user_id, likes_count')
            .neq('is_encrypted', true)
            .in('user_id', data.map((p) => p.id))
            .then(({ data: likesData }) => {
              const likes = {};
              (likesData || []).forEach((post) => {
                likes[post.user_id] = (likes[post.user_id] || 0) + (post.likes_count || 0);
              });
              return likes;
            }),
        ]);

        const counts = {};
        data.forEach((p, i) => {
          counts[p.id] =
            countsResults[i]?.status === "fulfilled"
              ? countsResults[i].value
              : { followers: 0, following: 0 };
        });

        setProfiles(data);
        setCountsMap(counts);
        setLikesMap(likesResults || {});
        setCachedExploreData(user?.id, { profiles: data, counts, likes: likesResults || {}, _fetchedAt: Date.now() });
      } catch (err) {
        console.warn("Error fetching profiles:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
  }, [user?.id, authLoading]);

  // ── Nicknames (cache-first) ──
  const [nicknames, setNicknames] = useState(() => {
    if (user?.id) {
      const cached = getCachedNicknames(user.id);
      if (cached) return cached;
    }
    return {};
  });
  useEffect(() => {
    if (!user?.id) return;
    getNicknames(user.id).then((map) => {
      setNicknames(map);
      cacheNicknames(user.id, map);
    }).catch(() => {});
  }, [user?.id]);

  const getDisplayName = useCallback((otherUser) => {
    if (!otherUser) return t('common.unknown');
    const nick = nicknames[otherUser.id];
    return nick || otherUser.displayname || otherUser.username || t('common.unknown');
  }, [nicknames, t]);

  // ── Ref para acceder a profiles desde Realtime sin stale closures ──
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  // ── Realtime: refrescar counts cuando el usuario sigue/deja de seguir ──
  useEffect(() => {
    if (!user?.id) return;

    const refreshCounts = async () => {
      const current = profilesRef.current;
      if (current.length === 0) return;

      const results = await Promise.allSettled(
        current.map((p) => getFollowCounts(p.id))
      );

      // Construir desde cero (evita stale closure de countsMap)
      const updated = {};
      current.forEach((p, i) => {
        updated[p.id] =
          results[i]?.status === "fulfilled"
            ? results[i].value
            : { followers: 0, following: 0 };
      });

      setCountsMap(updated);
      // También actualizar el cache para que al volver a Explore los datos estén frescos
      const existing = getCachedExploreData(user.id) || {};
      setCachedExploreData(user.id, { ...existing, profiles: current, counts: updated });
    };

    const channel = supabase
      .channel(`explore-counts-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'follows', filter: `follower_id=eq.${user.id}` },
        () => refreshCounts()
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'follows', filter: `follower_id=eq.${user.id}` },
        () => refreshCounts()
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'follows', filter: `following_id=eq.${user.id}` },
        () => refreshCounts()
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'follows', filter: `following_id=eq.${user.id}` },
        () => refreshCounts()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  // ── Compute sorted & filtered list ──
  const sortedProfiles = useMemo(() => {
    // First, filter by search query
    let filtered = debouncedQuery
      ? profiles.filter((p) =>
          p.username.toLowerCase().includes(debouncedQuery.toLowerCase())
        )
      : [...profiles];

    // Then, sort/filter based on active filter mode
    switch (activeFilter) {
      case 'relevance':
        // Sort by: 1) total likes 2) follower count 3) badge weight
        filtered.sort((a, b) => {
          const aLikes = likesMap?.[a.id] ?? 0;
          const bLikes = likesMap?.[b.id] ?? 0;
          if (bLikes !== aLikes) return bLikes - aLikes;
          const aFollowers = countsMap[a.id]?.followers ?? 0;
          const bFollowers = countsMap[b.id]?.followers ?? 0;
          if (bFollowers !== aFollowers) return bFollowers - aFollowers;
          const badgeWeight = (roles = []) => {
            if (roles.includes('admin')) return 3;
            if (roles.includes('moderator')) return 2;
            if (roles.includes('verified')) return 1;
            return 0;
          };
          return badgeWeight(b.roles) - badgeWeight(a.roles);
        });
        break;
      case 'newest':
        // Sort by created_at descending (already the default from API)
        filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        break;
      case 'interests':
        // Group users by: 1) matching interests (hierarchical) 2) has interests but no match 3) no interests
        if (profile?.interests?.length > 0) {
          const withMatch = [];
          const withInterestsNoMatch = [];
          const withoutInterests = [];
          filtered.forEach((p) => {
            if (p.interests?.length > 0) {
              const overlap = countInterestOverlap(profile.interests, p.interests);
              if (overlap > 0) {
                withMatch.push({ profile: p, overlap });
              } else {
                withInterestsNoMatch.push(p);
              }
            } else {
              withoutInterests.push(p);
            }
          });
          // Sort by overlap (descending), then alpha
          withMatch.sort((a, b) => b.overlap - a.overlap || a.profile.username.localeCompare(b.profile.username));
          filtered = [...withMatch.map((w) => w.profile), ...withInterestsNoMatch, ...withoutInterests];
        } else {
          // If current user has no interests, fall back to alphabetical
          filtered.sort((a, b) => a.username.localeCompare(b.username));
        }
        break;
      case 'name':
        filtered.sort((a, b) => a.username.localeCompare(b.username));
        break;
      default:
        break;
    }

    return filtered;
  }, [profiles, countsMap, likesMap, debouncedQuery, activeFilter, profile?.interests]);

  // ── Reset page when filters/search change ──
  useEffect(() => {
    setPage(1);
  }, [activeFilter, debouncedQuery]);

  // ── Cap at MAX_VISIBLE & slice current page ──
  const totalPages = React.useMemo(() => {
    const capped = Math.min(sortedProfiles.length, MAX_VISIBLE);
    return Math.max(1, Math.ceil(capped / PAGE_SIZE));
  }, [sortedProfiles.length]);

  const safePage = Math.min(page, totalPages);
  const paginatedProfiles = React.useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return sortedProfiles.slice(start, start + PAGE_SIZE);
  }, [sortedProfiles, safePage]);

  const totalCapped = Math.min(sortedProfiles.length, MAX_VISIBLE);

  return (
    <div className="explore-page">
      {loading ? (
        <div className="explore-skeleton-grid">
          {[1, 2, 3].map((i) => (
            <div key={i} className="explore-skeleton-card">
              <div className="skeleton explore-skeleton-banner" />
              <div className="explore-skeleton-body">
                <div className="skeleton skeleton--circle explore-skeleton-avatar" />
                <div className="explore-skeleton-content">
                  <div className="skeleton explore-skeleton-name" />
                  <div className="skeleton explore-skeleton-count" />
                  <div className="skeleton explore-skeleton-bio-line" />
                  <div className="skeleton explore-skeleton-bio-line explore-skeleton-bio-line--short" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* ── Search bar ── */}
          <div className="explore-search">
            <div className="explore-search-wrap">
              <svg className="explore-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                className="explore-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('explore.search_placeholder')}
              />
            </div>
          </div>

          {/* ── Filter tabs ── */}
          <div className="explore-filters">
            {[
              { key: 'relevance', label: t('explore.filter_relevance') || 'Relevance' },
              { key: 'newest', label: t('explore.filter_newest') || 'Newest' },
              { key: 'interests', label: t('explore.filter_interests') || 'Interests' },
              { key: 'name', label: t('explore.filter_name') || 'Name A-Z' },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                className={`explore-filter-btn${activeFilter === f.key ? ' explore-filter-btn--active' : ''}`}
                onClick={() => setActiveFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* ── Sorted, filtered & paginated grid ── */}
          {sortedProfiles.length === 0 ? (
            <div className="explore-empty">
              <p>{t('explore.no_results')}</p>
            </div>
          ) : (
            <>
              <div className="explore-grid">
                {paginatedProfiles.map((profile) => {
                  const isOwn = user?.id === profile.id;
                  const profAccentVis = profile.accent_visibility ?? 'both';
                  const accentVisible = showAccent && (profile.show_accent_explore ?? true) && (
                    profAccentVis === 'both' ||
                    (profAccentVis === 'me' && isOwn) ||
                    (profAccentVis === 'others' && !isOwn)
                  );
                  return (
                    <ExploreCard
                      key={profile.id}
                      profile={profile}
                      counts={countsMap[profile.id]}
                      isOwnProfile={isOwn}
                      showAccent={accentVisible}
                      getDisplayName={getDisplayName}
                    />
                  );
                })}
              </div>

              {/* ── Pagination ── */}
              {totalPages > 1 && (
                <div className="explore-pagination">
                  <button
                    className="explore-pagination-btn"
                    disabled={safePage <= 1}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                  >
                    {t('common.previous') || 'Previous'}
                  </button>
                  <span className="explore-pagination-info">
                    {safePage} / {totalPages}
                    {sortedProfiles.length > MAX_VISIBLE && (
                      <span className="explore-pagination-capped">
                        {' '}({t('explore.showing_first') || 'Showing first'} {totalCapped})
                      </span>
                    )}
                  </span>
                  <button
                    className="explore-pagination-btn"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  >
                    {t('common.next') || 'Next'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default Explore;

import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '../services/i18n/useI18n';
import usePageTitle from '../../hooks/usePageTitle';
import { FaUsers, FaPlus, FaSpinner, FaSyncAlt } from 'react-icons/fa';
import { useAuth } from '../../hooks/useAuth';
import { getCommunities, getCommunityById, canCreateCommunity, getCachedCommunities, MIN_FOLLOWERS_TO_CREATE, MAX_COMMUNITIES_PER_USER } from '../services/communityService';
import { supabase } from '../services/supabaseclient';
import CreateCommunityModal from '../Resources/Components/CreateCommunityModal';
import CommunityCard from '../Resources/Components/CommunityCard';
import { toast } from 'react-toastify';
import '../Resources/Styles/explore.css';
import '../Resources/Styles/skeleton.css';
import './styles/communities.css';

export default function Comunidades() {
  const { t } = useI18n();
  usePageTitle(t('comunidades.title'));
  const { user, profile } = useAuth();

  // Cache-first: si hay cache válida del listado popular, se muestra al
  // instante (loading=false) y Realtime refresca los contadores después.
  const [communities, setCommunities] = useState(() => getCachedCommunities(user?.id, 'popular') || []);
  const [loading, setLoading] = useState(() => !getCachedCommunities(user?.id, 'popular'));
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('popular');
  const [showCreate, setShowCreate] = useState(false);
  const [checkingPerms, setCheckingPerms] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const searchTimerRef = useRef(null);

  const load = useCallback(async (query = '', sort = 'popular') => {
    // Cache-first: solo mostrar skeleton si no hay cache válida para este
    // sort o si es una búsqueda (los buscados nunca se cachean). Así la
    // cache del listado se aprovecha de verdad en cada visita.
    if (query || !getCachedCommunities(user?.id, sort)) setLoading(true);
    try {
      // refresh: true → la cache siembra el estado al instante (skeleton se
      // decide en el cliente) y aquí siempre se consulta DB y se re-cachea.
      const data = await getCommunities({ search: query, sort, limit: 60, userId: user?.id, refresh: true });
      setCommunities(data);
    } catch (err) {
      console.error('[Comunidades] Error loading:', err);
      setCommunities([]);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { load('', activeFilter); }, [load, activeFilter]);

  // Búsqueda con debounce (mantiene el filtro activo)
  const handleSearch = (value) => {
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => load(value, activeFilter), 350);
  };

  // ── Refresco manual: fuerza getCommunities({ refresh: true }) saltándose el
  //    cache del listado (mantiene la lista visible, solo gira el icono) ──
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const data = await getCommunities({
        search,
        sort: activeFilter,
        limit: 60,
        userId: user?.id,
        refresh: true,
      });
      setCommunities(data);
    } catch (err) {
      console.error('[Comunidades] Error refreshing:', err);
      toast.error(t('comunidades.error'));
    } finally {
      setRefreshing(false);
    }
  };

  // Realtime: actualizar contadores de miembros/posts en el listado
  useEffect(() => {
    const channel = supabase
      .channel('communities-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'communities' }, async (payload) => {
        if (payload.eventType === 'INSERT') {
          const c = await getCommunityById(payload.new.id).catch(() => null);
          if (c) setCommunities((prev) => (prev.some((x) => x.id === c.id) ? prev : [c, ...prev]));
        } else if (payload.eventType === 'DELETE') {
          setCommunities((prev) => prev.filter((c) => c.id !== payload.old.id));
        } else if (payload.eventType === 'UPDATE') {
          setCommunities((prev) => prev.map((c) => (c.id === payload.new.id ? { ...c, ...payload.new } : c)));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const handleCreated = (community) => {
    setCommunities((prev) => (prev.some((c) => c.id === community.id) ? prev : [community, ...prev]));
    toast.success(t('comunidades.created'));
  };

  // ── Aviso ANTES de abrir el modal: si no cumple los requisitos (admin o
  //    100+ followers y menos de 3 comunidades) no abre ──
  const handleCreateClick = async () => {
    if (!user?.id) return;
    setCheckingPerms(true);
    try {
      const res = await canCreateCommunity(user.id, { roles: profile?.roles || [] });
      if (!res.allowed) {
        if (res.limitReached) {
          toast.error(t('comunidades.limit_reached', { n: MAX_COMMUNITIES_PER_USER }));
        } else {
          toast.error(t('comunidades.followers_required', { n: MIN_FOLLOWERS_TO_CREATE }));
        }
        return;
      }
      setShowCreate(true);
    } catch {
      setShowCreate(true);
    } finally {
      setCheckingPerms(false);
    }
  };

  const filters = [
    // 'popular' es el parámetro del backend; el TEXTO se unifica con Explore
    // (Relevance) para que ambas páginas se vean iguales.
    { key: 'popular', label: t('explore.filter_relevance') },
    { key: 'newest', label: t('comunidades.filter_newest') },
    { key: 'active', label: t('comunidades.filter_active') },
  ];

  return (
    <div className="comunidades-page">
      <div className="explore-search comunidades-search-row">
        <div className="explore-search-wrap">
          <svg className="explore-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="explore-search-input"
            type="text"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={t('comunidades.search_placeholder')}
          />
        </div>
        <button
          type="button"
          className="comunidades-refresh-btn"
          onClick={handleRefresh}
          disabled={refreshing}
          title={t('comunidades.refresh')}
          aria-label={t('comunidades.refresh')}
        >
          <FaSyncAlt className={refreshing ? 'fc-spin' : ''} />
        </button>
      </div>

      {/* ── Fila de filtros (mismo patrón que Explore) ── */}

      <div className="explore-filters-container">
        <div className="explore-filters">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`explore-filter-btn${activeFilter === f.key ? ' explore-filter-btn--active' : ''}`}
              onClick={() => {
                setActiveFilter(f.key);
                load(search, f.key);
              }}
            >
              {f.label}
            </button>
          ))}


        </div>

        <div className="explore-filter-2">
            <button
              type="button"
              className="explore-filter-btn explore-filter-btn--active comunidades-create-btn"
              onClick={handleCreateClick}
              disabled={!user?.id || checkingPerms}
              title={user?.id ? '' : t('auth.login_btn')}
            >
              {checkingPerms ? <FaSpinner className="fc-spin" /> : <FaPlus />} {t('comunidades.create_btn')}
            </button>
        </div>
      </div>

      {loading ? (
        <div className="explore-skeleton-grid">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="explore-skeleton-card">
              <div className="skeleton explore-skeleton-banner" />
              <div className="explore-skeleton-body">
                <div className="skeleton skeleton--circle explore-skeleton-avatar" />
                <div className="explore-skeleton-content">
                  <div className="skeleton explore-skeleton-name" />
                  <div className="skeleton explore-skeleton-count" />
                  <div className="skeleton explore-skeleton-bio-line" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : communities.length === 0 ? (
        <div className="comunidades-empty">
          <div className="comunidades-empty-icon"><FaUsers /></div>
          <p className="comunidades-empty-text">{t('comunidades.empty')}</p>
          <p className="comunidades-empty-sub">{t('comunidades.empty_sub')}</p>
        </div>
      ) : (
        <div className="explore-grid comunidades-grid">
          {communities.map((c) => (
            <CommunityCard key={c.id} community={c} />
          ))}
        </div>
      )}

      {/* ── Botón Crear al final (como acción principal de la página) ── */}
      <div className="comunidades-create-bar">

      </div>

      <CreateCommunityModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={handleCreated}
      />
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  FaMusic,
  FaTv,
  FaGamepad,
  FaSpotify,
  FaDesktop,
  FaDiscord,
  FaSteam,
  FaChrome,
  FaFirefox,
  FaEdge,
  FaCode,
  FaTerminal,
  FaTelegram,
  FaWhatsapp,
} from 'react-icons/fa6';
import { useI18n } from '../../services/i18n/useI18n';
import { useAuth } from '../../../hooks/useAuth';
import { computeEffectiveStatus } from '../../services/userStatus';
import { useLocalActivityState, isLocalActivityAvailable } from '../../../hooks/useLocalActivity';
import { isFollowing, getCachedFollowStatus } from '../../services/followService';
import { resolveActivityArtwork } from '../../services/musicService';
import { appLogoUrl, APP_LOGO_CREDIT_URL } from '../../services/appLogos';
import ProgramLogo from './ProgramLogo';
import {
  normalizeActivity,
  activityFromProfile,
  programFromProfile,
  getActivitySettings,
  canViewActivity,
} from '../../services/activityService';
import './css/activityCard.css';

/**
 * Iconos por programa para la card del perfil.
 *
 * El icono real del .exe solo existe dentro de la app de escritorio; en el perfil
 * se ve desde web y desde otros equipos, así que aquí se usa la marca conocida y
 * un monitor genérico para el resto. Se busca en minúsculas por el título guardado.
 */
const PROGRAM_ICONS = {
  spotify: FaSpotify,
  discord: FaDiscord,
  steam: FaSteam,
  chrome: FaChrome,
  'google chrome': FaChrome,
  'brave': FaChrome,
  firefox: FaFirefox,
  edge: FaEdge,
  'microsoft edge': FaEdge,
  'vs code': FaCode,
  'visual studio code': FaCode,
  'windows terminal': FaTerminal,
  terminal: FaTerminal,
  telegram: FaTelegram,
  whatsapp: FaWhatsapp,
};

/** Icono del programa como componente estático (la marca conocida o un monitor). */
function ProgramGlyph({ title, className }) {
  const Icon = PROGRAM_ICONS[String(title || '').trim().toLowerCase()] || FaDesktop;
  return <Icon className={className} />;
}

/** ¿El visitante sigue al dueño del perfil? */

function useViewerIsFollower(viewerId, ownerId, skip) {
  const [isFollower, setIsFollower] = useState(() => {
    if (skip || !viewerId || !ownerId) return false;
    return getCachedFollowStatus(viewerId, ownerId) === true;
  });

  useEffect(() => {
    if (!skip && !viewerId && !ownerId) return undefined;

    let alive = true;
    const cached = getCachedFollowStatus(viewerId, ownerId);
    if (cached !== null && cached !== undefined) {
      return () => {
        alive = false;
      };
    }

    isFollowing(viewerId, ownerId)
      .then((value) => {
        if (alive) setIsFollower(value === true);
      })
      .catch(() => {
        if (alive) setIsFollower(false);
      });

    return () => {
      alive = false;
      isFollowing.cancel?.();
    };
  }, [skip, viewerId, ownerId]);

  return isFollower;
}

/** ActivityCard — qué está haciendo el usuario ahora mismo (música, vídeo o un juego)
 *  y, si lo eligió en Ajustes, el programa que tiene abierto. Va debajo de la card
 *  "Mi canción" del sidebar del perfil. */

export default function ActivityCard({ profile, isOwnProfile, surfaceStyle }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const { activity: liveActivity } = useLocalActivityState();

  const { enabled, visibility } = getActivitySettings(profile);

  const isLive = isOwnProfile && enabled && isLocalActivityAvailable();
  const needsFollowerCheck = enabled && !isOwnProfile && visibility === 'followers';
  const viewerIsFollower = useViewerIsFollower(user?.id, profile?.id, !needsFollowerCheck);

  const visible = canViewActivity({ profile, isOwnProfile, viewerIsFollower });
  // El estado de conexión manda: si el dueño está desconectado (lo marcó al
  // cerrar, o el heartbeat lleva >3 min parado) no se muestra actividad aunque
  // la fila conserve el último registro. En la DB la limpia el trigger de la
  // migración 086; esto cubre además el caso de cierre sucio (crash), donde
  // nadie llegó a escribir 'disconnected'.
  const ownerDisconnected = computeEffectiveStatus(profile) === 'disconnected';
  const storedActivity = ownerDisconnected ? null : activityFromProfile(profile);

  const activity = isLive ? normalizeActivity(liveActivity) : enabled ? storedActivity : null;
  // Segunda actividad: el programa elegido a mano. No lo detecta el watcher, así
  // que se lee de la fila del perfil (columna de la migración 081). Es una
  // preferencia y por eso no caduca, pero tampoco debe verse con el dueño
  // desconectado: si no, al cerrar la pestaña el perfil seguiría mostrando
  // "Usando <programa>" (mientras arreglaba la actividad detectada, este bloque
  // se quedaba fuera del guard y parecía que la actividad no se limpiaba).
  const program = enabled && !ownerDisconnected ? programFromProfile(profile) : null;

  // La caducidad depende del reloj, no de un evento: el dueño pasa a
  // 'disconnected' a los 3 min sin heartbeat y la actividad caduca a los 15 min.
  // Sin este tick la card solo se recalcularía al cambiar algo en la fila, así
  // que seguiría enseñando actividad vieja hasta recargar.
  const [, setStatusTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStatusTick((n) => n + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const [artwork, setArtwork] = useState('');
  const artworkKey = activity && activity.kind === 'music'
    ? `${activity.title}\u0001${activity.subtitle || ''}`
    : '';

  useEffect(() => {
    let alive = true;
    if (!artworkKey) {
      return () => {
        alive = false;
      };
    }

    resolveActivityArtwork({ title: activity.title, artist: activity.subtitle || '' })
      .then((url) => {
        if (alive) setArtwork(url || '');
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [artworkKey]);

  if (!visible || (!activity && !program)) return null;

  const isGame = activity?.kind === 'game';
  const isVideo = activity?.kind === 'video';
  const Icon = isGame ? FaGamepad : isVideo ? FaTv : activity?.app === 'Spotify' ? FaSpotify : FaMusic;

  const label = isGame
    ? t('profile.activity_playing_game')
    : isVideo
      ? t('profile.activity_watching')
      : t('profile.activity_listening');
  const programLogo = program ? appLogoUrl(program.title) : null;


  return (
    <div className="profile-sidebar-card profile-activity-card" style={surfaceStyle}>
      {activity && (
        <>
          <h3 className="profile-sidebar-title">
            <Icon className="profile-sidebar-title-icon" />
            {label}
          </h3>

          <div className="profile-activity-row">
            <span className={`profile-activity-art ${artwork ? 'profile-activity-art--image' : ''}`} aria-hidden="true">
              {artwork ? (
                <img
                  src={artwork}
                  alt=""
                  className="profile-activity-artwork"
                  loading="lazy"
                  draggable={false}
                  onError={() => setArtwork('')}
                />
              ) : (
                <Icon />
              )}
              {!isGame && (
                <span className="profile-activity-bars">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </span>

            <div className="profile-activity-meta">
              <span className="profile-activity-title" title={activity.title}>
                {activity.title}
              </span>
              {activity.subtitle && (
                <span className="profile-activity-subtitle" title={activity.subtitle}>
                  {activity.subtitle}
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {program && (
        <div className={`profile-activity-program ${activity ? '' : 'profile-activity-program--alone'}`}>
          <h3 className="profile-sidebar-title">
            <ProgramGlyph title={program.title} className="profile-sidebar-title-icon" />
            {t('profile.activity_using_app')}
          </h3>

          <div className="profile-activity-row">
            <span
              className={`profile-activity-art ${programLogo ? 'profile-activity-art--image' : ''}`}
              aria-hidden="true"
            >
              <ProgramLogo
                title={program.title}
                imgClassName="profile-activity-artwork"
                fallback={<ProgramGlyph title={program.title} />}
              />
            </span>

            <div className="profile-activity-meta">
              <span className="profile-activity-title" title={program.title}>
                {program.title}
              </span>
            </div>
          </div>

          {/* Atribución exigida por el uso gratuito de apistemic logos. */}
          {programLogo && (
            <a
              className="profile-activity-logo-credit"
              href={APP_LOGO_CREDIT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Logos by apistemic logos
            </a>
          )}
        </div>
      )}
    </div>
  );
}

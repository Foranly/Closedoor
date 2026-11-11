import { toast } from 'react-toastify';
import RateLimitToast from '../Resources/Components/RateLimitToast';
import { getRateLimitInfo } from './helpers';

/**
 * Muestra el aviso de "vas demasiado rápido" para un error de rate limit, con
 * cuenta atrás si la DB devolvió los segundos de espera (migración 093).
 *
 * Devuelve true si el error era de límite (el caller ya no debe mostrar otro
 * mensaje) y false si es otro tipo de error.
 */
export function showRateLimitToast(t, err) {
  const info = getRateLimitInfo(err);
  if (!info) return false;

  // Mismo id por bucket: si el usuario insiste, se actualiza el toast en vez
  // de apilar uno por clic.
  const toastId = `rate-limit-${info.bucket}`;

  if (!info.retryAfter) {
    toast.error(t('common.rate_limited'), { toastId,className: 'fc-toast' });
    return true;
  }

  toast.error(
    ({ closeToast }) => (
      <RateLimitToast seconds={info.retryAfter} t={t} closeToast={closeToast} />
    ),
    { toastId, className: 'fc-toast' }
  );
  return true;
}

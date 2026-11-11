import { useEffect, useState } from 'react';

/**
 * Mensaje del aviso de rate limit con cuenta atrás. La DB (migración 093)
 * devuelve los segundos que quedan de ventana; el toast se cierra solo cuando
 * ya se puede reintentar.
 */
export default function RateLimitToast({ seconds, t, closeToast }) {
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    if (left <= 0) {
      closeToast?.();
      return undefined;
    }
    const timer = setTimeout(() => setLeft((prev) => prev - 1), 1000);
    return () => clearTimeout(timer);
  }, [left, closeToast]);

  return (
    <span className="rate-limit-toast-text">
      {t('common.rate_limited_wait', { seconds: Math.max(left, 0) })}
    </span>
  );
}

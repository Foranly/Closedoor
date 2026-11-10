import { useNavigate } from 'react-router-dom';
import { FaArrowLeft } from 'react-icons/fa';
import { useI18n } from '../services/i18n/useI18n';
import usePageTitle from '../../hooks/usePageTitle';
import '../Resources/Styles/terms.css';

/**
 * Terms — condiciones de uso.
 *
 * El texto vive en los locales (terms.*) para que la página se traduzca con el
 * resto de la app. Las claves se escriben literales para que
 * scripts/validate-locales.mjs las revise.
 */

// Nombre legal del servicio en los términos: el del proyecto y su app
// (Closedoor), no la marca que use app.name en la interfaz.
const APP_NAME = 'Closedoor';

export default function Terms() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const app = APP_NAME;

  usePageTitle(t('terms.title'));

  // Volver al origen (login/registro) sin perder el formulario; si se abrió
  // directamente no hay historial útil y se vuelve al inicio.
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  return (
    <article className="terms-page">
      <button type="button" className="terms-back" onClick={goBack}>
        <FaArrowLeft aria-hidden="true" />
        {t('terms.back')}
      </button>

      <header className="terms-header">
        <h1 className="terms-title">{t('terms.title')}</h1>
        <p className="terms-subtitle">{t('terms.subtitle', { app })}</p>
        <p className="terms-updated">{t('terms.updated')}</p>
      </header>

      <p className="terms-intro">{t('terms.intro', { app })}</p>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s1_title')}</h2>
        <p>{t('terms.s1_p1', { app })}</p>
        <p>{t('terms.s1_p2')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s2_title')}</h2>
        <p>{t('terms.s2_p1')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s3_title')}</h2>
        <p>{t('terms.s3_p1')}</p>
        <p>{t('terms.s3_p2')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s4_title')}</h2>
        <p>{t('terms.s4_p1')}</p>
        <p>{t('terms.s4_p2')}</p>
        <p>{t('terms.s4_p3')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s5_title')}</h2>
        <p>{t('terms.s5_p1')}</p>
        <ul className="terms-list">
          <li>{t('terms.prohibited_li1')}</li>
          <li>{t('terms.prohibited_li2')}</li>
          <li>{t('terms.prohibited_li3')}</li>
          <li>{t('terms.prohibited_li4')}</li>
          <li>{t('terms.prohibited_li5')}</li>
          <li>{t('terms.prohibited_li6')}</li>
          <li>{t('terms.prohibited_li7')}</li>
          <li>{t('terms.prohibited_li8')}</li>
        </ul>
        <p>{t('terms.s5_p2')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s6_title')}</h2>
        <p>{t('terms.s6_p1')}</p>
        <p>{t('terms.s6_p2')}</p>
        <p>{t('terms.s6_p3')}</p>
        <p>{t('terms.s6_p4')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s7_title')}</h2>
        <p>{t('terms.s7_p1')}</p>
        <p>{t('terms.s7_p2')}</p>
        <p>{t('terms.s7_p3')}</p>
        <p>{t('terms.s7_p4')}</p>
        <p>{t('terms.s7_p5')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s8_title')}</h2>
        <p>{t('terms.s8_p1')}</p>
        <p>{t('terms.s8_p2')}</p>
        <p>{t('terms.s8_p3')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s9_title')}</h2>
        <p>{t('terms.s9_p1')}</p>
        <p>{t('terms.s9_p2')}</p>
      </section>

      <section className="terms-section">
        <h2 className="terms-section-title">{t('terms.s10_title')}</h2>
        <p>{t('terms.s10_p1')}</p>
        <p>{t('terms.s10_p2')}</p>
        <p>{t('terms.s10_p3')}</p>
        <p>{t('terms.contact')}</p>
      </section>
    </article>
  );
}

import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../../hooks/useAuth';
import { useI18n } from '../../services/i18n/useI18n';
import usePageTitle from '../../../hooks/usePageTitle';
import { USERNAME_MIN, USERNAME_MAX, DISPLAYNAME_MAX, validateEmail } from '../../services/userService';
import { FaEye, FaEyeSlash, FaDiscord } from 'react-icons/fa';
import TurnstileCaptcha, { isTurnstileActive } from '../../Resources/Components/TurnstileCaptcha';
import '../../Resources/Styles/login.css';
import '../../Resources/Styles/register.css';

// Tiempo mínimo que el loader del botón se muestra (evita saltos bruscos
// y que el formulario se limpie antes de confirmar la sesión).
const MIN_SUBMIT_MS = 600;

function Register() {
  const { t } = useI18n();
  usePageTitle(t('auth.register_title'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [loading, setLoading] = useState(false);
  const [discordLoading, setDiscordLoading] = useState(false);
  const [error, setError] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [captchaToken, setCaptchaToken] = useState(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const { register, loginWithDiscord } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (!email || !password || !username) {
      setError(t('auth.fill_fields'));
      setLoading(false);
      return;
    }

    if (password.length < 6) {
      setError(t('auth.password_length'));
      setLoading(false);
      return;
    }

    // Email: formato válido y proveedor permitido (Gmail, Outlook, Yahoo, Proton, iCloud)
    const emailErr = validateEmail(email);
    if (emailErr === 'invalid') {
      setError(t('auth.email_invalid'));
      setLoading(false);
      return;
    }
    if (emailErr === 'domain') {
      setError(t('auth.email_domain_not_allowed'));
      setLoading(false);
      return;
    }

    // Username: solo letras, números y guiones bajos
    if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
      setError(t('auth.username_invalid_chars') || 'Username can only contain letters, numbers and underscores');
      setLoading(false);
      return;
    }

    // Username: longitud coherente (3–20)
    if (username.trim().length < USERNAME_MIN || username.trim().length > USERNAME_MAX) {
      setError(t('auth.username_length') || `Username must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters`);
      setLoading(false);
      return;
    }

    if (isTurnstileActive() && !captchaToken) {
      setError(t('auth.captcha_required') || 'Complete the CAPTCHA to continue');
      setLoading(false);
      return;
    }

    if (!acceptedTerms) {
      setError(t('auth.terms_required'));
      setLoading(false);
      return;
    }

    const startedAt = Date.now();
    const result = await register(email, password, username, nickname || username, captchaToken);

    if (result.success) {
      // El loader se mantiene visible al menos MIN_SUBMIT_MS para que la
      // confirmación de la sesión no se sienta como un salto brusco.
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_SUBMIT_MS) {
        await new Promise((r) => setTimeout(r, MIN_SUBMIT_MS - elapsed));
      }

      setLoading(false);
      const params = new URLSearchParams(location.search);
      const redirect = params.get('redirect') || '/';
      navigate(redirect);
      return;
    }

    // Error: se muestra de inmediato, sin el delay del loader
    setError(result.error || t('auth.register_error'));
    setCaptchaToken(null);
    setCaptchaNonce((n) => n + 1);
    setLoading(false);
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <p className="auth-subtitle">{t('auth.register_subtitle')}</p>

        {error && <div className="auth-error">{error}</div>}

        <form className="auth-form" onSubmit={handleSubmit}>
          <input
            className="auth-input"
            type="text"
            placeholder={t('auth.nickname') || 'Nickname'}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            disabled={loading}
            maxLength={DISPLAYNAME_MAX}
          />
          <input
            className="auth-input"
            type="text"
            placeholder={t('auth.username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            maxLength={USERNAME_MAX}
          />
          <input
            className="auth-input"
            type="email"
            placeholder={t('auth.email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
          />
          <div className="auth-password-wrap">
            <input
              className="auth-input auth-input--password"
              type={showPassword ? 'text' : 'password'}
              placeholder={t('auth.password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
            />
            <button
              type="button"
              className="auth-password-toggle"
              onClick={() => setShowPassword((s) => !s)}
              tabIndex={-1}
              aria-label={showPassword ? t('auth.hide_password') || 'Hide password' : t('auth.show_password') || 'Show password'}
            >
              {showPassword ? <FaEyeSlash /> : <FaEye />}
            </button>
          </div>
          <TurnstileCaptcha onTokenChange={setCaptchaToken} resetKey={captchaNonce} />
          <div className="auth-terms-row">
            <label className="auth-terms" htmlFor="register-terms">
              <input
                id="register-terms"
                type="checkbox"
                className="auth-terms-checkbox"
                checked={acceptedTerms}
                onChange={(e) => setAcceptedTerms(e.target.checked)}
                disabled={loading || discordLoading}
              />
              <span>{t('auth.terms_accept')}</span>
            </label>
            <Link to="/terms" className="auth-terms-link">
              {t('auth.terms_link')}
            </Link>
          </div>
          <button className="auth-submit" type="submit" disabled={loading}>
            {loading && <span className="auth-submit-spinner" aria-hidden="true" />}
            {loading ? t('auth.registering') : t('auth.register_btn')}
          </button>

          <div className="auth-divider">
            <span>{t('auth.or') || 'or'}</span>
          </div>

          <button
            className="auth-submit auth-submit--discord"
            type="button"
            disabled={discordLoading}
            onClick={async () => {
              if (!acceptedTerms) {
                setError(t('auth.terms_required'));
                return;
              }
              setDiscordLoading(true);
              const startedAt = Date.now();
              const res = await loginWithDiscord();
              if (res && !res.success) {
                setDiscordLoading(false);
                return;
              }
              // OAuth redirige la página; el loader se mantiene un instante
              const elapsed = Date.now() - startedAt;
              if (elapsed < MIN_SUBMIT_MS) {
                await new Promise((r) => setTimeout(r, MIN_SUBMIT_MS - elapsed));
              }
              setDiscordLoading(false);
            }}
          >
            {discordLoading ? <span className="auth-submit-spinner" aria-hidden="true" /> : <FaDiscord className="auth-discord-icon" />}
            {discordLoading
              ? (t('auth.redirecting') || 'Redirecting...')
              : (t('auth.login_discord') || 'Continue with Discord')}
          </button>
        </form>

        <p className="auth-footer">
          {t('auth.has_account')}{' '}
          <Link to="/Login" className="auth-link">
            {t('auth.login_link')}
          </Link>
        </p>
      </div>
    </div>
  );
}

export default Register;

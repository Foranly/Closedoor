import React, {
createContext,
useState,
useEffect,
useCallback,
useRef,
} from "react";
import { supabase } from "../assets/services/supabaseclient";
import { resetActivityDedupe } from "../assets/services/activityService";
import {
checkUsernameExists,
checkEmailExists,
createUserProfile,
ensureUserProfile,
loginEmailByUsername,
getUserProfile,
getCachedProfile,
setCachedProfile,
clearCachedProfile,
clearCachedProfileByUsername,
changeUsername as requestUsernameChange,
verifyCurrentPassword,
validateProfileFields,
} from "../assets/services/userService";
import { clearAllAppCaches } from "../assets/services/postService";
import { clearDecryptedCache } from "../assets/services/alphabetEncryption";
import { clearBlockedListsCache } from "../assets/services/blockService";
import { clearCachedFollowCounts } from "../assets/services/followService";
import {
initPresence,
disposePresence,
} from "../assets/services/presenceService";
import { getItem, waitForKeyReady } from "../assets/services/secureStorage";
import { PROFILE_PUBLIC_COLUMNS } from "../assets/services/userService";
import { validateEmail } from "../assets/services/userService";

export const AuthContext = createContext();

export function AuthProvider({ children }) {
const [user, setUser] = useState(null);
const [profile, setProfile] = useState(null);
const [profileLoading, setProfileLoading] = useState(true);
const [loading, setLoading] = useState(true);
const [error, setError] = useState(null);

// ── Anti-click / anticlick guard: confirmación del cierre de sesión ──────┐
// │                                                                          │
// │ El logout ahora es anticlickeable: el usuario tiene 60 s desde el último   │
// │ click para cancelar el cierre (y, en particular, para confirmar con otro   │
// │ click o pulsación en el botón) antes de que se ejecute el logout.          │
// │ Cuando el estado vuelve a los Santos, se abre el vuelo de confirmación    │
// │ de nuevo.                                                                  │
// └──────────────────────────────────────────────────────────────────────────┘
const MAX_CLOSE_CONFIRM_MS = 60000;
const closeConfirmTimerRef = useRef(null);
const [isLogoutConfirmed, setIsLogoutConfirmed] = useState(false);

const clearCloseConfirmTimer = useCallback(() => {
if (closeConfirmTimerRef.current !== null) {
clearTimeout(closeConfirmTimerRef.current);
closeConfirmTimerRef.current = null;
}
}, []);

const scheduleCloseConfirm = useCallback(() => {
clearCloseConfirmTimer();
if (isLogoutConfirmed) return;
closeConfirmTimerRef.current = setTimeout(() => {
setIsLogoutConfirmed(true);
}, MAX_CLOSE_CONFIRM_MS);
}, [isLogoutConfirmed, clearCloseConfirmTimer]);

const cancelCloseConfirm = useCallback(() => {
clearCloseConfirmTimer();
setIsLogoutConfirmed(false);
}, [clearCloseConfirmTimer]);

useEffect(() => {
const maybeConfirmClose = () => {
if (isLogoutConfirmed) return;
scheduleCloseConfirm();
};

const onFocus = () => maybeConfirmClose();
const onMouseOver = () => maybeConfirmClose();
const onMouseOut = () => cancelCloseConfirm();
const onTouchStart = () => maybeConfirmClose();

window.addEventListener("focus", onFocus, true);
window.addEventListener("mouseover", onMouseOver, true);
window.addEventListener("mouseout", onMouseOut, true);
window.addEventListener("touchstart", onTouchStart, true);

return () => {
window.removeEventListener("focus", onFocus, true);
window.removeEventListener("mouseover", onMouseOver, true);
window.removeEventListener("mouseout", onMouseOut, true);
window.removeEventListener("touchstart", onTouchStart, true);
};
}, [scheduleCloseConfirm, cancelCloseConfirm]);

// ── Persistir mi estado a la DB ──
const persistMyStatus = useCallback(async (status, userId) => {
if (!userId) return;
try {
// Al reportar 'disconnected' se limpia también la actividad detectada: si no,
// el perfil sigue mostrando "Escuchando…" con el usuario ya fuera (la fila
// mantendría activity/activity_updated_at). La migración 086 lo hace por
// trigger, pero esto no depende de que se haya aplicado.
if (status === "disconnected") resetActivityDedupe();
const { error } = await supabase
.from("profiles")
.update({
user_status: status,
user_status_updated_at: new Date().toISOString(),
...(status === "disconnected"
? { activity: null, activity_updated_at: null, program_activity: null }
: {}),
})
.eq("id", userId);
if (error) console.warn("[AuthStatus] DB update error:", error);
} catch (err) {
console.warn("[AuthStatus] Error updating status:", err);
}
}, []);

// ── Status tracker: init, heartbeat, beforeunload ──
const myStatusRef = useRef("online");
const sessionTokenRef = useRef(null);
const heartbeatRef = useRef(null);

const startMyStatusTracker = useCallback(
(userId) => {
if (!userId) return;

(async () => {
// Restaurar estado guardado
let initialStatus = "online";
try {
const saved = getItem("fc_user_status");
if (saved === "dnd" || saved === "idle") {
initialStatus = saved;
}
} catch {}

myStatusRef.current = initialStatus;

// Sesión token para beforeunload fetch
try {
const { data } = await supabase.auth.getSession();
sessionTokenRef.current = data?.session?.access_token || null;
} catch {}

// Heartbeat cada 30s — lee de secureStorage para sincronizar con
// cambios de estado hechos desde useUserStatus.setMyStatus
if (heartbeatRef.current) clearInterval(heartbeatRef.current);
heartbeatRef.current = setInterval(() => {
let s = myStatusRef.current;
try {
const saved = getItem("fc_user_status");
if (saved === "dnd" || saved === "idle" || saved === "online") {
s = saved;
myStatusRef.current = s;
}
} catch {}
if (s === "online" || s === "idle" || s === "dnd") {
persistMyStatus(s, userId);
}
}, 30000);

// beforeunload/pagehide: poner disconnected
const SB_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const restOrigin = (() => {
try {
return new URL(SB_URL).origin;
} catch {
return "";
}
})();

const handleDisconnect = () => {
if (heartbeatRef.current) clearInterval(heartbeatRef.current);
resetActivityDedupe();
const token = sessionTokenRef.current;
if (SB_URL && SB_KEY && token) {
try {
fetch(`${restOrigin}/rest/v1/profiles?id=eq.${userId}`, {
method: "PATCH",
headers: {
"Content-Type": "application/json",
Authorization: `Bearer ${token}`,
apikey: SB_KEY,
},
body: JSON.stringify({
user_status: "disconnected",
user_status_updated_at: new Date().toISOString(),
// Misma limpieza que persistMyStatus: nadie debe quedar con actividad
// publicada al cerrar la app.
activity: null,
activity_updated_at: null,
program_activity: null,
}),
keepalive: true,
}).catch(() => {});
} catch {}
}
persistMyStatus("disconnected", userId).catch(() => {});
};
window.addEventListener("beforeunload", handleDisconnect);
window.addEventListener("pagehide", handleDisconnect);

// Guardar cleanup
window.__fc_statusCleanup = () => {
window.removeEventListener("beforeunload", handleDisconnect);
window.removeEventListener("pagehide", handleDisconnect);
if (heartbeatRef.current) {
clearInterval(heartbeatRef.current);
heartbeatRef.current = null;
}
};

// Sync inicial: restaurar estado en DB
persistMyStatus(initialStatus, userId);
})();
},
[persistMyStatus],
);

const stopMyStatusTracker = useCallback(() => {
if (typeof window.__fc_statusCleanup === "function") {
window.__fc_statusCleanup();
window.__fc_statusCleanup = null;
}
}, []);

// ── Inicializar estado del usuario (global, nunca se desmonta) ──
  useEffect(() => {
    const initializeAuth = async () => {
      try {
        // Esperar a que la clave maestra esté cargada (IndexedDB/memoria)
        // para poder descifrar la sesión de forma fiable.
        await waitForKeyReady();
        // Get current session
        const {
          data: { session },
          error,        } = await supabase.auth.getSession();
        if (error) {
          console.error("Error getting session:", error);
          setUser(null);
          setProfile(null);
          setProfileLoading(false);
        } else {
          const currentUser = session?.user || null;
          setUser(currentUser);
          if (currentUser) {
            const cached = getCachedProfile(currentUser.id);
            if (cached) {
              setProfile(cached);
              setProfileLoading(false);
            }
            try {
              const freshProfile = await getUserProfile(currentUser.id);
              if (freshProfile) {
                setProfile(freshProfile);
                setCachedProfile(freshProfile);
              }
            } catch (err) {
              console.warn("Could not refresh profile on init:", err);
            } finally {
              setProfileLoading(false);
            }
            // ── Inicializar Presence global ──
            initPresence(currentUser.id, "online");
            // ── Restaurar estado guardado + heartbeat global ──
            startMyStatusTracker(currentUser.id);
          } else {
            setProfile(null);
            setProfileLoading(false);
          }
        }
      } catch (err) {
        console.error("Auth initialization error:", err);
        setUser(null);
        setProfile(null);
        setProfileLoading(false);
      } finally {
        setLoading(false);
      }
    };
    initializeAuth();
    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      const currentUser = session?.user || null;
      setUser(currentUser);
      if (!currentUser) {
        setProfile(null);
        setProfileLoading(false);
        disposePresence();
        stopMyStatusTracker();
        return;
      }
      const cached = getCachedProfile(currentUser.id);
      if (cached) {
        setProfile(cached);
        setProfileLoading(false);
      }
      try {
        const freshProfile = await getUserProfile(currentUser.id);
        if (freshProfile) {
          setProfile(freshProfile);
          setCachedProfile(freshProfile);
        }
      } catch (err) {
        console.warn("Could not refresh profile on auth change:", err);
      } finally {
        setProfileLoading(false);
      }
      // Reiniciar tracker de estado al cambiar de usuario
      stopMyStatusTracker();
      startMyStatusTracker(currentUser.id);
    });
    return () => {
      subscription?.unsubscribe();
      stopMyStatusTracker();
    };
  }, []);


// ── Realtime subscription para cambios en profiles ──
useEffect(() => {
if (!user?.id) return;

const channel = supabase
.channel(`profile-realtime-${user.id}`)
.on(
"postgres_changes",
{
event: "UPDATE",
schema: "public",
table: "profiles",
filter: `id=eq.${user.id}`,
},
(payload) => {
const fresh = payload.new;
setProfile(fresh);
setCachedProfile(fresh);
},
)
.subscribe();

return () => {
supabase.removeChannel(channel);
};
}, [user?.id]);

const refreshProfile = async (userId = user?.id) => {
if (!userId) return null;

try {
// Bypass cache para obtener datos frescos siempre.
// Columnas explícitas SIN email (columna revocada en migración 053).
const { data, error } = await supabase
.from("profiles")
.select(PROFILE_PUBLIC_COLUMNS)
.eq("id", userId)
.maybeSingle();

if (error) {
console.error("Error refreshing profile:", error);
return null;
}

if (data) {
setProfile(data);
setCachedProfile(data);
}
return data;
} catch (err) {
console.warn("Could not refresh profile:", err);
return null;
}
};

const isDiscordLinked = !!user?.identities?.some(
(i) => i.provider === "discord",
);

const linkDiscord = async () => {
try {
setError(null);
const { data, error } = await supabase.auth.linkIdentity({
provider: "discord",
options: {
redirectTo: `${window.location.origin}/auth/callback`,
},
});

if (error) {
setError(error.message);
return { success: false, error: error.message };
}

return { success: true };
} catch (err) {
setError(err.message);
return { success: false, error: err.message };
}
};

const loginWithDiscord = async () => {
try {
setError(null);
const { data, error } = await supabase.auth.signInWithOAuth({
provider: "discord",
options: {
redirectTo: `${window.location.origin}/auth/callback`,
},
});

if (error) {
setError(error.message);
return { success: false, error: error.message };
}

// OAuth redirects away from the page, so we don't set user here
return { success: true };
} catch (err) {
setError(err.message);
return { success: false, error: err.message };
}
};

  const login = async (emailOrUsername, password, captchaToken) => {
    try {
      setError(null);
      let email = emailOrUsername;
      // Defensa en profundidad: si el input es un email, validar formato y dominio.
      if (emailOrUsername.includes("@")) {
        const emailErr = validateEmail(emailOrUsername);
        if (emailErr === "invalid") {
          const err = "Enter a valid email address";
          setError(err);
          return { success: false, error: err };
        }
        if (emailErr === "domain") {
          const err =
            "Only emails from Gmail, Outlook, Yahoo, Proton and iCloud are allowed";
          setError(err);
          return { success: false, error: err };
        }
      }
      // Si el input no contiene @, es un username: resolver su email vía
      // RPC password-gated (migración 074). El RPC solo devuelve el email si
      // la contraseña es correcta, así que un username inexistente y una
      // contraseña incorrecta producen el mismo resultado (NULL).
      if (!emailOrUsername.includes("@")) {
        const foundEmail = await loginEmailByUsername(
          emailOrUsername,
          password,
        );
        if (!foundEmail) {
          const err = "Incorrect username or password";
          setError(err);
          return { success: false, error: err };
        }
        email = foundEmail;
      }
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: {
          // Token de Cloudflare Turnstile (verificado server-side por Supabase)
          captchaToken: captchaToken || undefined,
        },
      });
      if (error) {
        setError(error.message);
        return { success: false, error: error.message };
      }
      const loggedUser = data?.user || null;
      if (loggedUser) {
        try {
          await ensureUserProfile(loggedUser);
          const freshProfile = await refreshProfile(loggedUser.id);
          if (freshProfile) {
            setProfile(freshProfile);
          }
        } catch (profileErr) {
          console.warn("Could not ensure profile on login:", profileErr);
        }
        // ── Inicializar Presence global en login ──
        initPresence(loggedUser.id, "online");
      }
      setUser(loggedUser);
      return { success: true, user: loggedUser };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    }
  };
const register = async (
email,
password,
username,
nickname,
captchaToken,
) => {
try {
setError(null);

// Validate inputs
if (!email || !password || !username) {
const err = "All fields are required";
setError(err);
return { success: false, error: err };
}

if (password.length < 6) {
const err = "Password must be at least 6 characters";
setError(err);
return { success: false, error: err };
}

// Defensa en profundidad: validar formato y proveedor del email
// (Gmail, Outlook, Yahoo, Proton, iCloud) antes de contactar a Supabase.
const emailErr = validateEmail(email);
if (emailErr === "invalid") {
const err = "Enter a valid email address";
setError(err);
return { success: false, error: err };
}
if (emailErr === "domain") {
const err =
"Only emails from Gmail, Outlook, Yahoo, Proton and iCloud are allowed";
setError(err);
return { success: false, error: err };
}

if (username.length < 3) {
const err = "Username must be at least 3 characters";
setError(err);
return { success: false, error: err };
}

// Username: solo letras, números y guiones bajos
if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
const err =
"Username can only contain letters, numbers and underscores";
setError(err);
return { success: false, error: err };
}

// Check if username already exists
try {
const usernameExists = await checkUsernameExists(username);
if (usernameExists) {
const err = "Username already taken";
setError(err);
return { success: false, error: err };
}
} catch (err) {
console.warn("Could not check username (table may not exist):", err);
}

// Check if email already exists
try {
const emailExists = await checkEmailExists(email);
if (emailExists) {
const err = "Email already registered";
setError(err);
return { success: false, error: err };
}
} catch (err) {
console.warn("Could not check email:", err);
}

// Sign up with Supabase Auth
const { data, error } = await supabase.auth.signUp({
email,
password,
options: {
// Token de Cloudflare Turnstile (verificado server-side por Supabase)
captchaToken: captchaToken || undefined,
data: {
username,
display_name: nickname || username,
},
},
});

if (error) {
setError(error.message);
return { success: false, error: error.message };
}

// Create user profile in profiles table only when a valid authenticated session exists.
try {
if (data?.session?.user) {
await createUserProfile(
data.session.user.id,
email,
username,
nickname,
);
setUser(data.session.user);
try {
const freshProfile = await getUserProfile(data.session.user.id);
if (freshProfile) {
setProfile(freshProfile);
setCachedProfile(freshProfile);
}
} catch (profileErr) {
console.warn(
"Could not load profile after registration:",
profileErr,
);
}
} else {
setUser(null);
}
} catch (profileErr) {
console.warn(
"Could not create profile (table may not exist or session not authenticated):",
profileErr,
);
}

return {
success: true,
user: data?.session?.user || null,
message: data?.session
? "Registration successful! Your profile was created."
: "Registration successful! Please check your email to confirm before logging in.",
};
} catch (err) {
setError(err.message);
return { success: false, error: err.message };
}
};

// ── Cambio de credenciales desde Ajustes ──
// Los tres exigen la CONTRASEÑA ACTUAL. verify_password (migración 075)
// compara con bcrypt en el servidor y aplica throttle por uid, así que una
// sesión robada no basta para apropiarse de la cuenta.
// Devuelven códigos estables; la UI los traduce (Settings.jsx).

const changeUsername = async (newUsername, currentPassword) => {
setError(null);
if (!user?.id) return { success: false, code: "not_authenticated" };

const normalized = String(newUsername || "")
.trim()
.toLowerCase();
const validationError = validateProfileFields({ username: normalized });
if (validationError) {
setError(validationError);
return {
success: false,
code: "invalid_username",
error: validationError,
};
}
if (!currentPassword) return { success: false, code: "invalid_password" };

const previousUsername = profile?.username;
const code = await requestUsernameChange(normalized, currentPassword);
if (code !== "ok") return { success: false, code };

// El perfil público se cachea por id y por username: invalidar el viejo.
if (previousUsername) clearCachedProfileByUsername(previousUsername);
clearCachedProfile(user.id);

const fresh = await refreshProfile(user.id);
if (!fresh) {
// Sin red: al menos reflejar el cambio ya confirmado por el servidor.
setProfile((prev) => (prev ? { ...prev, username: normalized } : prev));
}
return { success: true, code: "ok", profile: fresh };
};

const changeEmail = async (newEmail, currentPassword) => {
setError(null);
if (!user?.id) return { success: false, code: "not_authenticated" };

const email = String(newEmail || "")
.trim()
.toLowerCase();
const emailErr = validateEmail(email);
if (emailErr === "invalid")
return { success: false, code: "invalid_email" };
if (emailErr === "domain") return { success: false, code: "email_domain" };
if (!currentPassword) return { success: false, code: "invalid_password" };
if (String(user?.email || "").toLowerCase() === email) {
return { success: false, code: "same_email" };
}
if (!(await verifyCurrentPassword(currentPassword))) {
return { success: false, code: "invalid_password" };
}

try {
if (await checkEmailExists(email))
return { success: false, code: "email_taken" };
} catch (err) {
console.warn("Could not check email availability:", err);
}

// Supabase envía el/los correos de confirmación según la config del
// proyecto ("Secure email change" → confirma en la dirección antigua y en
// la nueva). El email real solo cambia al confirmar.
const { error } = await supabase.auth.updateUser({ email });
if (error) {
setError(error.message);
return { success: false, code: "error", error: error.message };
}
return { success: true, code: "ok" };
};

const changePassword = async (newPassword, currentPassword) => {
setError(null);
if (!user?.id) return { success: false, code: "not_authenticated" };
if (typeof newPassword !== "string" || newPassword.length < 6) {
return { success: false, code: "weak_password" };
}
// bcrypt solo usa los primeros 72 bytes: rechazar en vez de truncar.
if (newPassword.length > 72)
return { success: false, code: "password_too_long" };
if (!currentPassword) return { success: false, code: "invalid_password" };
if (newPassword === currentPassword)
return { success: false, code: "same_password" };
if (!(await verifyCurrentPassword(currentPassword))) {
return { success: false, code: "invalid_password" };
}

const { error } = await supabase.auth.updateUser({ password: newPassword });
if (error) {
setError(error.message);
return { success: false, code: "error", error: error.message };
}
return { success: true, code: "ok" };
};

// ── Cierre de sesión con guardado de estado antes de cerrar ──
const currentSession = user?.id
? {
userId: user.id,
username: profile?.username || null,
email: user.email || null,
}
: null;

const sessionStateKey = (sessionId) =>
`foranly_client_session_state_${sessionId}`;

const saveSessionStateOnLogout = async (userId, username, email) => {
if (!userId) return;
const state = {
userId,
username,
email,
savedAt: new Date().toISOString(),
};
try {
await localStorage.setItem(
sessionStateKey(userId),
JSON.stringify(state),
);
} catch (err) {
console.warn(
"[AuthContext] No se pudo guardar el estado de cierre:",
err,
);
throw err;
}
};

const clearSessionState = async (userId) => {
if (!userId) return;
try {
await localStorage.removeItem(sessionStateKey(userId));
} catch (err) {
console.warn("[AuthContext] No se pudo borrar el estado de cierre:", err);
throw err;
}
};

// Confirma que el cierre de sesión corresponde a la sesión actual.
// Devuelve falso cuando el usuario actual no es el mismo que el de la
// sesión que se estaba cerrando, dejando la sesión de los demás intacta.
const confirmSessionOwnership = async (session) => {
if (!session?.userId) return true;
try {
const { data } = await supabase.auth.getSession();
const currentUserId = data?.session?.user?.id;
return currentUserId === session.userId;
} catch {
// Sin red: como no sabemos bien quién es, cerrar la sesión local.
return true;
}
};

  const logout = async () => {
    try {
      setError(null);
      const currentUserId = user?.id;
      const currentUsername = profile?.username;
      // ── Guardar estado antes de cerrar la sesión ──
      try {
        await saveSessionStateOnLogout(
          currentUserId,
          currentUsername,
          user?.email,
        );
      } catch (saveError) {
        console.warn(
          "[AuthContext] No se pudo guardar el estado de cierre:",
          saveError,
        );
      }
      // ── Solo destruir sesión si el usuario actual era el identificador de sesión ──
      // Si hay varias sesiones abiertas, esta salida solo cierra la propia sesión
      // y no invalida las demás.
      if (currentSession) {
        const shouldClose = await confirmSessionOwnership(currentSession);
        if (!shouldClose) {
          setUser(null);
          setProfile(null);
          return { success: false, error: "solo_session_local" };
        }
      }
      // ── Reportar desconexión y limpiar la actividad ANTES de destruir la sesión ──
      // Cerrando sesión no se disparaba beforeunload/pagehide, así que la fila se
      // quedaba con el último latido en 'online' y con la actividad publicada: los
      // demás seguían viendo "Escuchando…" (y en la DB no se limpiaba nunca).
      // Si esta salida no cierra la sesión (todas las comprobaciones de arriba),
      // no se toca: el usuario sigue activo en otro sitio.
      if (currentUserId) {
        await persistMyStatus("disconnected", currentUserId).catch(() => {});
      }

      const { error } = await supabase.auth.signOut();
      if (error) {
        setError(error.message);
        return { success: false, error: error.message };
      }
      if (currentSession) {
        try {
          await clearSessionState(currentSession.userId);
        } catch (clearError) {
          console.warn(
            "[AuthContext] No se pudo borrar el estado de cierre:",
            clearError,
          );
        }
      }
      setUser(null);
      setProfile(null);
      // ── Liberar Presence global ──
      disposePresence();
      // ── Limpiar todo el caché de la sesión ──
      clearAllAppCaches(); // Elimina todos los localStorage fc_*
      clearDecryptedCache(); // Limpia el caché en memoria de contenido descifrado
      if (currentUserId) {
        clearCachedProfile(currentUserId);
        clearBlockedListsCache(currentUserId);
        clearCachedFollowCounts(currentUserId);
      }
      if (currentUsername) {
        clearCachedProfileByUsername(currentUsername);
      }
      return { success: true };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    }
  };
  // ── Valor del contexto ──
  const value = {
    user,
    profile,
    profileLoading,
    loading,
    error,
    isAuthenticated: !!user,
    isDiscordLinked,
    isLogoutConfirmed,
    refreshProfile,
    login,
    register,
    loginWithDiscord,
    linkDiscord,
    logout,
    changeUsername,
    changeEmail,
    changePassword,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

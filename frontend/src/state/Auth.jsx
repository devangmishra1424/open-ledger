import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, UNAUTHORIZED_EVENT } from '../services/api';

/**
 * Who is signed in, and whether this server requires it. The server is the authority: it says
 * whether sign-in is on (`required`), whether it is set up (`configured`), and which account the
 * stored token belongs to. The token itself is only ever checked by the server.
 *
 * status: 'loading' until the first answer, 'ready' after it, 'unreachable' if the server could not
 * be asked (the landing page still works; the workbench says why it cannot open).
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // signedOut: the person pressed Sign out in this tab, so the workbench gate sends them home, not to the login page.
  const [state, setState] = useState({ status: 'loading', required: true, configured: true, problem: null, user: null, error: null, signedOut: false });

  const refresh = useCallback(async () => {
    try {
      const s = await api.getSession();
      // A token the server no longer accepts (expired, or the secret changed) is dropped here.
      if (!s.user && getToken()) setToken(null);
      setState({ status: 'ready', required: s.required, configured: s.configured, problem: s.problem, user: s.user, error: null });
    } catch (e) {
      setState((prev) => ({ ...prev, status: 'unreachable', error: e }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const onUnauthorized = () => {
      setToken(null);
      setState((prev) => ({ ...prev, user: null }));
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async (username, password) => {
    const res = await api.login(username, password);
    setToken(res.token);
    setState((prev) => ({ ...prev, status: 'ready', user: res.user, error: null, signedOut: false }));
    return res.user;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setState((prev) => ({ ...prev, user: null, signedOut: true }));
  }, []);

  /** The home page calls this once it has shown the sign-out, so a later visit to /app asks to sign in again. */
  const acknowledgeSignedOut = useCallback(() => {
    setState((prev) => (prev.signedOut ? { ...prev, signedOut: false } : prev));
  }, []);

  /** True when the workbench may open: signed in, or sign-in is off on this server. */
  const canEnter = state.status === 'ready' && state.configured && (!state.required || Boolean(state.user));

  return (
    <AuthContext.Provider value={{ ...state, canEnter, login, logout, refresh, acknowledgeSignedOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

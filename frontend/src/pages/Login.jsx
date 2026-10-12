import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '../state/Auth';
import '../styles/landing.css';

const TRAIL = [
  ['0414', 'c7e2…0a3f', 'auto_approve', 'Rules: clean three-way match'],
  ['0415', '2d88…e61b', 'escalate_l1', 'Rules: a line is not on the PO'],
  ['0416', 'a04c…93d7', 'human_approved', 'Approved by a signed-in person'],
  ['0417', '6e19…b2c0', 'block_fraud_flag', 'Bank details changed: held'],
];

/** Only same-site paths inside the workbench may be returned to, never an outside URL. */
function safeNext(raw) {
  return raw && raw.startsWith('/app') && !raw.startsWith('//') ? raw : '/app';
}

export default function Login() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Already signed in (or sign-in is off here): there is nothing to do on this page.
  useEffect(() => {
    if (auth.canEnter && auth.user) navigate(next, { replace: true });
  }, [auth.canEnter, auth.user, next, navigate]);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await auth.login(username.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err.message || 'Sign-in failed.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const signInOff = auth.status === 'ready' && auth.configured && !auth.required;

  return (
    <div className="lp-root">
      <div className="lp-paper" aria-hidden="true" />
      <div className="lp-login">
        <aside className="lp-login-art" aria-hidden="true">
          <Link to="/" className="lp-brand" tabIndex={-1}><span className="vb-brand-mark">V</span><span>VeriBook</span></Link>
          <h2>Every decision you make here is <em>signed with your name</em>, and chained to the one before it.</h2>
          <div className="lp-login-chain">
            {TRAIL.map(([seq, hash, action, label]) => (
              <div className="lp-block" key={seq}>
                <span className="lp-block-seq">#{seq} · {hash}</span>
                <span className={`lp-block-action lp-act-${action.split('_')[0]}`}>{action}</span>
                <span className="lp-block-seq">{label}</span>
              </div>
            ))}
          </div>
        </aside>

        <main className="lp-login-panel">
          <Link to="/" className="lp-brand"><span className="vb-brand-mark" aria-hidden="true">V</span><span>VeriBook</span></Link>
          <h1>Sign in</h1>
          <p>Use the account your administrator gave you. Approvals and sign-offs are recorded under it.</p>

          {auth.status === 'loading' && <p className="lp-note" role="status">Checking the server…</p>}
          {auth.status === 'unreachable' && (
            <p className="lp-error" role="alert">The server could not be reached: {auth.error?.message}{' '}
              <button type="button" className="vb-link-btn" onClick={auth.refresh}>Try again</button>
            </p>
          )}
          {auth.status === 'ready' && !auth.configured && <p className="lp-error" role="alert">{auth.problem}</p>}

          {signInOff ? (
            <div className="lp-form">
              <p className="lp-note">Sign-in is switched off on this server (local development). You can go straight in.</p>
              <Link to={next} className="lp-btn lp-btn-solid lp-btn-lg">Open the workbench <ArrowRight size={18} aria-hidden="true" /></Link>
            </div>
          ) : (
            <form className="lp-form" onSubmit={submit} noValidate>
              <label className="lp-field">
                <span>Username</span>
                <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={100} required />
              </label>
              <label className="lp-field">
                <span>Password</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} required />
              </label>
              {error && <p className="lp-error" role="alert">{error}</p>}
              <button type="submit" className="lp-btn lp-btn-solid lp-btn-lg" disabled={busy || !username.trim() || !password || auth.status !== 'ready' || !auth.configured}>
                {busy ? 'Signing in…' : <>Sign in <ArrowRight size={18} aria-hidden="true" /></>}
              </button>
            </form>
          )}
          <Link to="/" className="lp-back">← Back to the home page</Link>
        </main>
      </div>
    </div>
  );
}

import React from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { ToastProvider } from './state/Toasts';
import { AuthProvider, useAuth } from './state/Auth';
import { ReviewerProvider } from './state/Reviewer';
import { InvoicesProvider } from './state/Invoices';
import Shell from './components/Shell';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Inbox from './pages/Inbox';
import PurchaseOrders from './pages/PurchaseOrders';
import AuditTrail from './pages/AuditTrail';
import Pipeline from './pages/Pipeline';
import EcosystemMap from './pages/EcosystemMap';
import SettingsPage from './pages/SettingsPage';
import Quality from './pages/Quality';

import './styles/workbench.css';

/**
 * Public: the landing page (/) and sign-in (/login). Everything else lives under /app and opens only
 * when the server says this browser may enter (signed in, or sign-in switched off for local
 * development). The workbench's data providers sit inside that gate, so the landing page never
 * calls a protected endpoint.
 */
export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route index element={<Landing />} />
          <Route path="login" element={<Login />} />
          <Route path="app" element={<RequireSignIn />}>
            <Route element={<Shell />}>
              <Route index element={<Inbox />} />
              <Route path="invoice/:id" element={<Inbox />} />
              <Route path="orders" element={<PurchaseOrders />} />
              <Route path="audit" element={<AuditTrail />} />
              <Route path="pipeline" element={<Pipeline />} />
              <Route path="network" element={<EcosystemMap />} />
              <Route path="quality" element={<Quality />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}

function RequireSignIn() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'loading') return <GateMessage title="Opening VeriBook…" />;
  if (auth.status === 'unreachable') {
    return <GateMessage title="The server could not be reached" body={auth.error?.message ?? 'Try again in a moment.'} action={<button type="button" className="vb-btn" onClick={auth.refresh}>Try again</button>} />;
  }
  if (!auth.configured) return <GateMessage title="Sign-in is not set up on this server" body={auth.problem} />;
  if (!auth.canEnter) {
    if (auth.signedOut) return <Navigate to="/" replace />;
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return (
    <ReviewerProvider>
      <InvoicesProvider>
        <Outlet />
      </InvoicesProvider>
    </ReviewerProvider>
  );
}

function GateMessage({ title, body, action }) {
  return (
    <div className="vb-gate" role="status">
      <span className="vb-brand-mark" aria-hidden="true">V</span>
      <h1>{title}</h1>
      {body && <p className="vb-muted">{body}</p>}
      {action}
    </div>
  );
}

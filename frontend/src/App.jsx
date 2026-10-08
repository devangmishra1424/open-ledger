import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './state/Toasts';
import { ReviewerProvider } from './state/Reviewer';
import { InvoicesProvider } from './state/Invoices';
import Shell from './components/Shell';
import Inbox from './pages/Inbox';
import AuditTrail from './pages/AuditTrail';
import Pipeline from './pages/Pipeline';
import EcosystemMap from './pages/EcosystemMap';
import SettingsPage from './pages/SettingsPage';

import './styles/workbench.css';

export default function App() {
  return (
    <ToastProvider>
      <ReviewerProvider>
        <InvoicesProvider>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Inbox />} />
              <Route path="invoice/:id" element={<Inbox />} />
              <Route path="audit" element={<AuditTrail />} />
              <Route path="pipeline" element={<Pipeline />} />
              <Route path="network" element={<EcosystemMap />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </InvoicesProvider>
      </ReviewerProvider>
    </ToastProvider>
  );
}

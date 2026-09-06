import React, { useState } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import AmbientBackground from './components/AmbientBackground';
import GlobalSpotlight from './components/GlobalSpotlight';
import OverlaySidebar from './components/OverlaySidebar';
import TopBar from './components/TopBar';
import RightPanel from './components/RightPanel';

import Dashboard from './pages/Dashboard';
import InvoiceQueue from './pages/InvoiceQueue';
import InvoiceDetail from './pages/InvoiceDetail';
import AgentsPage from './pages/AgentsPage';
import AuditTrail from './pages/AuditTrail';
import EcosystemMap from './pages/EcosystemMap';
import SettingsPage from './pages/SettingsPage';

import './App.css';

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const [selectedInvoice, setSelectedInvoice] = useState(null);

  const handleSelectInvoice = (invoice) => {
    setSelectedInvoice(invoice);
    navigate(`/invoice/${invoice.id}`);
  };

  const getTitleForRoute = (path) => {
    if (path.startsWith('/invoice/')) return `Invoice ${selectedInvoice?.id || ''}`;
    switch (path) {
      case '/': return 'Dashboard';
      case '/invoices': return 'Invoice Queue';
      case '/agents': return 'Autonomous AI Agents';
      case '/audit': return 'Cryptographic Audit Trail';
      case '/ecosystem': return 'Ecosystem Topology';
      case '/settings': return 'Ledger Settings';
      default: return 'Dashboard';
    }
  };

  const isDashboard = location.pathname === '/';
  const currentTitle = getTitleForRoute(location.pathname);

  return (
    <div className="app-root-layout">
      {/* 1. Ambient Background */}
      <AmbientBackground />

      {/* 2. MASTER GLASSMORPHIC SHELL (Wider 95vw container) */}
      <div className="master-glass-shell">
        {/* Single Icon Rail Sidebar with Absolute Overlay Expansion */}
        <OverlaySidebar />

        {/* Main Viewport Area */}
        <main className="app-main-viewport">
          <TopBar />

          <div className="app-content-columns">
            <div className="app-page-main">
              <Routes>
                <Route 
                  path="/" 
                  element={<Dashboard onSelectInvoice={handleSelectInvoice} />} 
                />
                <Route 
                  path="/invoices" 
                  element={<InvoiceQueue onSelectInvoice={handleSelectInvoice} />} 
                />
                <Route 
                  path="/invoice/:id" 
                  element={
                    <InvoiceDetail 
                      invoice={selectedInvoice} 
                      onBack={() => navigate('/')} 
                    />
                  } 
                />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/audit" element={<AuditTrail />} />
                <Route path="/ecosystem" element={<EcosystemMap />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </div>

            {/* Right Panel widgets for secondary pages if needed */}
            {!isDashboard && (
              <RightPanel onNavigateToInvoices={() => navigate('/invoices')} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default AppContent;

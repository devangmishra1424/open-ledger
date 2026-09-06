import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, 
  FileText, 
  Bot, 
  ShieldCheck, 
  Network, 
  Settings, 
  LogOut 
} from 'lucide-react';
import './TwoPaneSidebar.css';

const NAV_ITEMS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    route: '/',
    subItems: [
      { id: 'overview', label: 'Overview', route: '/' }
    ]
  },
  {
    id: 'invoices',
    label: 'Invoices',
    icon: FileText,
    route: '/invoices',
    subItems: [
      { id: 'queue', label: 'Invoice Queue', route: '/invoices' }
    ]
  },
  {
    id: 'agents',
    label: 'AI Agents',
    icon: Bot,
    route: '/agents',
    subItems: [
      { id: 'fleet', label: 'Fleet Matrix', route: '/agents' }
    ]
  },
  {
    id: 'audit',
    label: 'Audit Trail',
    icon: ShieldCheck,
    route: '/audit'
  },
  {
    id: 'ecosystem',
    label: 'Ecosystem',
    icon: Network,
    route: '/ecosystem'
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    route: '/settings'
  }
];

const TwoPaneSidebar = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const getActiveIndex = () => {
    const path = location.pathname;
    if (path.startsWith('/invoice/')) return 1; // Invoices
    const idx = NAV_ITEMS.findIndex(item => item.route === path);
    return idx >= 0 ? idx : 0;
  };

  const activeIdx = getActiveIndex();

  const handleNavClick = (route) => {
    navigate(route);
  };

  return (
    <aside className="two-pane-sidebar-container">
      {/* PANE 1: Icon Rail (Fixed ~60px) */}
      <div className="sidebar-pane-rail">
        <div className="rail-top-logo">
          <div className="logo-icon-bubble">OL</div>
        </div>

        <div className="rail-icons-stack">
          {NAV_ITEMS.map((item, idx) => {
            const Icon = item.icon;
            const isActive = activeIdx === idx;
            return (
              <button
                key={item.id}
                className={`rail-icon-btn ${isActive ? 'active-rail-btn' : ''}`}
                onClick={() => handleNavClick(item.route)}
                title={item.label}
              >
                <Icon size={19} />
              </button>
            );
          })}
        </div>

        <div className="rail-bottom-status" title="5 Financial Agents Active">
          <span className="status-pulse-dot" />
        </div>
      </div>

      {/* PANE 2: Label Panel (Fixed ~210px) */}
      <div className="sidebar-pane-panel">
        <div className="panel-header">
          <span className="panel-header-title">NAVIGATION</span>
        </div>

        <div className="panel-items-list">
          {NAV_ITEMS.map((item, idx) => {
            const isActive = activeIdx === idx;
            const Icon = item.icon;
            return (
              <div key={item.id} className="nav-item-wrapper">
                <button
                  className={`panel-nav-pill ${isActive ? 'active-pill' : ''}`}
                  onClick={() => handleNavClick(item.route)}
                >
                  <Icon size={17} />
                  <span className="pill-label">{item.label}</span>
                </button>

                {/* Indented Sub-items Support */}
                {item.subItems && isActive && (
                  <div className="sub-items-tree">
                    {item.subItems.map(sub => (
                      <button
                        key={sub.id}
                        className="sub-item-btn"
                        onClick={() => handleNavClick(sub.route)}
                      >
                        <span className="tree-line" />
                        <span className="sub-item-label">{sub.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="panel-bottom-footer">
          <button className="logout-btn-pill" onClick={() => alert('Session logged out.')}>
            <LogOut size={15} />
            <span>Log Out</span>
          </button>
        </div>
      </div>
    </aside>
  );
};

export default TwoPaneSidebar;

import React, { useState } from 'react';
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
import './OverlaySidebar.css';

const NAV_ITEMS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    route: '/',
    subItems: [{ id: 'overview', label: 'Overview', route: '/' }]
  },
  {
    id: 'invoices',
    label: 'Invoices',
    icon: FileText,
    route: '/invoices',
    subItems: [{ id: 'queue', label: 'Invoice Queue', route: '/invoices' }]
  },
  {
    id: 'agents',
    label: 'AI Agents',
    icon: Bot,
    route: '/agents',
    subItems: [{ id: 'fleet', label: 'Fleet Matrix', route: '/agents' }]
  },
  { id: 'audit', label: 'Audit Trail', icon: ShieldCheck, route: '/audit' },
  { id: 'ecosystem', label: 'Ecosystem', icon: Network, route: '/ecosystem' },
  { id: 'settings', label: 'Settings', icon: Settings, route: '/settings' }
];

const OverlaySidebar = () => {
  const [isHovered, setIsHovered] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const getActiveIndex = () => {
    const path = location.pathname;
    if (path.startsWith('/invoice/')) return 1;
    const idx = NAV_ITEMS.findIndex(item => item.route === path);
    return idx >= 0 ? idx : 0;
  };

  const activeIdx = getActiveIndex();

  const handleNavClick = (route) => {
    navigate(route);
  };

  return (
    <aside 
      className="overlay-sidebar-wrapper"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 1. ALWAYS VISIBLE ICON RAIL (~58px, OL Logo Badge Removed per Item 5) */}
      <div className="sidebar-icon-rail">
        <div className="rail-icons">
          {NAV_ITEMS.map((item, idx) => {
            const Icon = item.icon;
            const isActive = activeIdx === idx;
            return (
              <button
                key={item.id}
                className={`rail-btn ${isActive ? 'active' : ''}`}
                onClick={() => handleNavClick(item.route)}
                title={item.label}
              >
                <Icon size={19} />
              </button>
            );
          })}
        </div>

        <div className="rail-status" title="5 Agents Online">
          <span className="status-dot-green" />
        </div>
      </div>

      {/* 2. ABSOLUTE SLIDING OVERLAY PANEL (Item 4: Label before icon) */}
      <div className={`sidebar-overlay-panel ${isHovered ? 'visible' : ''}`}>
        <div className="panel-header">
          <span className="panel-title">NAVIGATION</span>
        </div>

        <div className="panel-nav-list">
          {NAV_ITEMS.map((item, idx) => {
            const isActive = activeIdx === idx;
            const Icon = item.icon;
            return (
              <div key={item.id} className="nav-group">
                <button
                  className={`nav-pill ${isActive ? 'active-pill' : ''}`}
                  onClick={() => handleNavClick(item.route)}
                >
                  <span>{item.label}</span>
                  <Icon size={17} />
                </button>

                {item.subItems && isActive && (
                  <div className="sub-tree">
                    {item.subItems.map(sub => (
                      <button
                        key={sub.id}
                        className="sub-pill"
                        onClick={() => handleNavClick(sub.route)}
                      >
                        <span>{sub.label}</span>
                        <span className="bullet" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="panel-footer">
          <button className="logout-btn" onClick={() => alert('Logged out.')}>
            <span>Log Out</span>
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
};

export default OverlaySidebar;

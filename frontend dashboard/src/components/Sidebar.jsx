import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import LineSidebar from './LineSidebar';
import { 
  LayoutDashboard, 
  FileText, 
  Bot, 
  ShieldCheck, 
  Network, 
  Settings, 
  LogOut 
} from 'lucide-react';
import './Sidebar.css';

const Sidebar = ({ onHoverChange, title = 'Dashboard' }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const items = ['Dashboard', 'Invoices', 'AI Agents', 'Audit Trail', 'Ecosystem', 'Settings'];
  const routes = ['/', '/invoices', '/agents', '/audit', '/ecosystem', '/settings'];
  const navIcons = [LayoutDashboard, FileText, Bot, ShieldCheck, Network, Settings];

  const getActiveIndex = () => {
    const idx = routes.indexOf(location.pathname);
    return idx >= 0 ? idx : 0;
  };

  const handleItemClick = (index) => {
    navigate(routes[index]);
  };

  return (
    <aside 
      className="sidebar-wrapper-column"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      {/* ELEGANT LONGER HEIGHT RETRACTABLE SIDEBAR CONTAINER */}
      <div className="sidebar-container glass-panel">
        <LineSidebar
          items={items}
          navIcons={navIcons}
          accentColor="#3b82f6"
          textColor="#9ca3af"
          markerColor="#475569"
          showMarker={true}
          showIndex={false}
          proximityRadius={80}
          maxShift={8}
          itemGap={12}
          fontSize={0.88}
          defaultActive={getActiveIndex()}
          onItemClick={handleItemClick}
        />

        {/* Bottom Footer Section */}
        <div className="sidebar-bottom-section">
          <div className="system-status-badge">
            <span className="status-dot" style={{ background: '#34d399', boxShadow: '0 0 8px #34d399', flexShrink: 0 }} />
            <span className="status-badge-text">All 5 Agents Online</span>
          </div>

          <button className="logout-button" onClick={() => alert('Logged out of Open Ledger session.')} title="Log Out">
            <LogOut size={16} style={{ flexShrink: 0 }} />
            <span className="logout-label-text">Log Out</span>
          </button>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;

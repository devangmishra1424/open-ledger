import React from 'react';
import SplitFlapText from './SplitFlapText';
import { Search, Bell, Plus } from 'lucide-react';
import './TopBar.css';

const TopBar = () => {
  return (
    <header className="topbar-container">
      {/* Column 1: Left Breadcrumbs & Status */}
      <div className="topbar-left-breadcrumb">
        <span className="bc-home">Home</span>
        <span className="bc-sep">/</span>
        <span className="bc-current">Dashboard</span>
        <span className="chain-pill">✓ Verified</span>
      </div>

      {/* Column 2: Centered Company Name Wordmark */}
      <div className="topbar-company-name-center">
        <SplitFlapText
          words={['OPEN LEDGER', 'AGENT MATRIX']}
          cycleDelay={3200}
          fontSize={26}
          tileRadius={7}
          gap={5}
          padTo={11}
        />
      </div>

      {/* Column 3: Right Actions, Avatars & Profile */}
      <div className="topbar-right">
        <div className="avatar-stack" title="Active Financial Agents">
          <div className="avatar-bubble" style={{ background: '#232733' }}>FA</div>
          <div className="avatar-bubble" style={{ background: '#333342' }}>DA</div>
          <div className="avatar-bubble" style={{ background: '#a7c957', color: '#0d0d12' }}>CA</div>
          <div className="avatar-bubble more-bubble">+2</div>
        </div>

        <button className="btn-glass" style={{ fontSize: '12px', padding: '6px 12px' }}>
          <Plus size={14} />
          <span>Add Member</span>
        </button>

        <button className="icon-action-btn" title="Search (⌘K)">
          <Search size={15} />
        </button>

        <button className="icon-action-btn" title="Notifications">
          <Bell size={15} />
          <span className="notification-dot" />
        </button>

        <button className="user-profile-btn">
          <div className="user-avatar-main">AK</div>
        </button>
      </div>
    </header>
  );
};

export default TopBar;

import React, { useState } from 'react';
import GlassCard from '../components/GlassCard';
import { Network, Building2, Landmark, Bot, ShieldCheck, Zap } from 'lucide-react';
import './EcosystemMap.css';

const EcosystemMap = () => {
  const [selectedNode, setSelectedNode] = useState(null);

  const nodes = [
    { id: 'n1', label: 'Open Ledger Core', type: 'Core', x: 400, y: 220, icon: Bot, color: '#a7c957', details: 'Central orchestration engine running 5 autonomous AI agents.' },
    { id: 'n2', label: 'Acme Corp (Vendor)', type: 'Vendor', x: 160, y: 120, icon: Building2, color: '#ffffff', details: 'Primary cloud infrastructure vendor with Net 30 terms.' },
    { id: 'n3', label: 'CyberDyne Systems', type: 'Vendor', x: 160, y: 320, icon: Building2, color: '#ffffff', details: 'AI Hardware Accelerator provider.' },
    { id: 'n4', label: 'JP Morgan Treasury', type: 'Bank', x: 640, y: 120, icon: Landmark, color: '#a7c957', details: 'Automated ACH / Wire settlement portal.' },
    { id: 'n5', label: 'Ethereum L2 Vault', type: 'Blockchain', x: 640, y: 320, icon: ShieldCheck, color: '#ffd60a', details: 'Immutable Merkle proof and audit seal commit layer.' }
  ];

  const connections = [
    { from: 'n2', to: 'n1', label: 'PDF Invoice Stream' },
    { from: 'n3', to: 'n1', label: 'API Ingestion' },
    { from: 'n1', to: 'n4', label: 'Payment Instruction' },
    { from: 'n1', to: 'n5', label: 'Merkle Hash Commit' }
  ];

  const activeDetails = selectedNode || nodes[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%' }}>
      <GlassCard style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Network size={24} color="#a7c957" />
              Connected Financial Ecosystem Topology
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Interactive network graph of vendors, banking APIs, agents, and blockchain audit nodes
            </p>
          </div>
          <span className="status-chip clean">
            <span className="status-dot" />
            Topology Synced (4 Active Links)
          </span>
        </div>
      </GlassCard>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px' }}>
        {/* Network Canvas */}
        <GlassCard className="ecosystem-canvas-card">
          <svg className="ecosystem-svg">
            {/* Animated Connecting Lines */}
            {connections.map((conn, idx) => {
              const sourceNode = nodes.find(n => n.id === conn.from);
              const targetNode = nodes.find(n => n.id === conn.to);
              return (
                <g key={idx}>
                  <line 
                    x1={sourceNode.x} 
                    y1={sourceNode.y} 
                    x2={targetNode.x} 
                    y2={targetNode.y} 
                    className="network-link-line"
                  />
                  <circle 
                    r="3" 
                    fill="#a7c957" 
                    className="link-pulse-particle"
                  >
                    <animateMotion 
                      path={`M ${sourceNode.x} ${sourceNode.y} L ${targetNode.x} ${targetNode.y}`} 
                      dur={`${3 + idx}s`} 
                      repeatCount="indefinite" 
                    />
                  </circle>
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => {
              const Icon = node.icon;
              const isSelected = activeDetails.id === node.id;
              return (
                <g 
                  key={node.id} 
                  transform={`translate(${node.x}, ${node.y})`}
                  onClick={() => setSelectedNode(node)}
                  style={{ cursor: 'pointer' }}
                >
                  <circle 
                    r={isSelected ? "34" : "28"} 
                    fill="#0d122b" 
                    stroke={node.color} 
                    strokeWidth={isSelected ? "3" : "2"}
                    className="ecosystem-node-circle"
                  />
                  <foreignObject x="-14" y="-14" width="28" height="28" style={{ pointerEvents: 'none' }}>
                    <div style={{ color: node.color, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                      <Icon size={18} />
                    </div>
                  </foreignObject>
                  <text 
                    y="46" 
                    textAnchor="middle" 
                    fill="#ffffff" 
                    fontSize="12" 
                    fontWeight="600"
                    fontFamily="Plus Jakarta Sans"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </GlassCard>

        {/* Node Inspector Panel */}
        <GlassCard style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.05)', border: `1px solid ${activeDetails.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: activeDetails.color }}>
              <Zap size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '18px', fontWeight: 700, color: '#ffffff' }}>{activeDetails.label}</h3>
              <span className="status-chip clean" style={{ fontSize: '11px', marginTop: '2px' }}>
                {activeDetails.type} Node
              </span>
            </div>
          </div>

          <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
            {activeDetails.details}
          </p>

          <div style={{ padding: '14px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '12px', border: '1px solid var(--border-glass)' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>Node ID</div>
            <div className="font-mono" style={{ fontSize: '14px', color: '#ffffff' }}>{activeDetails.id}-ECO-V2</div>
          </div>
        </GlassCard>
      </div>
    </div>
  );
};

export default EcosystemMap;

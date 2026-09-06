import React, { useState, useEffect } from 'react';
import GlassCard from '../components/GlassCard';
import { Network, Building2, Landmark, Bot, ShieldCheck, Zap } from 'lucide-react';
import { api } from '../services/api';
import './EcosystemMap.css';

const ICON_BY_TYPE = {
  Core: Bot,
  Vendor: Building2,
  Bank: Landmark,
  Blockchain: ShieldCheck,
};

const EcosystemMap = () => {
  const [nodes, setNodes] = useState([]);
  const [connections, setConnections] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchEcosystem = () => api.getEcosystem().then((data) => {
      if (cancelled || !data) return;
      setNodes(data.nodes ?? []);
      setConnections(data.connections ?? []);
    });
    fetchEcosystem();
    const interval = setInterval(fetchEcosystem, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const activeDetails = nodes.find((n) => n.id === selectedNodeId) ?? nodes[0] ?? null;

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
              Real vendors from your ledger, arranged around the core pipeline
            </p>
          </div>
          <span className="status-chip clean">
            <span className="status-dot" />
            {connections.length} Active Links
          </span>
        </div>
      </GlassCard>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px' }}>
        <GlassCard className="ecosystem-canvas-card">
          {nodes.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              No vendors on file yet — nodes appear here once an invoice creates a real vendor.
            </div>
          ) : (
            <svg className="ecosystem-svg">
              {connections.map((conn, idx) => {
                const sourceNode = nodes.find(n => n.id === conn.from);
                const targetNode = nodes.find(n => n.id === conn.to);
                if (!sourceNode || !targetNode) return null;
                return (
                  <g key={idx}>
                    <line
                      x1={sourceNode.x}
                      y1={sourceNode.y}
                      x2={targetNode.x}
                      y2={targetNode.y}
                      className="network-link-line"
                    />
                    <circle r="3" fill="#a7c957" className="link-pulse-particle">
                      <animateMotion
                        path={`M ${sourceNode.x} ${sourceNode.y} L ${targetNode.x} ${targetNode.y}`}
                        dur={`${3 + idx}s`}
                        repeatCount="indefinite"
                      />
                    </circle>
                  </g>
                );
              })}

              {nodes.map((node) => {
                const Icon = ICON_BY_TYPE[node.type] ?? Building2;
                const isSelected = activeDetails?.id === node.id;
                return (
                  <g
                    key={node.id}
                    transform={`translate(${node.x}, ${node.y})`}
                    onClick={() => setSelectedNodeId(node.id)}
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
          )}
        </GlassCard>

        <GlassCard style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {activeDetails ? (
            <>
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
                <div className="font-mono" style={{ fontSize: '13px', color: '#ffffff', wordBreak: 'break-all' }}>{activeDetails.id}</div>
              </div>
            </>
          ) : (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Select a node to inspect it.</p>
          )}
        </GlassCard>
      </div>
    </div>
  );
};

export default EcosystemMap;

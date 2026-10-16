import React, { useState, useEffect } from 'react';
import { Building2, Landmark, Bot, ShieldCheck } from 'lucide-react';
import { api } from '../services/api';
import { Banner, Empty } from '../components/ui';
import './EcosystemMap.css';

const ICON_BY_TYPE = {
  Core: Bot,
  Vendor: Building2,
  Bank: Landmark,
  Ledger: ShieldCheck,
};

// The drawing's own coordinate space; the SVG scales to its card through viewBox.
const W = 820;
const H = 480;

/**
 * Where each node sits. The server's x/y put up to eight vendors on a short arc about 36px apart with
 * 56px circles, so they overlapped and hid each other's names. Here vendors stand in one evenly spaced
 * column with their names to the left, the core in the middle, and the payment rail and the decision
 * ledger to the right.
 */
function layout(nodes) {
  const vendors = nodes.filter((n) => n.type === 'Vendor');
  const top = 48;
  const step = vendors.length > 1 ? Math.min(70, (H - 2 * top) / (vendors.length - 1)) : 0;
  const startY = H / 2 - (step * (vendors.length - 1)) / 2;
  const pos = new Map();
  vendors.forEach((v, i) => pos.set(v.id, { x: 250, y: startY + i * step }));
  for (const n of nodes) {
    if (n.type === 'Core') pos.set(n.id, { x: 470, y: H / 2 });
    if (n.type === 'Bank') pos.set(n.id, { x: 680, y: H / 2 - 110 });
    if (n.type === 'Ledger') pos.set(n.id, { x: 680, y: H / 2 + 110 });
  }
  return pos;
}

export default function EcosystemMap() {
  const [nodes, setNodes] = useState([]);
  const [connections, setConnections] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchEcosystem = () => api.getEcosystem().then((data) => {
      if (cancelled) return;
      setNodes(data.nodes ?? []);
      setConnections(data.connections ?? []);
      setError(null);
    }).catch((e) => { if (!cancelled) setError(e); });
    fetchEcosystem();
    const interval = setInterval(fetchEcosystem, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const pos = layout(nodes);
  const active = nodes.find((n) => n.id === selectedNodeId) ?? nodes[0] ?? null;
  const vendorCount = nodes.filter((n) => n.type === 'Vendor').length;
  const flaggedCount = nodes.filter((n) => n.type === 'Vendor' && n.color === '#ff5757').length;

  return (
    <div className="vb-net">
      {error && <Banner kind="error">Could not load the network: {error.message}</Banner>}
      <p className="vb-muted vb-small vb-net-intro">
        How money flows: vendors send invoices into the pipeline in the middle; only approved invoices go on to the payment rail, and every decision, approved or not, is written to the decision ledger. Click any circle to see what it is and what it means for the queue.
        {' '}<b>{vendorCount}</b> vendor{vendorCount === 1 ? '' : 's'}{flaggedCount > 0 && <>, <span className="vb-net-flagged">{flaggedCount} flagged</span></>}.
      </p>

      <div className="vb-net-grid">
        <section className="vb-card vb-net-canvas" aria-label="Vendor network">
          {nodes.length === 0 ? (
            <Empty title="No vendors yet">Vendors appear here once an invoice creates one.</Empty>
          ) : (
            <svg viewBox={`0 0 ${W} ${H}`} className="vb-net-svg" role="img" aria-label={`${vendorCount} vendors connected to the VeriBook pipeline`}>
              {connections.map((conn, idx) => {
                const a = pos.get(conn.from);
                const b = pos.get(conn.to);
                if (!a || !b) return null;
                const mx = (a.x + b.x) / 2;
                const d = `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
                return (
                  <g key={idx}>
                    <path d={d} className="vb-net-link" />
                    <circle r="3" className="vb-net-pulse">
                      <animateMotion path={d} dur={`${3 + (idx % 4)}s`} repeatCount="indefinite" />
                    </circle>
                  </g>
                );
              })}

              {nodes.map((node) => {
                const p = pos.get(node.id);
                if (!p) return null;
                const Icon = ICON_BY_TYPE[node.type] ?? Building2;
                const isVendor = node.type === 'Vendor';
                const isSelected = active?.id === node.id;
                const r = isVendor ? 20 : 30;
                return (
                  <g
                    key={node.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    onClick={() => setSelectedNodeId(node.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedNodeId(node.id); } }}
                    tabIndex={0}
                    role="button"
                    aria-label={node.label}
                    className={`vb-net-node${isSelected ? ' is-selected' : ''}`}
                  >
                    <circle r={r + (isSelected ? 4 : 0)} className="vb-net-ring" style={{ stroke: node.color }} />
                    <foreignObject x={-10} y={-10} width="20" height="20" style={{ pointerEvents: 'none' }}>
                      <div style={{ color: node.color, display: 'grid', placeItems: 'center', height: '100%' }}>
                        <Icon size={isVendor ? 15 : 18} />
                      </div>
                    </foreignObject>
                    <text
                      className="vb-net-label"
                      x={isVendor ? -(r + 12) : 0}
                      y={isVendor ? 4 : r + 22}
                      textAnchor={isVendor ? 'end' : 'middle'}
                    >
                      {node.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </section>

        <section className="vb-card vb-net-detail" aria-live="polite">
          {active ? (
            <>
              <span className="vb-chip vb-chip-neutral">{active.type === 'Vendor' ? 'Vendor' : active.type === 'Core' ? 'Pipeline' : active.type === 'Bank' ? 'Payments' : 'Decision ledger'}</span>
              <h2>{active.label}</h2>
              <p className="vb-muted">{active.details}</p>
              {active.type === 'Vendor' && (
                <p className="vb-dim vb-small">A red circle is a flagged vendor. Select another circle to compare.</p>
              )}
            </>
          ) : (
            <p className="vb-muted">Select a node to inspect it.</p>
          )}
        </section>
      </div>
    </div>
  );
}

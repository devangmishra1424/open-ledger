import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useParams } from 'react-router-dom';
import GlassCard from '../components/GlassCard';
import { api } from '../services/api';
import {
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
  FileSearch,
  ThumbsUp,
  RotateCcw,
  XCircle,
  Copy,
  Check,
  Bot,
  Construction,
  ClipboardCheck,
  GitCompare,
  Scale,
  HelpCircle
} from 'lucide-react';
import './InvoiceDetail.css';

const NODE_ICONS = {
  extract: FileSearch,
  validate: ClipboardCheck,
  match: GitCompare,
  investigate: ShieldCheck,
  verify: Bot,
  policy: Scale,
  audit: CheckCircle2,
};

const InvoiceDetail = ({ invoice, onBack }) => {
  const { id: routeId } = useParams();
  const [inv, setInv] = useState(invoice ?? null);
  const [activePopoverNode, setActivePopoverNode] = useState(null);
  const [streamedText, setStreamedText] = useState('');
  const [isExplainLoading, setIsExplainLoading] = useState(false);
  const [isSealed, setIsSealed] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [invoiceStatus, setInvoiceStatus] = useState(invoice?.status || 'In Review');

  // Reveals real, already-recorded decision nodes one at a time — a presentation animation
  // over real history, not a simulated live run (this invoice already finished processing).
  const [completedStepCount, setCompletedStepCount] = useState(1);
  const [segments, setSegments] = useState([]);

  const containerRef = useRef(null);
  const nodeRefs = useRef([]);

  const targetId = invoice?.id ?? routeId;

  useEffect(() => {
    if (!targetId) return;
    api.getInvoiceById(targetId).then((data) => {
      if (data) {
        setInv(data);
        setInvoiceStatus(data.status);
      }
    });
  }, [targetId]);

  const rawAgentNodes = (inv?.decisions ?? []).map((d) => ({
    id: d.id,
    decisionId: d.id,
    title: d.label,
    icon: NODE_ICONS[d.nodeId] ?? HelpCircle,
    confidence: d.confidence != null ? `${d.confidence}%` : (d.actionTaken ?? '—'),
    reasonCode: d.reasonCode,
    actionTaken: d.actionTaken,
  }));

  // Reveals the real, already-recorded decision nodes one at a time as a presentation
  // animation — this invoice already finished processing, so there is nothing to simulate;
  // the count itself (rawAgentNodes.length) is entirely real.
  useEffect(() => {
    setCompletedStepCount(1);
    const total = rawAgentNodes.length || 1;
    const timers = [];
    for (let step = 2; step <= total; step++) {
      timers.push(setTimeout(() => setCompletedStepCount(step), (step - 1) * 250));
    }
    return () => timers.forEach(clearTimeout);
  }, [inv?.id, rawAgentNodes.length]);

  // Item 2a, 2b & Monitor Screen Fix: Calculate exact SVG path coordinates from node DOM bounding rects
  const calculatePaths = () => {
    if (!containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const newSegments = [];

    for (let i = 0; i < rawAgentNodes.length - 1; i++) {
      const nodeEl1 = nodeRefs.current[i];
      const nodeEl2 = nodeRefs.current[i + 1];

      if (nodeEl1 && nodeEl2) {
        const r1 = nodeEl1.getBoundingClientRect();
        const r2 = nodeEl2.getBoundingClientRect();

        const x1 = r1.left + r1.width / 2 - containerRect.left;
        const y1 = r1.top + r1.height / 2 - containerRect.top;
        const x2 = r2.left + r2.width / 2 - containerRect.left;
        const y2 = r2.top + r2.height / 2 - containerRect.top;

        const yMid = (y1 + y2) / 2;
        const d = `M ${x1} ${y1} C ${x1} ${yMid}, ${x2} ${yMid}, ${x2} ${y2}`;
        newSegments.push({ d, fromIndex: i, toIndex: i + 1 });
      }
    }
    setSegments(newSegments);
  };

  useLayoutEffect(() => {
    calculatePaths();
    const anim = requestAnimationFrame(calculatePaths);
    const timer = setTimeout(calculatePaths, 150);
    return () => {
      cancelAnimationFrame(anim);
      clearTimeout(timer);
    };
  }, [completedStepCount]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      calculatePaths();
    });
    observer.observe(containerRef.current);

    window.addEventListener('resize', calculatePaths);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', calculatePaths);
    };
  }, []);

  useEffect(() => {
    if (!activePopoverNode) {
      setStreamedText('');
      return;
    }
    const node = rawAgentNodes.find(n => n.id === activePopoverNode);
    if (!node) return;

    let cancelled = false;
    setStreamedText('');
    setIsExplainLoading(true);
    const question = `Why did the ${node.title} stage reach action "${node.actionTaken ?? 'this outcome'}"${node.reasonCode ? ` (${node.reasonCode})` : ''}?`;

    api.explainInvoice(inv.id, question, node.decisionId).then((result) => {
      if (cancelled) return;
      setIsExplainLoading(false);
      setStreamedText(result?.answer ?? 'No explanation was returned.');
    });

    return () => { cancelled = true; };
  }, [activePopoverNode]);

  const handleCopyHash = () => {
    navigator.clipboard.writeText(inv.hash);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleSealNow = async () => {
    const result = await api.sealInvoice(inv.id);
    if (result?.success) {
      setIsSealed(true);
      alert(`Chain integrity verified across ${result.decisionsVerified} decision(s). Hash: ${result.hash?.slice(0, 16)}...`);
    } else {
      alert(`Seal check failed — the hash chain is broken${result?.brokenAt ? ` at decision ${result.brokenAt}` : ''}.`);
    }
  };

  const handleApprove = async () => {
    const result = await api.approveInvoice(inv.id);
    if (result?.success && result.invoice) {
      setInv(result.invoice);
      setInvoiceStatus(result.invoice.status);
      alert(`Invoice #${inv.id} approved and posted.`);
    } else {
      alert(`Could not approve invoice #${inv.id}${result?.error ? `: ${result.error}` : ''}.`);
    }
  };

  const handleContest = async () => {
    const result = await api.contestInvoice(inv.id, 'User flagged for manual audit review');
    if (result?.success && result.invoice) {
      setInv(result.invoice);
      setInvoiceStatus(result.invoice.status);
      alert(result.reconsider?.escalatedToSenior
        ? `Invoice #${inv.id} contested — escalated to a senior reviewer.`
        : `Invoice #${inv.id} contested — reconsideration re-ran the pipeline.`);
    } else {
      alert(`Could not contest invoice #${inv.id}.`);
    }
  };

  const handleReject = async () => {
    const result = await api.rejectInvoice(inv.id, 'User rejected invoice authorization');
    if (result?.success && result.invoice) {
      setInv(result.invoice);
      setInvoiceStatus(result.invoice.status);
      alert(`Invoice #${inv.id} rejected.`);
    } else {
      alert(`Could not reject invoice #${inv.id}.`);
    }
  };

  if (!inv) {
    return (
      <div className="invoice-detail-page-grid">
        <GlassCard className="detail-summary-column-card inner-dark-card">
          <button className="btn-glass back-btn-compact" onClick={onBack}>
            <ArrowLeft size={14} />
            <span>Back to Dashboard</span>
          </button>
          <p style={{ padding: '24px', color: 'var(--text-muted)' }}>Loading invoice…</p>
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="invoice-detail-page-grid">
      {/* COLUMN 1: INVOICE SUMMARY COLUMN */}
      <GlassCard className="detail-summary-column-card inner-dark-card">
        <button className="btn-glass back-btn-compact" onClick={onBack}>
          <ArrowLeft size={14} />
          <span>Back to Dashboard</span>
        </button>

        {/* Invoice Metadata Header */}
        <div className="summary-meta-header">
          <div className="summary-title-row">
            <h2 className="summary-invoice-id font-mono">Invoice #{inv.id}</h2>
            <span className={`status-chip ${invoiceStatus === 'Clean' ? 'clean' : invoiceStatus === 'In Review' ? 'review' : 'blocked'}`}>
              {invoiceStatus === 'In Review' ? <Construction size={12} style={{ color: '#ffd60a', marginRight: '3px' }} /> : <span className="status-dot" />}
              {invoiceStatus}
            </span>
          </div>

          <div className="summary-vendor-name">{inv.vendor}</div>
          <div className="summary-amount-big font-mono">
            ${inv.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>

          <div className="summary-specs-list">
            <div className="spec-row">
              <span className="spec-label">Purchase Order</span>
              <span className="spec-val font-mono">{inv.poNumber}</span>
            </div>
            <div className="spec-row">
              <span className="spec-label">Payment Terms</span>
              <span className="spec-val">{inv.terms}</span>
            </div>
            <div className="spec-row">
              <span className="spec-label">Tax Exemption ID</span>
              <span className="spec-val font-mono">{inv.taxId}</span>
            </div>
            <div className="spec-row">
              <span className="spec-label">Received / Due</span>
              <span className="spec-val">{inv.receivedDate} · {inv.dueDate}</span>
            </div>
          </div>
        </div>

        {/* Action Buttons: Approve / Contest / Reject */}
        <div className="summary-action-buttons">
          <button className="btn-approve" onClick={handleApprove}>
            <ThumbsUp size={15} />
            <span>Approve Invoice</span>
          </button>

          <div className="two-buttons-row">
            <button className="btn-contest" onClick={handleContest}>
              <RotateCcw size={14} />
              <span>Contest</span>
            </button>
            <button className="btn-reject" onClick={handleReject}>
              <XCircle size={14} />
              <span>Reject</span>
            </button>
          </div>
        </div>

        {/* Audit Seal Block */}
        <div className="summary-seal-block">
          <div className="seal-block-header">
            {isSealed ? (
              <CheckCircle2 size={15} color="#a7c957" />
            ) : (
              <Construction size={15} color="#ffd60a" />
            )}
            <span className="seal-block-title">
              {isSealed ? 'Audit Seal Committed' : 'Pending Audit Seal'}
            </span>
          </div>
          <div className="seal-hash-display font-mono">{inv.hash}</div>

          <div className="seal-actions-flex">
            <button className="btn-glass" onClick={handleCopyHash} style={{ flex: 1, justifyContent: 'center' }}>
              {isCopied ? <Check size={13} color="#a7c957" /> : <Copy size={13} />}
              <span>{isCopied ? 'Copied' : 'Copy Hash'}</span>
            </button>
            {!isSealed && (
              <button className="btn-glass" onClick={handleSealNow} style={{ flex: 1, justifyContent: 'center', background: '#232733', borderColor: 'rgba(255,255,255,0.16)' }}>
                <Construction size={13} color="#ffd60a" />
                <span>Seal Now</span>
              </button>
            )}
          </div>
        </div>
      </GlassCard>

      {/* COLUMN 2: VERTICAL UNBOXED AGENT FLOW WITH PROGRAMMATIC ANIMATED CONNECTORS */}
      <div className="detail-vertical-agent-flow">
        <div className="flow-header-row">
          <div className="flow-title font-sans">
            <Bot size={18} color="#a7c957" />
            <span>Autonomous Agent Execution Chain</span>
          </div>
          <span className="status-chip clean" style={{ fontSize: '10.5px' }}>
            Processing: Step {completedStepCount} of {rawAgentNodes.length}
          </span>
        </div>

        {/* Staggered Vertical Stage — min-height scales with the real stage count so the
            container (now scrollable) has enough room for every node to fit without
            overlapping, instead of clipping whatever didn't fit a fixed 100%. */}
        <div className="vertical-chain-stage" ref={containerRef} style={{ minHeight: `${Math.max(500, rawAgentNodes.length * 110)}px` }}>
          {/* Programmatically computed SVG path segments */}
          <svg className="vertical-chain-svg">
            <filter id="neon-green-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {segments.map((seg, idx) => {
              const isSegmentDrawn = completedStepCount > idx + 1;
              return (
                <path
                  key={idx}
                  d={seg.d}
                  className={`connector-segment ${isSegmentDrawn ? 'drawn' : ''}`}
                />
              );
            })}
          </svg>

          {/* Vertical Staggered Agent Nodes */}
          <div className="vertical-nodes-layer">
            {rawAgentNodes.map((node, idx) => {
              const Icon = node.icon;
              const isRight = idx % 2 === 1;
              const isCenter = idx === rawAgentNodes.length - 1;
              const isOpen = activePopoverNode === node.id;
              const posClass = isCenter ? 'pos-center' : isRight ? 'pos-right' : 'pos-left';
              const isNodeDone = completedStepCount > idx;
              // Evenly spaced regardless of how many real stages this invoice has (5, 7,
              // whatever) — a fixed CSS table tuned for exactly 5 nodes previously left later
              // nodes stacked with no position at all once real invoices with 7 stages showed up.
              const topPct = rawAgentNodes.length > 1 ? (idx / (rawAgentNodes.length - 1)) * 88 + 4 : 4;

              return (
                <div
                  key={node.id}
                  ref={el => nodeRefs.current[idx] = el}
                  className={`dark-agent-node-v2 ${posClass} ${isNodeDone ? 'node-done' : 'node-pending'}`}
                  style={{ top: `${topPct}%` }}
                  onClick={() => setActivePopoverNode(isOpen ? null : node.id)}
                >
                  <div className="dark-node-icon-box">
                    <Icon size={18} color="#ffffff" />
                  </div>
                  <div className="dark-node-title">{node.title}</div>
                  <div className="dark-node-confidence font-mono">{node.confidence}</div>

                  {/* Distinct Green Checkmark Indicator for completed status */}
                  {isNodeDone && (
                    <div className="node-done-check-badge" title="Status: Completed ✓">
                      <Check size={11} color="#0d0d12" strokeWidth={3} />
                    </div>
                  )}

                  {/* Popover */}
                  {isOpen && (
                    <div className="ask-why-popover" onClick={(e) => e.stopPropagation()}>
                      <div className="popover-header">
                        <span>🤖 Attestation: {node.title}</span>
                        <button 
                          style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer' }}
                          onClick={() => setActivePopoverNode(null)}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="popover-body-text">
                        {isExplainLoading ? 'Asking the explain engine…' : streamedText}
                        {isExplainLoading && <span className="popover-cursor" />}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default InvoiceDetail;

import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
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
  Construction
} from 'lucide-react';
import './InvoiceDetail.css';

const InvoiceDetail = ({ invoice, onBack }) => {
  const [activePopoverNode, setActivePopoverNode] = useState(null);
  const [streamedText, setStreamedText] = useState('');
  const [isSealed, setIsSealed] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [invoiceStatus, setInvoiceStatus] = useState(invoice?.status || 'In Review');
  
  // Real-time simulated SSE agent execution step progress (1..5)
  const [completedStepCount, setCompletedStepCount] = useState(1);
  const [segments, setSegments] = useState([]);

  const containerRef = useRef(null);
  const nodeRefs = useRef([]);

  const inv = invoice || {
    id: 'INV-2024-0847',
    vendor: 'Acme Corp',
    amount: 12450.00,
    terms: 'Net 30',
    poNumber: 'PO-2024-1138',
    receivedDate: '2026-09-04',
    dueDate: '2026-10-04',
    taxId: 'US-94820193',
    hash: '0x38d92a1049581a029e4821a94820194810293847'
  };

  const rawAgentNodes = [
    {
      id: 'format',
      title: 'Format Agent',
      icon: FileSearch,
      confidence: '99.6%',
      explanation: 'Format Agent extracted all 4 header parameters and 2 table items with 99.6% visual OCR confidence using Vision-LLM 2.4.'
    },
    {
      id: 'duplicate',
      title: 'Duplicate Agent',
      icon: Copy,
      confidence: '100%',
      explanation: 'Duplicate Agent queried 14,200 historical ledger records. No matching hash or PO/Amount collision was detected.'
    },
    {
      id: 'fraud',
      title: 'Fraud Agent',
      icon: ShieldCheck,
      confidence: inv.status === 'Blocked' ? '68.5%' : '98.9%',
      explanation: inv.status === 'Blocked' 
        ? 'ALERT: Fraud Agent detected a new bank account routing number that has not been whitelisted by Acme Corp procurement.'
        : 'Bank routing number matched Acme Corp primary JP Morgan Chase operating account.'
    },
    {
      id: 'compliance',
      title: 'Compliance Agent',
      icon: CheckCircle2,
      confidence: inv.status === 'Blocked' ? 'Pending' : '99.2%',
      explanation: 'Compliance Agent cross-referenced Purchase Order PO-2024-1138 and verified tax exemption ID US-94820193.'
    },
    {
      id: 'manager',
      title: 'Manager Agent',
      icon: Bot,
      confidence: '99.8%',
      explanation: 'Manager Agent aggregated all 4 agent attestations and generated SHA-256 Merkle root seal.'
    }
  ];

  // Item 2c: Simulated SSE real-time agent execution pipeline sequence
  useEffect(() => {
    setCompletedStepCount(1);
    const t1 = setTimeout(() => setCompletedStepCount(2), 700);
    const t2 = setTimeout(() => setCompletedStepCount(3), 1400);
    const t3 = setTimeout(() => setCompletedStepCount(4), 2100);
    const t4 = setTimeout(() => setCompletedStepCount(5), 2800);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [invoice]);

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

    const fullText = node.explanation;
    let currentIdx = 0;
    setStreamedText('');

    const interval = setInterval(() => {
      currentIdx += 2;
      setStreamedText(fullText.slice(0, currentIdx));
      if (currentIdx >= fullText.length) clearInterval(interval);
    }, 20);

    return () => clearInterval(interval);
  }, [activePopoverNode]);

  const handleCopyHash = () => {
    navigator.clipboard.writeText(inv.hash);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleSealNow = async () => {
    await api.sealInvoice(inv.id);
    setIsSealed(true);
    setInvoiceStatus('Clean');
    alert('Cryptographic seal committed to Ethereum L2 / Open Ledger block #19,284,019!');
  };

  const handleApprove = async () => {
    await api.approveInvoice(inv.id);
    setInvoiceStatus('Clean');
    setIsSealed(true);
    alert(`Invoice #${inv.id} approved for payment processing!`);
  };

  const handleContest = async () => {
    await api.contestInvoice(inv.id, 'User flagged for manual audit review');
    setInvoiceStatus('In Review');
    alert(`Invoice #${inv.id} flagged as contested.`);
  };

  const handleReject = async () => {
    await api.rejectInvoice(inv.id, 'User rejected invoice authorization');
    setInvoiceStatus('Blocked');
    alert(`Invoice #${inv.id} rejected.`);
  };

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
            Processing: Step {completedStepCount} of 5
          </span>
        </div>

        {/* Staggered Vertical Stage (Bounded stage for all screen monitor types) */}
        <div className="vertical-chain-stage" ref={containerRef}>
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
              const isCenter = idx === 4;
              const isOpen = activePopoverNode === node.id;
              const posClass = isCenter ? 'pos-center' : isRight ? 'pos-right' : 'pos-left';
              const isNodeDone = completedStepCount > idx;

              return (
                <div
                  key={node.id}
                  ref={el => nodeRefs.current[idx] = el}
                  className={`dark-agent-node-v2 ${posClass} ${isNodeDone ? 'node-done' : 'node-pending'}`}
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
                        {streamedText}
                        <span className="popover-cursor" />
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

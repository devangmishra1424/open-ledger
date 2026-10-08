import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import GlassCard from '../components/GlassCard';
import SpecularButton from '../components/SpecularButton';
import PixelTransition from '../components/PixelTransition';
import Shuffle from '../components/Shuffle';
import { LedgerSummaryWidget, PendingSealsWidget, ActivityWidget } from '../components/RightPanel';
import { api } from '../services/api';
import {
  Plus,
  Filter,
  ArrowRight,
  Sparkles,
  Construction,
  Upload,
  Inbox,
  FileSearch,
  Key,
  Database,
  GitCompare
} from 'lucide-react';
import './Dashboard.css';

const Dashboard = ({ onSelectInvoice }) => {
  const [invoices, setInvoices] = useState([]);
  const [seals, setSeals] = useState([]);
  const [allReviewed, setAllReviewed] = useState(false);
  const [statusFilter, setStatusFilter] = useState('All');
  const [priorityFilter, setPriorityFilter] = useState('All');
  const [isIngesting, setIsIngesting] = useState(false);
  const [visualizerStep, setVisualizerStep] = useState(0);
  const [demoPoKey, setDemoPoKey] = useState("");
  const [uploadedFileName, setUploadedFileName] = useState("Invoice Document");
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const fileInputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const fetchAll = () => {
      api.getInvoices().then((data) => { if (!cancelled && data) setInvoices(data); });
      api.getPendingSeals().then((data) => { if (!cancelled && data) setSeals(data); });
    };
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const filteredInvoices = invoices.filter((inv) => {
    if (statusFilter !== 'All' && inv.status !== statusFilter) return false;
    if (priorityFilter !== 'All' && inv.priority !== priorityFilter) return false;
    return true;
  });

  const handleAddNewInvoice = async () => {
    const vendor = window.prompt('Vendor name for the new invoice:', 'Acme Corp');
    if (!vendor) return;
    const amountStr = window.prompt('Invoice amount (USD):', '1000');
    const amount = Number(amountStr);
    if (!amountStr || Number.isNaN(amount) || amount <= 0) {
      alert('Enter a valid positive amount.');
      return;
    }
    const description = window.prompt('Line item description:', 'Services rendered') || 'Services rendered';

    const created = await api.createInvoice({
      vendor,
      items: [{ description, qty: 1, rate: amount }],
    });

    if (created && created.id) {
      setInvoices([created, ...invoices]);
      alert(`Created invoice #${created.id} for ${vendor} — the real pipeline is now running against it.`);
    } else {
      alert('Could not create the invoice — the backend did not confirm it.');
    }
  };

  const processRawInvoiceText = async (rawText, fileName = 'Invoice Document') => {
    setIsIngesting(true);
    setShowUploadModal(false);
    setUploadedFileName(fileName);
    setVisualizerStep(1); // Extracting Invoice Data...

    try {
      const created = await api.ingestInvoice(rawText);
      if (created && created.id) {
        setInvoices((prev) => [created, ...prev]);
        const poKey = created.poNumber || created.extraction?.po_reference || 'PO-AutoMatched';
        setDemoPoKey(poKey);

        setTimeout(() => {
          setVisualizerStep(2); // Matching Key Found
          setTimeout(() => {
            setVisualizerStep(3); // Querying ERP
            setTimeout(() => {
              setVisualizerStep(4); // Executing Match
              setTimeout(() => {
                setVisualizerStep(0);
                setIsIngesting(false);
                if (onSelectInvoice) onSelectInvoice(created);
                navigate(`/invoice/${created.id}`);
              }, 400);
            }, 400);
          }, 400);
        }, 400);
      } else {
        alert('Could not process invoice — backend did not confirm creation.');
        setIsIngesting(false);
        setVisualizerStep(0);
      }
    } catch (err) {
      alert(`Ingestion error: ${err.message}`);
      setIsIngesting(false);
      setVisualizerStep(0);
    }
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const reader = new FileReader();
        reader.onload = async () => {
          await processRawInvoiceText(reader.result, file.name);
        };
        reader.onerror = () => alert("Failed to read PDF file.");
        reader.readAsDataURL(file);
      } else {
        const rawText = await file.text();
        await processRawInvoiceText(rawText, file.name);
      }
    } catch (err) {
      alert(`Could not read file: ${err.message}`);
    }
  };

  const handleUploadDemo = async () => {
    const randomSuffix = Math.floor(Math.random() * 10000);
    const sampleText = `INVOICE\nVendor: Global Freight Logistics\nInvoice Date: 2026-09-15\nInvoice Number: GFL-99382-${randomSuffix}\nPurchase Order: PO-55102\n\nLine Items:\n1. Standard Ground Shipping\n   Qty: 1\n   Unit Price: $500.00\n2. Express Air Freight\n   Qty: 1\n   Unit Price: $1200.00\n\nSubtotal: 1700.00\nTax (5%): 85.00\nTotal Amount Due: 1785.00\n`;
    await processRawInvoiceText(sampleText, `Demo_Invoice_${randomSuffix}.txt`);
  };

  const handlePasteSubmit = async () => {
    if (!pastedText.trim()) return;
    const textToProcess = pastedText;
    setPastedText('');
    await processRawInvoiceText(textToProcess, 'Pasted_Invoice.txt');
  };

  const handleSealAll = async () => {
    if (seals.length === 0) return;
    const result = await api.sealAllInvoices();
    if (result?.success) {
      alert(`Chain integrity verified for all ${result.sealedCount} pending invoice(s).`);
      setSeals([]);
    } else {
      alert(`Seal check failed for ${result?.failedIds?.length ?? 'some'} invoice(s) — chain is broken.`);
    }
  };

  const handleMarkReviewed = async () => {
    await api.markAllReviewed();
    setAllReviewed(true);
  };

  const renderStatusIcon = (status) => {
    if (status === 'In Review' || status === 'In Progress') {
      return <Construction size={12} style={{ color: '#ffd60a', marginRight: '3px' }} />;
    }
    return <span className="status-dot" />;
  };

  const getStatusChipClass = (status) => {
    switch (status) {
      case 'Clean': return 'clean';
      case 'In Review': return 'review';
      case 'Blocked': return 'blocked';
      default: return 'review';
    }
  };

  return (
    <div className="dashboard-grid-layout">
      {/* Middle Layout Area: Top Summary Widgets & Invoices Box */}
      <div className="dashboard-middle-column">
        {/* Top Summary Row: Ledger Summary & Pending Seals */}
        <div className="top-summary-grid">
          <LedgerSummaryWidget
            allReviewed={allReviewed}
            onMarkReviewed={handleMarkReviewed}
          />
          <PendingSealsWidget
            seals={seals}
            onSealAll={handleSealAll}
          />
        </div>

        {/* Bottom Middle Area: Filter Options & Add New Invoice + Standard Invoice Scroll List */}
        <GlassCard className="invoices-main-container-card inner-dark-card" style={{ position: 'relative' }}>
          {visualizerStep > 0 && (
            <div className="erp-visualizer-overlay">
              <div className="erp-visualizer-box">
                {visualizerStep >= 1 && <div className="step fade-in"><FileSearch size={24} /> <span>Extracting Invoice Data from <strong>{uploadedFileName}</strong>...</span></div>}
                {visualizerStep >= 2 && <div className="step fade-in success"><Key size={24} /> <span>Matching Key Found: <strong className="font-mono">{demoPoKey}</strong></span></div>}
                {visualizerStep >= 3 && <div className="step fade-in"><Database size={24} /> <span>Querying ERP for Purchase Order & Goods Receipt...</span></div>}
                {visualizerStep >= 4 && <div className="step fade-in highlight"><GitCompare size={24} /> <span>Executing 3-Way Match Stage...</span></div>}
                {visualizerStep < 4 && <div className="spinner-small" style={{ marginTop: '20px' }}></div>}
              </div>
            </div>
          )}

          {showUploadModal && (
            <div className="erp-visualizer-overlay" onClick={() => setShowUploadModal(false)}>
              <div className="erp-visualizer-box" onClick={(e) => e.stopPropagation()} style={{ width: '560px', padding: '30px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ color: '#fff', fontSize: '20px', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <Upload size={20} color="#a7c957" /> Upload & Ingest Invoice
                  </h3>
                  <button style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' }} onClick={() => setShowUploadModal(false)}>✕</button>
                </div>
                
                <p style={{ color: '#9ca3af', fontSize: '13px', margin: '4px 0 16px 0' }}>Select a file from your computer, paste text, or run a sample invoice:</p>

                {/* File picker dropzone */}
                <div style={{ border: '2px dashed rgba(167, 201, 87, 0.4)', borderRadius: '12px', padding: '24px', textAlign: 'center', background: 'rgba(167, 201, 87, 0.05)', marginBottom: '16px' }}>
                  <FileSearch size={32} color="#a7c957" style={{ marginBottom: '8px' }} />
                  <div style={{ color: '#fff', fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>Choose an Invoice File</div>
                  <div style={{ color: '#9ca3af', fontSize: '12px', marginBottom: '12px' }}>Supports .txt, .json, .csv, .md files</div>
                  <input
                    type="file"
                    id="modal-file-input"
                    onChange={handleFileSelected}
                    style={{ display: 'none' }}
                  />
                  <label htmlFor="modal-file-input" className="btn-glass" style={{ background: '#a7c957', color: '#0d0d12', fontWeight: 700, cursor: 'pointer', display: 'inline-flex', padding: '8px 18px' }}>
                    Browse Files
                  </label>
                </div>

                {/* Paste Textarea */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', color: '#e5e7eb', fontSize: '12.5px', fontWeight: 600, marginBottom: '6px' }}>Or Paste Raw Invoice Text:</label>
                  <textarea
                    rows={4}
                    style={{
                      width: '100%',
                      background: 'rgba(0,0,0,0.5)',
                      border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: '10px',
                      color: '#fff',
                      padding: '10px',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      outline: 'none',
                      resize: 'vertical'
                    }}
                    placeholder="INVOICE # 1002&#10;Vendor: Acme Corp&#10;Purchase Order: PO-55102&#10;Line 1: Widget A Qty 10 @ $50.00"
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                  />
                  {pastedText.trim() && (
                    <button className="btn-glass" style={{ background: '#60a5fa', color: '#000', fontWeight: 700, marginTop: '8px', width: '100%', justifyContent: 'center' }} onClick={handlePasteSubmit}>
                      Process Pasted Text
                    </button>
                  )}
                </div>

                {/* Sample Demo button */}
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', color: '#9ca3af' }}>Don't have a file ready?</span>
                  <button className="btn-glass" style={{ fontSize: '12px', padding: '6px 14px' }} onClick={handleUploadDemo}>
                    Run Sample Invoice
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="dashboard-hero-header">
            <h1 className="hero-headline-compact">
              <Shuffle
                key={invoices.length}
                text={`${invoices.length} INVOICES`}
                shuffleDirection="right"
                duration={0.35}
                animationMode="evenodd"
                shuffleTimes={1}
                ease="power3.out"
                stagger={0.03}
                threshold={0.1}
                triggerOnce={true}
                triggerOnHover
                respectReducedMotion={true}
                loop={false}
                loopDelay={0}
              />
              <span className="hero-serif-title">need you</span>
            </h1>

            {/* Filter & Action Bar */}
            <div className="dashboard-filter-bar">
              <div className="filter-inputs-group">
                <select
                  className="filter-select"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="All">Status: All</option>
                  <option value="In Review">Status: In Review</option>
                  <option value="Clean">Status: Clean</option>
                  <option value="Blocked">Status: Blocked</option>
                  <option value="In Progress">Status: In Progress</option>
                </select>

                <select
                  className="filter-select"
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value)}
                >
                  <option value="All">Priority: All</option>
                  <option value="High">Priority: High</option>
                  <option value="Medium">Priority: Medium</option>
                  <option value="Low">Priority: Low</option>
                </select>

                <button className="btn-glass" title="Toggle Filters" style={{ padding: '6px 11px', fontSize: '12px', fontWeight: 600 }}>
                  <Filter size={13} />
                  <span>Filters</span>
                </button>
              </div>

              <button
                className="btn-glass"
                style={{ fontSize: '13px', padding: '8px 18px', fontWeight: 700, background: '#a7c957', color: '#0d0d12', borderColor: 'transparent' }}
                onClick={() => setShowUploadModal(true)}
                disabled={isIngesting}
              >
                <Upload size={15} color="#0d0d12" style={{ marginRight: '4px' }} />
                <span>{isIngesting ? 'Processing…' : 'Upload / Ingest Invoice'}</span>
              </button>

              <SpecularButton
                size="md"
                radius={16}
                baseColor="#232733"
                lineColor="#ffffff"
                tintOpacity={0}
                onClick={handleAddNewInvoice}
              >
                <Plus size={14} />
                <span style={{ fontWeight: 700, fontSize: '12px' }}>New Invoice</span>
              </SpecularButton>
            </div>
          </div>

          {/* Standard Vertical Invoice Scroll List (Internal Overflow-Y Scroll) */}
          <div className="normal-invoice-scroll-list">
            {filteredInvoices.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: '50px', height: '50px', borderRadius: '12px', background: 'rgba(167, 201, 87, 0.1)', border: '1px solid rgba(167, 201, 87, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                  <Inbox size={24} color="#a7c957" />
                </div>
                <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#e5e7eb', marginBottom: '6px' }}>No Invoices in Backlog</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px', maxWidth: '280px', lineHeight: 1.5 }}>
                  Your ledger is clean. Upload a new invoice to kick off the autonomous pipeline.
                </p>
                <button className="btn-glass" style={{ padding: '8px 16px', fontSize: '12px', fontWeight: 600 }} onClick={() => setShowUploadModal(true)}>
                  <Upload size={14} />
                  <span>Upload Document</span>
                </button>
              </div>
            ) : (
              filteredInvoices.map((inv) => {
                const visibleAgents = inv.processedByAgents.slice(0, 3);
                const extraAgentsCount = inv.processedByAgents.length - visibleAgents.length;

                return (
                  <GlassCard key={inv.id} className="invoice-card-condensed inner-dark-card">
                    {/* Row 1: Title, Status Chip & Amount */}
                    <div className="card-row-top">
                      <div className="card-title-group">
                        <span className={`status-chip ${getStatusChipClass(inv.status)}`} style={{ fontSize: '10.5px', padding: '2px 8px' }}>
                          {renderStatusIcon(inv.status)}
                          {inv.status}
                        </span>
                        <span className="invoice-title-text-compact">
                          Invoice #{inv.id} — {inv.vendor}
                        </span>
                      </div>
                      <div className="invoice-amount-compact font-mono">
                        ${inv.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>
                    </div>

                    {/* Row 2: Meta line */}
                    <div className="card-row-meta">
                      <div>
                        <span style={{ fontWeight: 600, color: '#e5e7eb' }}>{inv.terms}</span>
                        <span style={{ margin: '0 6px', color: 'var(--text-dim)' }}>•</span>
                        <span className="font-mono">PO: {inv.poNumber}</span>
                        {inv.riskFlags.length > 0 && (
                          <span style={{ color: '#d00000', marginLeft: '10px', fontSize: '11px', fontWeight: 700 }}>
                            ⚠️ {inv.riskFlags[0]}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                        Received: {inv.receivedDate}
                      </div>
                    </div>

                    {/* Row 3: Progress Track */}
                    <div className="card-row-progress">
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                        <span>Verification Progress</span>
                        <span className="font-mono">{inv.progress}%</span>
                      </div>
                      <div className="progress-bar-track" style={{ height: '5px', background: 'rgba(255, 255, 255, 0.08)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div className="progress-bar-fill" style={{ width: `${inv.progress}%`, height: '100%', background: '#a7c957' }} />
                      </div>
                    </div>

                    {/* Row 4: Agent chips & Action */}
                    <div className="card-row-bottom">
                      <div className="agent-tags-compact">
                        {visibleAgents.map((ag) => (
                          <span key={ag} className="agent-tag-chip-sm">
                            ✓ {ag}
                          </span>
                        ))}
                        {extraAgentsCount > 0 && (
                          <span className="agent-tag-chip-sm" style={{ color: '#a7c957', borderColor: 'rgba(167, 201, 87, 0.3)' }}>
                            +{extraAgentsCount} more
                          </span>
                        )}
                      </div>

                      <button
                        className="btn-glass"
                        style={{ fontSize: '11.5px', padding: '5px 12px', fontWeight: 600 }}
                        onClick={() => onSelectInvoice(inv)}
                      >
                        <span>View Swimlane</span>
                        <ArrowRight size={12} />
                      </button>
                    </div>
                  </GlassCard>
                );
              })
            )}
          </div>
        </GlassCard>
      </div>

      {/* Right Column: PixelTransition Showcase Card & Activity Logs */}
      <div className="dashboard-right-column">
        {/* Top Right: PixelTransition Showcase Card */}
        <GlassCard className="pixel-card-wrapper inner-dark-card" style={{ padding: '0', overflow: 'hidden' }}>
          <PixelTransition
            firstContent={
              <img
                src="/ai_network.png"
                alt="AI Neural Network Data Ledger"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            }
            secondContent={
              <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', backgroundColor: '#090d18', padding: '16px', boxSizing: 'border-box' }}>
                <p style={{ fontWeight: 900, fontSize: '1.35rem', color: '#a7c957', textAlign: 'center', margin: 0, letterSpacing: '-0.5px' }}>
                  Chain Verified ✓
                </p>
              </div>
            }
            gridSize={8}
            pixelColor="#a7c957"
            animationStepDuration={0.4}
            style={{ height: '160px' }}
          />
        </GlassCard>

        {/* Bottom Right: Activity Logs */}
        <ActivityWidget onNavigateToInvoices={() => { }} />
      </div>
    </div>
  );
};

export default Dashboard;

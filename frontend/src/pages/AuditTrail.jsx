import React, { useState, useEffect, useRef } from 'react';
import GlassCard from '../components/GlassCard';
import {
  ShieldCheck,
  CheckCircle2,
  Construction,
  FileSearch,
  Tag,
  Check,
  CheckSquare,
  Paperclip,
  FileText
} from 'lucide-react';
import { api } from '../services/api';
import './AuditTrail.css';

const AuditTrail = () => {
  const [requests, setRequests] = useState([]);
  const [evidenceRecords, setEvidenceRecords] = useState([]);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [tieOutFilter, setTieOutFilter] = useState('All');
  const [tagFilter, setTagFilter] = useState('All');
  const [minAmountFilter, setMinAmountFilter] = useState(0);
  const [evidenceFiles, setEvidenceFiles] = useState([]);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [chainVerified, setChainVerified] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = () => {
      api.getPbcRequests().then((data) => {
        if (cancelled || !data) return;
        setRequests(data);
        if (data.length > 0) setSelectedRequestId((current) => current ?? data[0].request_id);
      });
      api.getEvidenceRecords().then((data) => { if (!cancelled && data) setEvidenceRecords(data); });
      api.verifyChain().then((data) => { if (!cancelled && data) setChainVerified(data.valid); });
    };
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!selectedRequestId) return;
    api.getEvidenceFiles(selectedRequestId).then((data) => setEvidenceFiles(data ?? []));
  }, [selectedRequestId]);

  const handleAttachFileClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !selectedRequestId) return;

    setIsUploadingFile(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const contentBase64 = dataUrl.split(',')[1] ?? '';
      const result = await api.uploadEvidenceFile(selectedRequestId, file.name, contentBase64, file.type);
      if (result?.success) {
        const files = await api.getEvidenceFiles(selectedRequestId);
        setEvidenceFiles(files ?? []);
      } else {
        alert(`Could not attach "${file.name}" — the backend did not confirm it.`);
      }
    } catch (err) {
      alert(`Could not read "${file.name}": ${err.message}`);
    } finally {
      setIsUploadingFile(false);
    }
  };

  const selectedRequest = requests.find(r => r.request_id === selectedRequestId) || requests[0] || {};

  // Pull EvidenceRecords for selected PBC Request & apply structured filters (Item 1b, 1e)
  const matchingEvidence = evidenceRecords.filter((ev) => {
    if (ev.request_id !== selectedRequestId) return false;
    if (tieOutFilter !== 'All' && ev.tie_out_status !== tieOutFilter) return false;
    if (tagFilter !== 'All' && !ev.control_objective_tags?.includes(tagFilter)) return false;
    if (minAmountFilter > 0 && ev.amount < minAmountFilter) return false;
    return true;
  });

  const handleCloseRequest = async (reqId) => {
    const result = await api.closePbcRequest(reqId);
    if (result?.success) {
      setRequests(prev => prev.map(r => r.request_id === reqId ? { ...r, status: 'closed' } : r));
      alert(`PBC Request #${reqId} closed.`);
    } else {
      alert(`Could not close PBC Request #${reqId}.`);
    }
  };

  const handleCreateRequest = async () => {
    const description = window.prompt('What is this auditor request for?', 'Q4 Vendor Invoice Sample');
    if (!description) return;
    const requestedBy = window.prompt('Requested by (auditor / team name):', 'Internal Audit') || 'Internal Audit';

    const result = await api.createPbcRequest({ description, requestedBy, itemType: 'invoice_bundle' });
    if (result?.success && result.id) {
      const fresh = await api.getPbcRequests();
      if (fresh) setRequests(fresh);
      setSelectedRequestId(result.id);
      alert(`Created PBC Request #${result.id}.`);
    } else {
      alert('Could not create the request — the backend did not confirm it.');
    }
  };

  const getTieOutChip = (status) => {
    if (status === 'discrepant') {
      return (
        <span className="status-chip blocked font-mono" style={{ fontSize: '11px' }}>
          <Construction size={13} color="#ffd60a" />
          Discrepant Flag ⚠️
        </span>
      );
    }
    return (
      <span className="status-chip clean font-mono" style={{ fontSize: '11px' }}>
        <CheckCircle2 size={13} color="#a7c957" />
        Tie-Out Matched ✓
      </span>
    );
  };

  return (
    <div className="pbc-tracker-container">
      {/* 1. Header Card */}
      <GlassCard className="pbc-header-card inner-dark-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ShieldCheck size={26} color="#a7c957" />
              Audit Support & PBC Request Tracker
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Provided-By-Client auditor request fulfillment, EvidenceRecord tie-out verification, & control objectives
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span className="status-chip review font-mono" style={{ padding: '6px 12px' }}>
              <Construction size={13} color="#ffd60a" />
              {requests.filter(r => r.status !== 'closed').length} PBC Requests Active
            </span>
            <span className={`status-chip ${chainVerified === false ? 'blocked' : 'clean'} font-mono`} style={{ padding: '6px 12px' }}>
              {chainVerified === null ? 'Checking chain…' : chainVerified ? 'Hash Chain Verified ✓' : 'Chain Integrity Broken ⚠️'}
            </span>
            <button className="btn-primary" style={{ fontSize: '12.5px', padding: '8px 14px' }} onClick={handleCreateRequest}>
              <span>+ New PBC Request</span>
            </button>
          </div>
        </div>
      </GlassCard>

      {/* 2. Top PBC Request Selection Cards Grid (Item 1a) */}
      <div className="pbc-requests-grid">
        {requests.map((req) => {
          const isSelected = req.request_id === selectedRequestId;
          return (
            <GlassCard
              key={req.request_id}
              className={`pbc-request-card inner-dark-card ${isSelected ? 'selected' : ''}`}
              onClick={() => setSelectedRequestId(req.request_id)}
            >
              <div className="request-card-top">
                <span className="request-id font-mono">{req.request_id}</span>
                <span className={`status-chip ${req.status === 'closed' ? 'clean' : req.status === 'in_progress' ? 'review' : 'review'}`} style={{ fontSize: '10px', padding: '2px 7px' }}>
                  {req.status === 'closed' ? 'Closed' : req.status === 'in_progress' ? 'In Progress' : 'Open'}
                </span>
              </div>

              <div className="request-description">{req.description}</div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px' }}>
                <span className="request-meta">{req.requested_by}</span>
                {getTieOutChip(req.tie_out_status)}
              </div>
            </GlassCard>
          );
        })}
      </div>

      {/* 3. Evidence Records Result Panel for Selected PBC Request (Item 1b, 1c, 1d, 1e) */}
      <GlassCard className="evidence-section-card inner-dark-card">
        {/* Header & Close Request Action */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '14px' }}>
          <div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FileSearch size={18} color="#a7c957" />
              Evidence Records: {selectedRequest.request_id}
            </h3>
            <p style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
              {selectedRequest.description} — Requested by <strong>{selectedRequest.requested_by}</strong> ({selectedRequest.date_requested})
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={handleFileSelected}
            />
            <button
              className="btn-glass"
              style={{ fontSize: '12.5px', padding: '8px 14px' }}
              onClick={handleAttachFileClick}
              disabled={isUploadingFile}
            >
              <Paperclip size={14} />
              <span>{isUploadingFile ? 'Uploading…' : 'Attach Audit File'}</span>
            </button>

            {selectedRequest.status !== 'closed' ? (
              <button
                className="btn-primary"
                onClick={() => handleCloseRequest(selectedRequest.request_id)}
              >
                <CheckSquare size={14} />
                <span>Close Request ({selectedRequest.request_id})</span>
              </button>
            ) : (
              <span className="status-chip clean" style={{ fontSize: '12px', padding: '6px 14px' }}>
                <Check size={13} color="#a7c957" />
                Request Verified & Closed
              </span>
            )}
          </div>
        </div>

        {evidenceFiles.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '-4px' }}>
            {evidenceFiles.map((f) => (
              <span
                key={f.id}
                className="status-chip review font-mono"
                style={{ fontSize: '11px', padding: '4px 10px' }}
                title={`Uploaded ${f.uploadedAt} by ${f.uploadedBy}`}
              >
                <FileText size={12} />
                {f.filename}
              </span>
            ))}
          </div>
        )}

        {/* Structured Query Filters over EvidenceRecord schema (Item 1e) */}
        <div className="pbc-filter-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>Filter Tie-Out:</span>
            <select 
              className="filter-select"
              value={tieOutFilter}
              onChange={(e) => setTieOutFilter(e.target.value)}
            >
              <option value="All">Tie-Out: All</option>
              <option value="matched">Matched Only</option>
              <option value="discrepant">Discrepant Only</option>
            </select>

            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, marginLeft: '8px' }}>Control Objective:</span>
            <select 
              className="filter-select"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            >
              <option value="All">Tag: All Objectives</option>
              <option value="FIN-302">FIN-302 (Financial Accuracy)</option>
              <option value="TAX-401">TAX-401 (Tax Compliance)</option>
              <option value="FRAUD-901">FRAUD-901 (Anti-Fraud Routing)</option>
              <option value="COMP-204">COMP-204 (PO Matching)</option>
              <option value="DUPL-101">DUPL-101 (Ledger Deduplication)</option>
              <option value="AUTH-202">AUTH-202 (Authorization)</option>
            </select>

            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, marginLeft: '8px' }}>Min Amount:</span>
            <select 
              className="filter-select"
              value={minAmountFilter}
              onChange={(e) => setMinAmountFilter(Number(e.target.value))}
            >
              <option value={0}>Min Amount: All</option>
              <option value={10000}>Min Amount: &gt;$10,000</option>
              <option value={30000}>Min Amount: &gt;$30,000</option>
            </select>
          </div>

          <span style={{ fontSize: '12px', color: 'var(--text-dim)', fontWeight: 600 }}>
            Showing {matchingEvidence.length} matching EvidenceRecords
          </span>
        </div>

        {/* Evidence Records List */}
        <div className="evidence-list">
          {matchingEvidence.length > 0 ? (
            matchingEvidence.map((ev) => {
              const isDiscrepant = ev.tie_out_status === 'discrepant';
              return (
                <div 
                  key={ev.evidence_id} 
                  className={`evidence-item-row ${isDiscrepant ? 'discrepant-flagged' : ''}`}
                >
                  <div className="evidence-row-header">
                    <div className="evidence-vendor-group">
                      <span className="evidence-invoice-id font-mono">
                        Invoice #{ev.invoice_id}
                      </span>
                      <span style={{ color: 'var(--text-dim)' }}>•</span>
                      <span className="evidence-vendor-name">{ev.vendor}</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                      <div className="evidence-amount font-mono">
                        ${ev.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </div>

                      {/* Item 1c: Discrepant records flagged with red (#d00000) and barrier icon */}
                      {isDiscrepant ? (
                        <span className="status-chip blocked font-mono">
                          <Construction size={14} color="#ffd60a" />
                          Tie-Out Discrepant ⚠️
                        </span>
                      ) : (
                        <span className="status-chip clean font-mono">
                          <CheckCircle2 size={14} color="#a7c957" />
                          Tie-Out Matched ✓
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Discrepancy Reason Banner (if discrepant) */}
                  {isDiscrepant && (
                    <div className="discrepancy-reason-box">
                      <Construction size={14} color="#ffd60a" />
                      <span>DISCREPANCY DETECTED: {ev.discrepancy_reason}</span>
                    </div>
                  )}

                  {/* Control Objective Tags (Item 1b) */}
                  <div className="tags-list-row">
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Tag size={11} />
                      Control Objectives:
                    </span>
                    {ev.control_objective_tags.map(tag => (
                      <span key={tag} className="control-tag-chip font-mono">
                        {tag}
                      </span>
                    ))}

                    <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                      {ev.agent_attestations.map(ag => (
                        <span key={ag} style={{ fontSize: '10.5px', color: '#e5e7eb', background: 'rgba(255,255,255,0.06)', padding: '2px 7px', borderRadius: '4px' }}>
                          ✓ {ag}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Merkle Attestation Hash Foot */}
                  <div className="evidence-hash-foot">
                    <span className="font-mono">Merkle Proof: {ev.attestation_hash}</span>
                    <span>Evidence ID: {ev.evidence_id}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
              No EvidenceRecords match the active filters for this PBC request.
            </div>
          )}
        </div>
      </GlassCard>
    </div>
  );
};

export default AuditTrail;

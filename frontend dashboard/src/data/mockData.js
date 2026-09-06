/**
 * Open Ledger Data Interfaces & Seed Datasets
 * Default mock data used for local standalone testing and as fallback
 * when backend API (http://localhost:5000/api) is offline.
 */

// 1. Invoices Stream (/api/invoices)
export const mockInvoices = [
  {
    id: 'INV-2024-0847',
    vendor: 'Acme Corp',
    vendorLogo: 'AC',
    amount: 12450.00,
    currency: 'USD',
    terms: 'Net 30',
    poNumber: 'PO-2024-1138',
    status: 'In Review', // 'Clean' | 'In Review' | 'Blocked' | 'In Progress'
    priority: 'High',
    receivedDate: '2026-09-04',
    dueDate: '2026-10-04',
    progress: 78,
    taxId: 'US-94820193',
    confidenceScore: 98.6,
    processedByAgents: ['Format Agent', 'Duplicate Agent', 'Compliance Agent'],
    riskFlags: ['Routing Number Verification Pending'],
    hash: '0x38d92a1049581a029e4821a94820194810293847',
    items: [
      { description: 'Cloud GPU Compute Cluster (A100)', qty: 4, rate: 2500.00, amount: 10000.00 },
      { description: 'High-Throughput Storage Allocation', qty: 1, rate: 2450.00, amount: 2450.00 }
    ]
  },
  {
    id: 'INV-2024-0848',
    vendor: 'CyberDyne Systems',
    vendorLogo: 'CS',
    amount: 38200.00,
    currency: 'USD',
    terms: 'Net 15',
    poNumber: 'PO-2024-1142',
    status: 'Clean',
    priority: 'Medium',
    receivedDate: '2026-09-03',
    dueDate: '2026-09-18',
    progress: 100,
    taxId: 'US-88472910',
    confidenceScore: 99.8,
    processedByAgents: ['Format Agent', 'Duplicate Agent', 'Fraud Agent', 'Compliance Agent', 'Manager Agent'],
    riskFlags: [],
    hash: '0x9a82b14c71829e018274a983b271a938c71829a1',
    items: [
      { description: 'Neural Engine Hardware Accelerator', qty: 2, rate: 19100.00, amount: 38200.00 }
    ]
  },
  {
    id: 'INV-2024-0849',
    vendor: 'Global Logistics Hub',
    vendorLogo: 'GL',
    amount: 8900.50,
    currency: 'USD',
    terms: 'Net 30',
    poNumber: 'PO-2024-1145',
    status: 'Blocked',
    priority: 'High',
    receivedDate: '2026-09-02',
    dueDate: '2026-10-02',
    progress: 45,
    taxId: 'US-77192844',
    confidenceScore: 68.5,
    processedByAgents: ['Format Agent', 'Fraud Agent'],
    riskFlags: ['Unwhitelisted Bank Routing Number', 'Amount Discrepancy with PO #1145'],
    hash: '0x7182a938c71829a19a82b14c71829e018274a983',
    items: [
      { description: 'Dedicated Fiber Interconnect Service', qty: 1, rate: 8900.50, amount: 8900.50 }
    ]
  },
  {
    id: 'INV-2024-0850',
    vendor: 'Starlight Telemetry',
    vendorLogo: 'ST',
    amount: 14200.00,
    currency: 'USD',
    terms: 'Net 45',
    poNumber: 'PO-2024-1150',
    status: 'In Progress',
    priority: 'Low',
    receivedDate: '2026-09-05',
    dueDate: '2026-10-20',
    progress: 30,
    taxId: 'US-66192831',
    confidenceScore: 94.2,
    processedByAgents: ['Format Agent'],
    riskFlags: [],
    hash: '0x551928374a983b271a938c71829a19a82b14c718',
    items: [
      { description: 'IoT Edge Sensor Array Maintenance', qty: 10, rate: 1420.00, amount: 14200.00 }
    ]
  },
  {
    id: 'INV-2024-0851',
    vendor: 'Nexus Dynamics',
    vendorLogo: 'ND',
    amount: 15400.00,
    currency: 'USD',
    terms: 'Net 30',
    poNumber: 'PO-2024-1165',
    status: 'In Review',
    priority: 'High',
    receivedDate: '2026-09-06',
    dueDate: '2026-10-06',
    progress: 60,
    taxId: 'US-88192043',
    confidenceScore: 92.5,
    processedByAgents: ['Format Agent', 'Duplicate Agent'],
    riskFlags: ['Line-Item Unit Rate Mismatch'],
    hash: '0x38d92a1049581a029e4821a94820194810293847',
    items: [
      { description: 'Cloud Edge Hosting Cluster', qty: 1, rate: 15400.00, amount: 15400.00 }
    ]
  }
];

// 2. Ledger Summary Metrics (/api/dashboard)
export const mockLedgerSummary = {
  totalValue: 384500.50,
  totalProcessedCount: 17,
  cleanCount: 11,
  reviewCount: 3,
  blockedCount: 3,
  lastSync: 'Just now',
  totalVolumeUSD: 1420850.00,
  stpRate: 94.2,
  correctionsLearned: 42,
  chainVerified: true,
  sealedToday: 14,
  pipelineHealth: 99,
  weeklyVolume: [14, 22, 19, 27, 31, 12, 17]
};

// 3. Pending Seals Feed (/api/audit/seals)
export const mockPendingSeals = [
  {
    id: 'INV-2024-0847',
    vendor: 'Acme Corp',
    amount: 12450.00,
    confidence: 98.6
  },
  {
    id: 'INV-2024-0851',
    vendor: 'Nexus Dynamics',
    amount: 15400.00,
    confidence: 92.5
  }
];

// 4. Ledger Activity Log Feed (/api/activity)
export const mockActivityLogs = [
  {
    id: 'ACT-001',
    timestamp: '2026-09-06T14:32:00Z',
    type: 'SEAL_COMMITTED',
    invoiceId: 'INV-2024-0848',
    vendor: 'CyberDyne Systems',
    amount: 38200.00,
    details: 'Cryptographic SHA-256 Merkle root committed to Block #19,284,019'
  },
  {
    id: 'ACT-002',
    timestamp: '2026-09-06T14:28:15Z',
    type: 'DISCREPANCY_FLAGGED',
    invoiceId: 'INV-2024-0849',
    vendor: 'Global Logistics Hub',
    amount: 8900.50,
    details: 'Fraud Agent flagged unwhitelisted wire routing number'
  },
  {
    id: 'ACT-003',
    timestamp: '2026-09-06T14:15:40Z',
    type: 'INVOICE_INGESTED',
    invoiceId: 'INV-2024-0851',
    vendor: 'Nexus Dynamics',
    amount: 15400.00,
    details: 'OCR Extraction completed with 92.5% confidence'
  }
];

// 5. Autonomous Agent Fleet Registry (/api/agents)
export const mockAgents = [
  {
    id: 'extractor',
    name: 'Format & Extraction Agent',
    role: 'OCR & Line-Item Extraction',
    status: 'Active',
    model: 'gpt-5-nano',
    description: 'Extracts line items, taxes, PO numbers, and vendor details from PDF and scanned invoices with visual OCR.',
    accuracy: 99.6,
    avgSpeed: '320ms',
    totalProcessed: 1420
  },
  {
    id: 'duplicate',
    name: 'Duplicate & Near-Match Agent',
    role: 'Trigram & Vector Search',
    status: 'Active',
    model: 'gpt-5-nano',
    description: 'Scans past subledger entries using cosine similarity and character n-grams to detect duplicate billing attempts.',
    accuracy: 99.8,
    avgSpeed: '180ms',
    totalProcessed: 2840
  },
  {
    id: 'investigator',
    name: 'Investigator Agent',
    role: 'Tool-Calling PO & Receipt Verification',
    status: 'Active',
    model: 'gpt-5-nano',
    description: 'Performs automated 3-way matching between Purchase Orders, ERP Goods Receipts, and vendor line items.',
    accuracy: 97.8,
    avgSpeed: '640ms',
    totalProcessed: 980
  },
  {
    id: 'verifier',
    name: 'Verifier Agent',
    role: 'Second-Opinion Dual Model Verification',
    status: 'Active',
    model: 'glm-4-7-flash',
    description: 'Independent cross-model auditor that validates conclusions of upstream agents to eliminate hallucinations.',
    accuracy: 98.9,
    avgSpeed: '410ms',
    totalProcessed: 1120
  },
  {
    id: 'policy',
    name: 'Policy & Compliance Engine',
    role: 'Tiered Decision Matrix Evaluation',
    status: 'Active',
    model: 'Rule Matrix',
    description: 'Evaluates statutory corporate spending limits, tax exemption validity, and vendor payment authority.',
    accuracy: 100.0,
    avgSpeed: '45ms',
    totalProcessed: 4350
  }
];

// 6. Ecosystem Graph Nodes & Flow Diagram (/api/ecosystem)
export const mockEcosystemNodes = [
  { id: 'n1', label: 'Open Ledger Core', type: 'Core', x: 400, y: 220, color: '#a7c957', details: 'Central orchestration engine running 5 autonomous AI agents.' },
  { id: 'n2', label: 'Acme Corp (Vendor)', type: 'Vendor', x: 160, y: 120, color: '#ffffff', details: 'Primary cloud infrastructure vendor with Net 30 terms.' },
  { id: 'n3', label: 'CyberDyne Systems', type: 'Vendor', x: 160, y: 320, color: '#ffffff', details: 'AI Hardware Accelerator provider.' },
  { id: 'n4', label: 'JP Morgan Treasury', type: 'Bank', x: 640, y: 120, color: '#a7c957', details: 'Automated ACH / Wire settlement portal.' },
  { id: 'n5', label: 'Ethereum L2 Vault', type: 'Blockchain', x: 640, y: 320, color: '#ffd60a', details: 'Immutable Merkle proof and audit seal commit layer.' }
];

export const mockEcosystemConnections = [
  { from: 'n2', to: 'n1', label: 'PDF Invoice Stream' },
  { from: 'n3', to: 'n1', label: 'API Ingestion' },
  { from: 'n1', to: 'n4', label: 'Payment Instruction' },
  { from: 'n1', to: 'n5', label: 'Merkle Hash Commit' }
];

// 7. Audit Support & PBC Requests (/api/pbc/requests)
export const mockPbcRequests = [
  {
    request_id: 'PBC-2026-001',
    description: 'Q3 Cloud Infrastructure & Capital Asset Vendor Invoices Sample',
    requested_by: 'PwC Lead Auditor (E. Vance)',
    date_requested: '2026-09-01',
    status: 'in_progress', // 'open' | 'in_progress' | 'closed'
    tie_out_status: 'matched' // 'matched' | 'discrepant'
  },
  {
    request_id: 'PBC-2026-002',
    description: 'High-Value Disbursements Exceeding $30,000 Threshold',
    requested_by: 'Internal Audit Committee',
    date_requested: '2026-09-03',
    status: 'in_progress',
    tie_out_status: 'matched'
  },
  {
    request_id: 'PBC-2026-003',
    description: 'Vendor Wire Route Alterations & Anti-Fraud Whitelist Audit',
    requested_by: 'SOX Compliance Team',
    date_requested: '2026-09-04',
    status: 'in_progress',
    tie_out_status: 'discrepant'
  },
  {
    request_id: 'PBC-2026-004',
    description: 'Q2 Accrual Clearing & GR/IR Subledger Tie-Out Reconciliation',
    requested_by: 'Corporate Controller',
    date_requested: '2026-08-28',
    status: 'closed',
    tie_out_status: 'matched'
  }
];

// 8. Evidence Records (/api/pbc/evidence)
export const mockEvidenceRecords = [
  {
    evidence_id: 'EV-8842-A',
    request_id: 'PBC-2026-001',
    invoice_id: 'INV-2024-0847',
    vendor: 'Acme Corp',
    amount: 12450.00,
    tie_out_status: 'matched',
    discrepancy_reason: '',
    control_objective_tags: ['FIN-302', 'COMP-204'],
    agent_attestations: ['Format Agent', 'Duplicate Agent', 'Compliance Agent'],
    attestation_hash: '0x7f9a8820c812bb144a10e9f1a238491c'
  },
  {
    evidence_id: 'EV-8842-B',
    request_id: 'PBC-2026-001',
    invoice_id: 'INV-2024-0848',
    vendor: 'CyberDyne Systems',
    amount: 38200.00,
    tie_out_status: 'matched',
    discrepancy_reason: '',
    control_objective_tags: ['FIN-302', 'AUTH-202'],
    agent_attestations: ['Format Agent', 'Fraud Agent', 'Manager Agent'],
    attestation_hash: '0x88b14a29810a92847c1948271849a029'
  },
  {
    evidence_id: 'EV-8842-C',
    request_id: 'PBC-2026-003',
    invoice_id: 'INV-2024-0849',
    vendor: 'Global Logistics Hub',
    amount: 8900.50,
    tie_out_status: 'discrepant',
    discrepancy_reason: 'Wire routing number differs from Master Vendor Agreement registered bank account.',
    control_objective_tags: ['FRAUD-901', 'TAX-401'],
    agent_attestations: ['Format Agent', 'Fraud Agent'],
    attestation_hash: '0x1029384758192a039e4821a948201948'
  },
  {
    evidence_id: 'EV-8842-D',
    request_id: 'PBC-2026-002',
    invoice_id: 'INV-2024-0848',
    vendor: 'CyberDyne Systems',
    amount: 38200.00,
    tie_out_status: 'matched',
    discrepancy_reason: '',
    control_objective_tags: ['AUTH-202', 'FIN-302'],
    agent_attestations: ['Compliance Agent', 'Manager Agent'],
    attestation_hash: '0x99281a029384758192a039e4821a9482'
  }
];

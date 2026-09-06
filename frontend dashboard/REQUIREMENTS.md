# Open Ledger — Backend API Requirements & Integration Guide

This document defines the complete backend API specification, data schemas, endpoint contracts, and instructions for building and connecting the backend to the **Open Ledger** financial agent dashboard frontend.

---

## 1. Quick Overview

- **Frontend Tech**: React 19, Vite, React Router 7, GSAP animations, Lucide icons.
- **Frontend URL**: `http://localhost:5173`
- **Default Backend Port**: `http://localhost:5000`
- **API Base Route**: `/api`
- **Proxy Configuration**: The frontend's `vite.config.js` is already configured to automatically proxy `/api/*` to `http://localhost:5000`. No CORS setup is required if using port `5000`! If using a different port or host (e.g. FastAPI on `8000`), update `VITE_API_BASE_URL` in `.env`.
- **Offline / Graceful Fallback**: The frontend includes `src/services/api.js` which automatically falls back to `src/data/mockData.js` if the backend is temporarily offline or an endpoint is not yet implemented.

---

## 2. API Endpoints Catalog

### 2.1 Invoices (`/api/invoices`)

| Method | Endpoint | Description | Consuming Component |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/invoices` | List invoices with optional filtering & search | `Dashboard.jsx`, `InvoiceQueue.jsx` |
| `GET` | `/api/invoices/:id` | Get single invoice details by ID | `InvoiceDetail.jsx` |
| `POST` | `/api/invoices` | Ingest / create new invoice in ledger | `Dashboard.jsx` ("+ New Invoice") |
| `POST` | `/api/invoices/:id/approve` | Approve invoice for payment | `InvoiceDetail.jsx` ("Approve Invoice") |
| `POST` | `/api/invoices/:id/contest` | Flag invoice as contested for human review | `InvoiceDetail.jsx` ("Contest") |
| `POST` | `/api/invoices/:id/reject` | Reject invoice authorization | `InvoiceDetail.jsx` ("Reject") |
| `POST` | `/api/invoices/:id/seal` | Commit cryptographic Merkle seal for invoice | `InvoiceDetail.jsx` ("Seal Now") |

#### Query Parameters for `GET /api/invoices`:
- `status` (string, optional): `'All'` \| `'Clean'` \| `'In Review'` \| `'Blocked'` \| `'In Progress'`
- `priority` (string, optional): `'All'` \| `'High'` \| `'Medium'` \| `'Low'`
- `search` (string, optional): Text match against `vendor`, `id`, or `poNumber`

#### Invoice Schema (`Invoice`):
```json
{
  "id": "INV-2024-0847",
  "vendor": "Acme Corp",
  "vendorLogo": "AC",
  "amount": 12450.00,
  "currency": "USD",
  "terms": "Net 30",
  "poNumber": "PO-2024-1138",
  "status": "In Review",
  "priority": "High",
  "receivedDate": "2026-09-04",
  "dueDate": "2026-10-04",
  "progress": 78,
  "taxId": "US-94820193",
  "confidenceScore": 98.6,
  "processedByAgents": ["Format Agent", "Duplicate Agent", "Compliance Agent"],
  "riskFlags": ["Routing Number Verification Pending"],
  "hash": "0x38d92a1049581a029e4821a94820194810293847",
  "items": [
    {
      "description": "Cloud GPU Compute Cluster (A100)",
      "qty": 4,
      "rate": 2500.00,
      "amount": 10000.00
    },
    {
      "description": "High-Throughput Storage Allocation",
      "qty": 1,
      "rate": 2450.00,
      "amount": 2450.00
    }
  ]
}
```

---

### 2.2 Ledger Summary & Dashboard Metrics (`/api/dashboard`)

| Method | Endpoint | Description | Consuming Component |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/dashboard` | Returns top-level ledger metrics & weekly activity | `RightPanel.jsx`, `Dashboard.jsx` |
| `POST` | `/api/dashboard/mark-reviewed` | Acknowledge all pending review items | `RightPanel.jsx` ("Mark All Reviewed") |

#### Dashboard Summary Schema (`LedgerSummary`):
```json
{
  "totalValue": 384500.50,
  "totalProcessedCount": 17,
  "cleanCount": 11,
  "reviewCount": 3,
  "blockedCount": 3,
  "lastSync": "Just now",
  "totalVolumeUSD": 1420850.00,
  "stpRate": 94.2,
  "correctionsLearned": 42,
  "chainVerified": true,
  "sealedToday": 14,
  "pipelineHealth": 99,
  "weeklyVolume": [14, 22, 19, 27, 31, 12, 17]
}
```
*Note: `weeklyVolume` is an array of 7 integers representing invoice volumes from Monday through Sunday.*

---

### 2.3 Cryptographic Seals & Audit Ledger (`/api/audit`)

| Method | Endpoint | Description | Consuming Component |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/audit/seals` | Returns invoices pending cryptographic seal commit | `RightPanel.jsx`, `Dashboard.jsx` |
| `POST` | `/api/audit/seal-all` | Batch commit cryptographic seal for all pending seals | `RightPanel.jsx`, `Dashboard.jsx` ("Seal All") |

#### Pending Seal Item Schema:
```json
[
  {
    "id": "INV-2024-0847",
    "vendor": "Acme Corp",
    "amount": 12450.00,
    "confidence": 98.6
  }
]
```

---

### 2.4 Audit Support & PBC Requests (`/api/pbc`)

| Method | Endpoint | Description | Consuming Component |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/pbc/requests` | List auditor Provided-By-Client requests | `AuditTrail.jsx` (Top selector cards) |
| `POST` | `/api/pbc/requests/:id/close` | Mark PBC request as closed & verified | `AuditTrail.jsx` ("Close Request") |
| `GET` | `/api/pbc/evidence` | List granular evidence tie-out records | `AuditTrail.jsx` (Evidence records panel) |

#### Query Parameters for `GET /api/pbc/evidence`:
- `request_id` (string, optional): e.g. `'PBC-2026-001'`
- `tie_out` (string, optional): `'All'` \| `'matched'` \| `'discrepant'`
- `tag` (string, optional): Filter by control objective (e.g. `'FIN-302'`, `'TAX-401'`, `'FRAUD-901'`, `'COMP-204'`, `'AUTH-202'`)
- `min_amount` (number, optional): Minimum invoice amount filter

#### PBC Request Schema:
```json
{
  "request_id": "PBC-2026-001",
  "description": "Q3 Cloud Infrastructure & Capital Asset Vendor Invoices Sample",
  "requested_by": "PwC Lead Auditor (E. Vance)",
  "date_requested": "2026-09-01",
  "status": "in_progress",
  "tie_out_status": "matched"
}
```

#### Evidence Record Schema (`EvidenceRecord`):
```json
{
  "evidence_id": "EV-8842-A",
  "request_id": "PBC-2026-001",
  "invoice_id": "INV-2024-0847",
  "vendor": "Acme Corp",
  "amount": 12450.00,
  "tie_out_status": "matched",
  "discrepancy_reason": "",
  "control_objective_tags": ["FIN-302", "COMP-204"],
  "agent_attestations": ["Format Agent", "Duplicate Agent", "Compliance Agent"],
  "attestation_hash": "0x7f9a8820c812bb144a10e9f1a238491c"
}
```
*Note: If `tie_out_status` is `"discrepant"`, provide a descriptive `discrepancy_reason` explaining the barrier/discrepancy.*

---

### 2.5 Autonomous AI Agent Fleet (`/api/agents`)

| Method | Endpoint | Description | Consuming Component |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/agents` | Fleet status, throughput, accuracy, and model specs | `AgentsPage.jsx` |

#### Agent Schema:
```json
{
  "id": "extractor",
  "name": "Format & Extraction Agent",
  "role": "OCR & Line-Item Extraction",
  "status": "Active",
  "model": "gpt-5-nano",
  "description": "Extracts line items, taxes, PO numbers, and vendor details from PDF and scanned invoices with visual OCR.",
  "accuracy": 99.6,
  "avgSpeed": "320ms",
  "totalProcessed": 1420
}
```

---

### 2.6 Activity Logs & Ecosystem (`/api/activity`, `/api/ecosystem`, `/api/settings`)

| Method | Endpoint | Description | Consuming Component |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/activity` | Live audit events and agent decisions | `RightPanel.jsx` ("Activity Logs") |
| `GET` | `/api/ecosystem` | Network topology nodes & data pipeline links | `EcosystemMap.jsx` |
| `GET` | `/api/settings` | Ledger thresholds, limits & webhook URLs | `SettingsPage.jsx` |
| `PUT` | `/api/settings` | Update configuration settings | `SettingsPage.jsx` |

---

## 3. What To Tell Your LLM (Copy-Paste Master Prompt)

Give the following prompt to your LLM (ChatGPT, Claude, Cursor, Gemini, Copilot, etc.) to generate the complete backend implementation in your preferred framework (Node.js/Express, Python/FastAPI, or Go):

````markdown
You are an expert backend engineer. Please build a production-ready backend API service for the "Open Ledger" Autonomous Accounting Dashboard.

### Tech Stack Recommendation:
Choose either Node.js (Express / Fastify) or Python (FastAPI).
- Enable CORS for `http://localhost:5173`
- Run on `http://localhost:5000` (so Vite's dev proxy automatically forwards all `/api/*` calls)
- Store data in memory (with pre-seeded initial data provided below) or in SQLite.

### Endpoints To Implement:

1. **Invoices**:
   - `GET /api/invoices` (supports query params: `status`, `priority`, `search`)
   - `GET /api/invoices/:id` (returns single invoice by ID)
   - `POST /api/invoices` (adds new invoice to ledger)
   - `POST /api/invoices/:id/approve` (sets status to 'Clean' and generates seal)
   - `POST /api/invoices/:id/contest` (sets status to 'In Review' with contest reason)
   - `POST /api/invoices/:id/reject` (sets status to 'Blocked')
   - `POST /api/invoices/:id/seal` (commits cryptographic seal)

2. **Dashboard & Summary**:
   - `GET /api/dashboard` (returns totalValue, totalProcessedCount, cleanCount, reviewCount, blockedCount, lastSync, weeklyVolume, pipelineHealth, sealedToday)
   - `POST /api/dashboard/mark-reviewed` (acknowledges pending review items)

3. **Cryptographic Seals**:
   - `GET /api/audit/seals` (returns list of pending seals: id, vendor, amount, confidence)
   - `POST /api/audit/seal-all` (clears pending seals and increments sealedToday)

4. **Audit Support & PBC Requests**:
   - `GET /api/pbc/requests` (returns list of auditor PBC requests)
   - `POST /api/pbc/requests/:id/close` (marks request as closed)
   - `GET /api/pbc/evidence` (supports query params: `request_id`, `tie_out`, `tag`, `min_amount`)

5. **Autonomous AI Agents Fleet**:
   - `GET /api/agents` (returns fleet of 5 AI agents with accuracy, latency, and status)

6. **Activity & Ecosystem**:
   - `GET /api/activity` (returns recent ledger activity logs)
   - `GET /api/ecosystem` (returns nodes and links for topology graph)
   - `GET /api/settings` & `PUT /api/settings` (agent confidence thresholds and ERP webhook URLs)

### Initial Seed Data:
Please use the following seed data to populate the server on startup:

```json
{
  "invoices": [
    {
      "id": "INV-2024-0847",
      "vendor": "Acme Corp",
      "vendorLogo": "AC",
      "amount": 12450.00,
      "currency": "USD",
      "terms": "Net 30",
      "poNumber": "PO-2024-1138",
      "status": "In Review",
      "priority": "High",
      "receivedDate": "2026-09-04",
      "dueDate": "2026-10-04",
      "progress": 78,
      "taxId": "US-94820193",
      "confidenceScore": 98.6,
      "processedByAgents": ["Format Agent", "Duplicate Agent", "Compliance Agent"],
      "riskFlags": ["Routing Number Verification Pending"],
      "hash": "0x38d92a1049581a029e4821a94820194810293847",
      "items": [
        { "description": "Cloud GPU Compute Cluster (A100)", "qty": 4, "rate": 2500.00, "amount": 10000.00 },
        { "description": "High-Throughput Storage Allocation", "qty": 1, "rate": 2450.00, "amount": 2450.00 }
      ]
    },
    {
      "id": "INV-2024-0848",
      "vendor": "CyberDyne Systems",
      "vendorLogo": "CS",
      "amount": 38200.00,
      "currency": "USD",
      "terms": "Net 15",
      "poNumber": "PO-2024-1142",
      "status": "Clean",
      "priority": "Medium",
      "receivedDate": "2026-09-03",
      "dueDate": "2026-09-18",
      "progress": 100,
      "taxId": "US-88472910",
      "confidenceScore": 99.8,
      "processedByAgents": ["Format Agent", "Duplicate Agent", "Fraud Agent", "Compliance Agent", "Manager Agent"],
      "riskFlags": [],
      "hash": "0x9a82b14c71829e018274a983b271a938c71829a1",
      "items": [
        { "description": "Neural Engine Hardware Accelerator", "qty": 2, "rate": 19100.00, "amount": 38200.00 }
      ]
    },
    {
      "id": "INV-2024-0849",
      "vendor": "Global Logistics Hub",
      "vendorLogo": "GL",
      "amount": 8900.50,
      "currency": "USD",
      "terms": "Net 30",
      "poNumber": "PO-2024-1145",
      "status": "Blocked",
      "priority": "High",
      "receivedDate": "2026-09-02",
      "dueDate": "2026-10-02",
      "progress": 45,
      "taxId": "US-77192844",
      "confidenceScore": 68.5,
      "processedByAgents": ["Format Agent", "Fraud Agent"],
      "riskFlags": ["Unwhitelisted Bank Routing Number"],
      "hash": "0x7182a938c71829a19a82b14c71829e018274a983",
      "items": [
        { "description": "Dedicated Fiber Interconnect Service", "qty": 1, "rate": 8900.50, "amount": 8900.50 }
      ]
    }
  ],
  "dashboard": {
    "totalValue": 384500.50,
    "totalProcessedCount": 17,
    "cleanCount": 11,
    "reviewCount": 3,
    "blockedCount": 3,
    "lastSync": "Just now",
    "totalVolumeUSD": 1420850.00,
    "stpRate": 94.2,
    "correctionsLearned": 42,
    "chainVerified": true,
    "sealedToday": 14,
    "pipelineHealth": 99,
    "weeklyVolume": [14, 22, 19, 27, 31, 12, 17]
  },
  "seals": [
    {
      "id": "INV-2024-0847",
      "vendor": "Acme Corp",
      "amount": 12450.00,
      "confidence": 98.6
    }
  ],
  "agents": [
    {
      "id": "extractor",
      "name": "Format & Extraction Agent",
      "role": "OCR & Line-Item Extraction",
      "status": "Active",
      "model": "gpt-5-nano",
      "description": "Extracts line items, taxes, PO numbers, and vendor details from PDF and scanned invoices with visual OCR.",
      "accuracy": 99.6,
      "avgSpeed": "320ms",
      "totalProcessed": 1420
    },
    {
      "id": "duplicate",
      "name": "Duplicate & Near-Match Agent",
      "role": "Trigram & Vector Search",
      "status": "Active",
      "model": "gpt-5-nano",
      "description": "Scans past subledger entries using cosine similarity and character n-grams to detect duplicate billing attempts.",
      "accuracy": 99.8,
      "avgSpeed": "180ms",
      "totalProcessed": 2840
    },
    {
      "id": "investigator",
      "name": "Investigator Agent",
      "role": "Tool-Calling PO & Receipt Verification",
      "status": "Active",
      "model": "gpt-5-nano",
      "description": "Performs automated 3-way matching between Purchase Orders, ERP Goods Receipts, and vendor line items.",
      "accuracy": 97.8,
      "avgSpeed": "640ms",
      "totalProcessed": 980
    },
    {
      "id": "verifier",
      "name": "Verifier Agent",
      "role": "Second-Opinion Dual Model Verification",
      "status": "Active",
      "model": "glm-4-7-flash",
      "description": "Independent cross-model auditor that validates conclusions of upstream agents to eliminate hallucinations.",
      "accuracy": 98.9,
      "avgSpeed": "410ms",
      "totalProcessed": 1120
    },
    {
      "id": "policy",
      "name": "Policy & Compliance Engine",
      "role": "Tiered Decision Matrix Evaluation",
      "status": "Active",
      "model": "Rule Matrix",
      "description": "Evaluates statutory corporate spending limits, tax exemption validity, and vendor payment authority.",
      "accuracy": 100.0,
      "avgSpeed": "45ms",
      "totalProcessed": 4350
    }
  ],
  "pbcRequests": [
    {
      "request_id": "PBC-2026-001",
      "description": "Q3 Cloud Infrastructure & Capital Asset Vendor Invoices Sample",
      "requested_by": "PwC Lead Auditor (E. Vance)",
      "date_requested": "2026-09-01",
      "status": "in_progress",
      "tie_out_status": "matched"
    },
    {
      "request_id": "PBC-2026-002",
      "description": "High-Value Disbursements Exceeding $30,000 Threshold",
      "requested_by": "Internal Audit Committee",
      "date_requested": "2026-09-03",
      "status": "in_progress",
      "tie_out_status": "matched"
    }
  ],
  "evidenceRecords": [
    {
      "evidence_id": "EV-8842-A",
      "request_id": "PBC-2026-001",
      "invoice_id": "INV-2024-0847",
      "vendor": "Acme Corp",
      "amount": 12450.00,
      "tie_out_status": "matched",
      "discrepancy_reason": "",
      "control_objective_tags": ["FIN-302", "COMP-204"],
      "agent_attestations": ["Format Agent", "Duplicate Agent", "Compliance Agent"],
      "attestation_hash": "0x7f9a8820c812bb144a10e9f1a238491c"
    }
  ]
}
```

Please write clean, commented code with a single entry point (e.g. `server.js` or `main.py`) that can be executed with `node server.js` or `uvicorn main:app --port 5000`.
````

---

## 4. How To Test The Integration Locally

1. **Start the Backend**:
   Run your backend on port 5000:
   ```bash
   node server.js
   # or
   uvicorn main:app --port 5000 --reload
   ```

2. **Start the Frontend**:
   ```bash
   npm install
   npm run dev
   ```

3. **Verify Connection**:
   Open browser DevTools Network tab. You will see calls to:
   - `GET http://localhost:5173/api/invoices` -> Proxied by Vite to `http://localhost:5000/api/invoices`
   - `GET http://localhost:5173/api/dashboard`
   - `GET http://localhost:5173/api/audit/seals`
   - `GET http://localhost:5173/api/agents`
   - `GET http://localhost:5173/api/pbc/requests`

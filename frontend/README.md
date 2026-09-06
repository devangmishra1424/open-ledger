# Open Ledger — Autonomous Financial Agent & Accounts Payable Operations

A state-of-the-art glassmorphic financial dashboard for autonomous AI agent invoice processing, cryptographic audit seals, 3-way PO matching, and auditor PBC request fulfillment.

---

## 🚀 Quick Start

### 1. Install & Run Frontend
```bash
npm install
npm run dev
```
The dashboard runs at: `http://localhost:5173`

### 2. Connect Live Backend
All backend REST API specifications, endpoint schemas, and a copy-paste prompt for LLMs are documented in **[`REQUIREMENTS.md`](./REQUIREMENTS.md)**.

- **Backend Port**: `http://localhost:5000` (Vite dev server automatically proxies `/api/*` to `http://localhost:5000`, so no CORS configuration is required).
- **Environment**: If your backend runs on a different port or host, create a `.env` file based on `.env.example`:
  ```bash
  VITE_API_BASE_URL=http://localhost:5000/api
  ```
- **Fallback**: If the backend is not running, the frontend automatically falls back to rich sample seed data located in `src/data/mockData.js`.

---

## 📂 Project Architecture

- `src/pages/`:
  - `Dashboard.jsx`: Main financial cockpit with backlog counter, pending seals, and ledger activity.
  - `InvoiceQueue.jsx`: Full accounts payable table with status tabs, search, and progress tracking.
  - `InvoiceDetail.jsx`: Real-time 5-stage autonomous agent execution pipeline with Merkle proof seals and approval actions.
  - `AuditTrail.jsx`: Provided-By-Client (PBC) auditor tracker with tie-out discrepancy flagging.
  - `AgentsPage.jsx`: Autonomous agent fleet registry and accuracy/latency metrics.
  - `EcosystemMap.jsx`: Interactive graph topology connecting vendors, core engine, banking APIs, and blockchain.
  - `SettingsPage.jsx`: Auto-approval thresholds and ERP webhook configuration.
- `src/services/api.js`: Unified API service layer with network calling and mock fallback.
- `src/components/`: Modular glassmorphic UI components, shaders, and animations.
- `REQUIREMENTS.md`: Full endpoint catalog, schemas, and master LLM prompt for backend engineers.

---

## 🛠️ Build & Validate

```bash
npm run build
```

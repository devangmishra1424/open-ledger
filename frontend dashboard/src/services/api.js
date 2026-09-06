/**
 * Open Ledger API Service Layer
 * Interacts with the backend REST endpoints.
 * Automatically falls back to mockData.js if the backend server is unreachable.
 */

import {
  mockInvoices,
  mockLedgerSummary,
  mockPendingSeals,
  mockActivityLogs,
  mockAgents,
  mockPbcRequests,
  mockEvidenceRecords,
  mockEcosystemNodes,
  mockEcosystemConnections
} from '../data/mockData';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

async function request(endpoint, options = {}, fallbackData = null) {
  try {
    const url = `${BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }

    return await res.json();
  } catch (err) {
    // Graceful fallback to mock data when backend is not running or endpoint is 404
    console.warn(`[API] Endpoint "${endpoint}" unreachable (${err.message}). Using local fallback data.`);
    return fallbackData;
  }
}

export const api = {
  // --- Invoices ---
  getInvoices: async (params = {}) => {
    const query = new URLSearchParams(params).toString();
    const endpoint = query ? `/invoices?${query}` : '/invoices';
    return request(endpoint, { method: 'GET' }, mockInvoices);
  },

  getInvoiceById: async (id) => {
    const fallback = mockInvoices.find((inv) => inv.id === id) || mockInvoices[0];
    return request(`/invoices/${id}`, { method: 'GET' }, fallback);
  },

  createInvoice: async (newInvoice) => {
    return request('/invoices', {
      method: 'POST',
      body: JSON.stringify(newInvoice)
    }, newInvoice);
  },

  approveInvoice: async (id) => {
    return request(`/invoices/${id}/approve`, { method: 'POST' }, { success: true, id, status: 'Clean' });
  },

  contestInvoice: async (id, reason = '') => {
    return request(`/invoices/${id}/contest`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }, { success: true, id, status: 'In Review' });
  },

  rejectInvoice: async (id, reason = '') => {
    return request(`/invoices/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }, { success: true, id, status: 'Blocked' });
  },

  sealInvoice: async (id) => {
    return request(`/invoices/${id}/seal`, { method: 'POST' }, { success: true, id, sealed: true });
  },

  // --- Dashboard & Ledger Summary ---
  getDashboardSummary: async () => {
    return request('/dashboard', { method: 'GET' }, mockLedgerSummary);
  },

  markAllReviewed: async () => {
    return request('/dashboard/mark-reviewed', { method: 'POST' }, { success: true });
  },

  // --- Audit & Seals ---
  getPendingSeals: async () => {
    return request('/audit/seals', { method: 'GET' }, mockPendingSeals);
  },

  sealAllInvoices: async () => {
    return request('/audit/seal-all', { method: 'POST' }, { success: true, sealedCount: mockPendingSeals.length });
  },

  getActivityLogs: async () => {
    return request('/activity', { method: 'GET' }, mockActivityLogs);
  },

  // --- PBC Requests & Evidence (Audit Support) ---
  getPbcRequests: async () => {
    return request('/pbc/requests', { method: 'GET' }, mockPbcRequests);
  },

  closePbcRequest: async (requestId) => {
    return request(`/pbc/requests/${requestId}/close`, { method: 'POST' }, { success: true, requestId, status: 'closed' });
  },

  getEvidenceRecords: async (params = {}) => {
    const query = new URLSearchParams(params).toString();
    const endpoint = query ? `/pbc/evidence?${query}` : '/pbc/evidence';
    return request(endpoint, { method: 'GET' }, mockEvidenceRecords);
  },

  // --- Autonomous AI Agents ---
  getAgents: async () => {
    return request('/agents', { method: 'GET' }, mockAgents);
  },

  // --- Ecosystem Topology ---
  getEcosystem: async () => {
    return request('/ecosystem', { method: 'GET' }, {
      nodes: mockEcosystemNodes,
      connections: mockEcosystemConnections
    });
  },

  // --- Settings ---
  getSettings: async () => {
    return request('/settings', { method: 'GET' }, {
      autoApprovalConfidence: 95.0,
      maxAutoPaymentAmount: 50000.00,
      erpWebhookUrl: 'https://api.openledger.io/v2/webhooks/erp'
    });
  },

  updateSettings: async (settings) => {
    return request('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    }, { success: true, ...settings });
  }
};

export default api;

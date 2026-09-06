/**
 * VeriBook API Service Layer
 * Interacts with the backend REST endpoints.
 * Returns a neutral empty fallback if the backend server is unreachable.
 */

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
    // Graceful fallback when the backend is not running or the endpoint is unreachable
    console.warn(`[API] Endpoint "${endpoint}" unreachable (${err.message}). Using empty fallback.`);
    return fallbackData;
  }
}

export const api = {
  // --- Invoices ---
  getInvoices: async (params = {}) => {
    const query = new URLSearchParams(params).toString();
    const endpoint = query ? `/invoices?${query}` : '/invoices';
    return request(endpoint, { method: 'GET' }, []);
  },

  getInvoiceById: async (id) => {
    return request(`/invoices/${id}`, { method: 'GET' }, null);
  },

  createInvoice: async (newInvoice) => {
    return request('/invoices', {
      method: 'POST',
      body: JSON.stringify(newInvoice)
    }, { success: false });
  },

  ingestInvoice: async (rawText, vendorName) => {
    return request('/invoices/ingest', {
      method: 'POST',
      body: JSON.stringify({ rawText, vendorName })
    }, { success: false });
  },

  approveInvoice: async (id) => {
    return request(`/invoices/${id}/approve`, { method: 'POST' }, { success: false, id });
  },

  contestInvoice: async (id, reason = '') => {
    return request(`/invoices/${id}/contest`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }, { success: false, id });
  },

  rejectInvoice: async (id, reason = '') => {
    return request(`/invoices/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }, { success: false, id });
  },

  sealInvoice: async (id) => {
    return request(`/invoices/${id}/seal`, { method: 'POST' }, { success: false, id, sealed: false });
  },

  explainInvoice: async (id, question, decisionId) => {
    return request(`/invoices/${id}/explain`, {
      method: 'POST',
      body: JSON.stringify({ question, decisionId })
    }, { success: false, answer: 'The explain service is unreachable right now.' });
  },

  // --- Dashboard & Ledger Summary ---
  getDashboardSummary: async () => {
    return request('/dashboard', { method: 'GET' }, null);
  },

  markAllReviewed: async () => {
    return request('/dashboard/mark-reviewed', { method: 'POST' }, { success: false });
  },

  // --- Audit & Seals ---
  getPendingSeals: async () => {
    return request('/audit/seals', { method: 'GET' }, []);
  },

  sealAllInvoices: async () => {
    return request('/audit/seal-all', { method: 'POST' }, { success: false, sealedCount: 0 });
  },

  verifyChain: async () => {
    return request('/audit/verify', { method: 'GET' }, { valid: false, checked: 0 });
  },

  getActivityLogs: async () => {
    return request('/activity', { method: 'GET' }, []);
  },

  // --- PBC Requests & Evidence (Audit Support) ---
  getPbcRequests: async () => {
    return request('/pbc/requests', { method: 'GET' }, []);
  },

  createPbcRequest: async ({ description, requestedBy, itemType, dueDate }) => {
    return request('/pbc/requests', {
      method: 'POST',
      body: JSON.stringify({ description, requestedBy, itemType, dueDate })
    }, { success: false });
  },

  closePbcRequest: async (requestId) => {
    return request(`/pbc/requests/${requestId}/close`, { method: 'POST' }, { success: false, requestId });
  },

  getEvidenceRecords: async (params = {}) => {
    const query = new URLSearchParams(params).toString();
    const endpoint = query ? `/pbc/evidence?${query}` : '/pbc/evidence';
    return request(endpoint, { method: 'GET' }, []);
  },

  getEvidenceFiles: async (requestId) => {
    return request(`/pbc/requests/${requestId}/files`, { method: 'GET' }, []);
  },

  uploadEvidenceFile: async (requestId, filename, contentBase64, contentType) => {
    return request(`/pbc/requests/${requestId}/files`, {
      method: 'POST',
      body: JSON.stringify({ filename, contentBase64, contentType })
    }, { success: false });
  },

  // --- Autonomous AI Agents ---
  getAgents: async () => {
    return request('/agents', { method: 'GET' }, []);
  },

  // --- Ecosystem Topology ---
  getEcosystem: async () => {
    return request('/ecosystem', { method: 'GET' }, { nodes: [], connections: [] });
  },

  // --- Settings ---
  getSettings: async () => {
    return request('/settings', { method: 'GET' }, null);
  },

  updateSettings: async (settings) => {
    return request('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    }, { success: false });
  }
};

export default api;

/**
 * VeriBook API client.
 *
 * Every call either returns the parsed JSON body or THROWS an ApiError carrying the HTTP status and
 * the server's own message (the backend always answers errors as { error: string }). There are no
 * silent fallbacks: the previous client turned every failure — a 409 "already approved", a 422, a
 * dead server — into an empty result, so screens could not tell "nothing here" from "something
 * broke" and could never show the reason a button was refused.
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const DEFAULT_TIMEOUT_MS = 30_000;
// The AI steps (re-review, document reading) can legitimately take a while on a rate-limited provider.
const LONG_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * The signed-in session token. Kept in localStorage so a reload does not sign you out; the server
 * sets its expiry (12 hours). Sent as `Authorization: Bearer`, never as a cookie, so another site
 * cannot make the browser send it. Storage can be blocked (private mode): the token then lives in
 * memory for this tab only.
 */
const TOKEN_KEY = 'veribook.session';
let memoryToken = null;

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token) {
  memoryToken = token || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // See above: memoryToken already holds it.
  }
}

/** Fired when the server says the session is missing or expired, so the app can send the person to sign in. */
export const UNAUTHORIZED_EVENT = 'veribook:unauthorized';

async function request(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError(0, 'The server took too long to answer.');
    throw new ApiError(0, 'Could not reach the server. Is the backend running?');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // A non-JSON body on an error is still worth showing (a proxy or host error page); on success it is a bug.
      if (res.ok) throw new ApiError(res.status, 'The server returned something that is not JSON.');
    }
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || data?.message || `${res.status} ${res.statusText}`);
  return data;
}

const qs = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return q ? `?${q}` : '';
};

export const api = {
  // --- Sign-in ---
  getSession: () => request('/auth/session'),
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password } }),

  // --- Invoices ---
  getInvoices: (params = {}) => request(`/invoices${qs(params)}`),
  getInvoiceById: (id) => request(`/invoices/${encodeURIComponent(id)}`),
  createInvoice: (invoice) => request('/invoices', { method: 'POST', body: invoice }),
  ingestInvoice: (rawText, vendorName) => request('/invoices/ingest', { method: 'POST', body: { rawText, vendorName }, timeout: LONG_TIMEOUT_MS }),

  // --- Purchase orders and goods receipts (the other two documents of a three-way match) ---
  getPurchaseOrders: () => request('/purchase-orders?limit=200'),
  createPurchaseOrder: (po) => request('/purchase-orders', { method: 'POST', body: po }),
  parsePurchaseOrder: (rawText) => request('/purchase-orders/parse', { method: 'POST', body: { rawText }, timeout: LONG_TIMEOUT_MS }),
  recordReceipt: (poId, receipt) => request(`/purchase-orders/${encodeURIComponent(poId)}/receipts`, { method: 'POST', body: receipt }),

  // --- Human decisions (reviewerName is required by the server: it is recorded in the hash chain) ---
  approveInvoice: (id, reviewerName, reason) => request(`/invoices/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { reviewerName, reason }, timeout: LONG_TIMEOUT_MS }),
  rejectInvoice: (id, reviewerName, reason) => request(`/invoices/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reviewerName, reason } }),
  contestInvoice: (id, reviewerName, reason) => request(`/invoices/${encodeURIComponent(id)}/contest`, { method: 'POST', body: { reviewerName, reason }, timeout: LONG_TIMEOUT_MS }),

  // --- Vendor bank-change verification ---
  startCallback: (reviewId, reviewerName, phoneNumber) => request(`/reviews/${encodeURIComponent(reviewId)}/callback`, { method: 'POST', body: { reviewerName, phoneNumber } }),
  recordCallbackOutcome: (reviewId, reviewerName, outcome) => request(`/reviews/${encodeURIComponent(reviewId)}/outcome`, { method: 'POST', body: { reviewerName, outcome } }),
  signOffBankChange: (reviewId, reviewerName) => request(`/reviews/${encodeURIComponent(reviewId)}/sign-off`, { method: 'POST', body: { reviewerName } }),

  // --- Explain / integrity ---
  explainInvoice: (id, question, decisionId) => request(`/invoices/${encodeURIComponent(id)}/explain`, { method: 'POST', body: { question, decisionId }, timeout: LONG_TIMEOUT_MS }),
  verifyInvoiceTrail: (id) => request(`/invoices/${encodeURIComponent(id)}/seal`, { method: 'POST' }),
  verifyChain: () => request('/audit/verify'),

  // --- Overview, pipeline, settings, system ---
  getDashboardSummary: () => request('/dashboard'),
  getActivityLogs: () => request('/activity'),
  getAgents: () => request('/agents'),
  getSettings: () => request('/settings'),
  updateSettings: (settings) => request('/settings', { method: 'PUT', body: settings }),
  getSystem: () => request('/system'),
  getEcosystem: () => request('/ecosystem'),

  // --- PBC requests & evidence (audit support) ---
  getPbcRequests: () => request('/pbc/requests'),
  createPbcRequest: ({ description, requestedBy, itemType, dueDate, linkedInvoiceIds }) => request('/pbc/requests', { method: 'POST', body: { description, requestedBy, itemType, dueDate, linkedInvoiceIds } }),
  closePbcRequest: (requestId) => request(`/pbc/requests/${encodeURIComponent(requestId)}/close`, { method: 'POST' }),
  getEvidenceRecords: (params = {}) => request(`/pbc/evidence${qs(params)}`),
  narratePbcRequest: (requestId, question) => request(`/pbc/${encodeURIComponent(requestId)}/narrate`, { method: 'POST', body: { question }, timeout: LONG_TIMEOUT_MS }),
  getEvidenceFiles: (requestId) => request(`/pbc/requests/${encodeURIComponent(requestId)}/files`),
  uploadEvidenceFile: (requestId, filename, contentBase64, contentType) => request(`/pbc/requests/${encodeURIComponent(requestId)}/files`, { method: 'POST', body: { filename, contentBase64, contentType } }),
};

export default api;

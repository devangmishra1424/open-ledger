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
// Reading a scanned or photographed document (OCR) and, when needed, the AI reader: the server allows 300 s.
const DOCUMENT_TIMEOUT_MS = 300_000;

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

/**
 * A file upload (multipart/form-data): same sign-in header, timeout and error handling as request().
 * The browser sets the multipart boundary itself, so no Content-Type is set here.
 */
async function upload(path, form, { timeout = DOCUMENT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body: form, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError(0, 'Reading the document took too long. Try a smaller file or fewer pages.');
    throw new ApiError(0, 'Could not reach the server. Is the backend running?');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ApiError(res.status, 'The server returned something that is not JSON.');
  }
  if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new ApiError(res.status, data?.error || `${res.status} ${res.statusText}`);
  return data;
}

/**
 * A file download: the bytes, not JSON, but with the same sign-in header and error handling as
 * request(). Returns { blob, filename } (the name from the server's Content-Disposition).
 */
async function download(path, { timeout = LONG_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, { headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError(0, 'The server took too long to answer.');
    throw new ApiError(0, 'Could not reach the server. Is the backend running?');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = (await res.json()).error || message; } catch { /* a non-JSON error body: keep the status line */ }
    throw new ApiError(res.status, message);
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
  return { blob: await res.blob(), filename: star ? decodeURIComponent(star) : plain || 'download' };
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

  // --- Documents: read any invoice / PO file (PDF, scan, photo, Word, Excel), check it, then save it ---
  readDocument: (file, purpose = 'invoice') => {
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', file, file.name);
    return upload('/documents/read', form);
  },
  readPastedDocument: (text, purpose = 'invoice') => request('/documents/read', { method: 'POST', body: { text, purpose }, timeout: DOCUMENT_TIMEOUT_MS }),
  getDocument: (id) => request(`/documents/${encodeURIComponent(id)}`),
  /** The original file as a blob (with the sign-in header, so it also works when sign-in is on). */
  getDocumentFile: (id) => download(`/documents/${encodeURIComponent(id)}/file`),
  saveInvoiceFromDocument: (documentId, reviewerName, invoice) => request('/invoices/from-document', { method: 'POST', body: { documentId, reviewerName, invoice }, timeout: LONG_TIMEOUT_MS }),

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
  createPbcRequest: ({ description, requestedBy, itemType, dueDate, linkedInvoiceIds, reviewerName }) => request('/pbc/requests', { method: 'POST', body: { description, requestedBy, itemType, dueDate, linkedInvoiceIds, reviewerName } }),
  closePbcRequest: (requestId, reviewerName) => request(`/pbc/requests/${encodeURIComponent(requestId)}/close`, { method: 'POST', body: { reviewerName } }),
  getEvidenceRecords: (params = {}) => request(`/pbc/evidence${qs(params)}`),
  narratePbcRequest: (requestId, question) => request(`/pbc/${encodeURIComponent(requestId)}/narrate`, { method: 'POST', body: { question }, timeout: LONG_TIMEOUT_MS }),
  getEvidenceFiles: (requestId) => request(`/pbc/requests/${encodeURIComponent(requestId)}/files`),
  uploadEvidenceFile: (requestId, filename, contentBase64, contentType, reviewerName) => request(`/pbc/requests/${encodeURIComponent(requestId)}/files`, { method: 'POST', body: { filename, contentBase64, contentType, reviewerName }, timeout: LONG_TIMEOUT_MS }),
  downloadEvidenceFile: (requestId, fileId) => download(`/pbc/requests/${encodeURIComponent(requestId)}/files/${encodeURIComponent(fileId)}`),
};

export default api;

'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const ACCOUNTS = {
  'Z39427432': 'Individual',
  '263684031': 'ROTH IRA',
  '74509': '401(k)',
};

const SKIP_SYMBOLS = new Set(['SPAXX**', 'SPAXX', '']);
const PENDING_SYMBOLS = new Set(['Pending activity', 'Pending Activity']);

const TAB_TITLES = {
  dashboard: 'Dashboard',
  positions: 'Positions',
  predictions: 'Predictions',
  journal: 'Journal',
  history: 'History',
};

const MONTH_MAP = {
  Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6,
  Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12,
};

// ============================================================
// STATE
// ============================================================
const state = {
  db: {
    position_snapshots: [],
    transactions: [],
    seen_tx_hashes: [],
    predictions: [],
    notes: {},
  },
  prices: { updated_at: null, date: null, prices: {} },
  chartData: { updated_at: null, series: {} },
  settings: { owner: '', repo: '', pat: '' },
  dbSha: null,
  pricesSha: null,
  view: {
    tab: 'dashboard',
    positionTicker: null,  // drill-down ticker in Positions
    posAcct: 'all',        // filter for Positions tab
    histAcct: 'all',       // filter for History tab
    chartAcct: 'all',      // filter for return-index chart
    histFrom: '',
    histTo: '',
  },
  loading: false,
  pendingImport: null,
};

// ============================================================
// UTILITIES
// ============================================================

function fmtMoneyFull(n, showSign = false) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = n < 0 ? '-$' : (showSign && n > 0 ? '+$' : '$');
  return prefix + abs;
}

function fmtPct(n, showSign = true) {
  if (n == null || isNaN(n)) return '—';
  const sign = showSign && n > 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

function colorClass(n) {
  if (n == null || isNaN(n) || n === 0) return 'neutral';
  return n > 0 ? 'positive' : 'negative';
}

function fmtDate(isoStr) {
  if (!isoStr) return '—';
  // isoStr: "2026-05-21"
  const [y, m, d] = isoStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
}

function fmtQty(n) {
  if (n == null || isNaN(n)) return '—';
  return n % 1 === 0 ? n.toString() : n.toFixed(3).replace(/\.?0+$/, '');
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function parseNumeric(str) {
  if (str == null) return null;
  const s = String(str).replace(/[$+%,\s]/g, '').trim();
  if (s === '' || s === '--' || s === 'N/A') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Safe base64 for UTF-8 strings (needed for GitHub API)
function toBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function hashTx(row) {
  const key = [
    (row['Run Date'] || '').trim(),
    (row['Account Number'] || '').trim(),
    (row['Action'] || '').trim(),
    (row['Symbol'] || '').trim(),
    (row['Quantity'] || '').toString().trim(),
    (row['Amount ($)'] || '').toString().trim(),
  ].join('|');
  // djb2 hash
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash) ^ key.charCodeAt(i);
    hash >>>= 0; // keep unsigned
  }
  return hash.toString(36) + '_' + key.length;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================
// SETTINGS
// ============================================================
function loadSettings() {
  const s = localStorage.getItem('pt_settings');
  if (s) {
    try { Object.assign(state.settings, JSON.parse(s)); } catch {}
  }
}

function saveSettings(obj) {
  Object.assign(state.settings, obj);
  localStorage.setItem('pt_settings', JSON.stringify(state.settings));
}

function isConfigured() {
  const { owner, repo, pat } = state.settings;
  return owner && repo && pat;
}

function rawUrl(path) {
  const { owner, repo } = state.settings;
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}?t=${Date.now()}`;
}

// ============================================================
// GITHUB API
// ============================================================
async function ghFetch(path, method = 'GET', body = null) {
  const { owner, repo, pat } = state.settings;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub ${method} ${path}: ${res.status} — ${err.message || ''}`);
  }
  return res.json();
}

async function fetchFileWithSha(path) {
  const data = await ghFetch(path);
  const content = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))));
  return { content, sha: data.sha };
}

async function commitFile(path, content, sha, message) {
  const json = JSON.stringify(content, null, 2) + '\n';
  return ghFetch(path, 'PUT', {
    message,
    content: toBase64(json),
    sha,
  });
}

async function loadFromGitHub() {
  if (!isConfigured()) return;
  try {
    const [dbResult, pricesResult] = await Promise.all([
      fetchFileWithSha('data/db.json'),
      fetchFileWithSha('data/prices.json'),
    ]);
    state.db = dbResult.content;
    state.dbSha = dbResult.sha;
    state.prices = pricesResult.content;
    state.pricesSha = pricesResult.sha;
    // Ensure all required keys
    state.db.position_snapshots = state.db.position_snapshots || [];
    state.db.transactions = state.db.transactions || [];
    state.db.seen_tx_hashes = state.db.seen_tx_hashes || [];
    state.db.predictions = state.db.predictions || [];
    state.db.notes = state.db.notes || {};
    recomputeTransactionTypes();
    recomputeRealizedPnL();
    // chart_data.json is optional — ignore 404
    try {
      const raw = await fetch(rawUrl('data/chart_data.json'));
      if (raw.ok) state.chartData = await raw.json();
    } catch {}
    cacheSave();
  } catch (e) {
    console.warn('GitHub fetch failed:', e.message);
    try {
      const raw = await fetch(rawUrl('data/db.json'));
      if (raw.ok) { state.db = await raw.json(); cacheSave(); }
    } catch {}
    try {
      const raw2 = await fetch(rawUrl('data/prices.json'));
      if (raw2.ok) { state.prices = await raw2.json(); }
    } catch {}
    try {
      const raw3 = await fetch(rawUrl('data/chart_data.json'));
      if (raw3.ok) { state.chartData = await raw3.json(); }
    } catch {}
  }
}

async function saveDB(message) {
  if (!isConfigured()) { showToast('Configure GitHub settings first'); return false; }
  try {
    // Refresh SHA if needed
    if (!state.dbSha) {
      const r = await ghFetch('data/db.json');
      state.dbSha = r.sha;
    }
    const result = await commitFile('data/db.json', state.db, state.dbSha, message || 'data: update db');
    state.dbSha = result.content.sha;
    cacheSave();
    return true;
  } catch (e) {
    showToast('Save failed: ' + e.message);
    console.error(e);
    return false;
  }
}

async function triggerPricesFetch() {
  if (!isConfigured()) { showToast('Configure settings first'); return; }
  const { owner, repo, pat } = state.settings;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/fetch_prices.yml/dispatches`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    }
  );
  if (res.status === 204) showToast('Price fetch triggered ✓');
  else showToast('Trigger failed: ' + res.status);
}

// ============================================================
// LOCAL STORAGE CACHE
// ============================================================
function cacheSave() {
  try {
    localStorage.setItem('pt_db', JSON.stringify(state.db));
    localStorage.setItem('pt_prices', JSON.stringify(state.prices));
  } catch {}
}

function cacheLoad() {
  try {
    const db = localStorage.getItem('pt_db');
    const prices = localStorage.getItem('pt_prices');
    if (db) state.db = JSON.parse(db);
    if (prices) state.prices = JSON.parse(prices);
    recomputeTransactionTypes();
    recomputeRealizedPnL();
  } catch {}
}

// ============================================================
// DATA HELPERS
// ============================================================
function getLatestPositionsByAccount() {
  const byAcct = {};
  for (const snap of state.db.position_snapshots) {
    const acct = snap.account_number;
    if (!byAcct[acct]) byAcct[acct] = [];
    byAcct[acct].push(snap);
  }
  const result = {};
  for (const [acct, snaps] of Object.entries(byAcct)) {
    const latestDate = snaps.reduce((max, s) => (s.date > max ? s.date : max), '');
    result[acct] = snaps.filter(s => s.date === latestDate);
  }
  return result;
}

function getAvgCostBasis(symbol, accountNumber) {
  // Find the most recent avg_cost_basis for this symbol/account from any snapshot
  const snaps = state.db.position_snapshots
    .filter(s => s.symbol === symbol && s.account_number === accountNumber && s.average_cost_basis != null)
    .sort((a, b) => (b.date || '') < (a.date || '') ? -1 : 1);
  return snaps.length ? snaps[0].average_cost_basis : null;
}

function getDashboardData() {
  const byAcct = getLatestPositionsByAccount();
  const ORDER = ['Z39427432', '263684031', '74509'];
  const accountRows = [];
  let totalValue = 0, totalDailyGL = 0, totalUnrealizedGL = 0;

  for (const [acct, positions] of Object.entries(byAcct)) {
    const nonPending = positions.filter(p => !p.is_pending);
    const val  = positions.reduce((s, p) => s + (p.current_value || 0), 0);
    const dgl  = nonPending.reduce((s, p) => s + (p.todays_gain_loss_dollar || 0), 0);
    const ugl  = nonPending.reduce((s, p) => s + (p.total_gain_loss_dollar || 0), 0);

    const txDeposits = state.db.transactions
      .filter(t => t.account_number === acct && t.type === 'deposit' && t.amount > 0)
      .reduce((s, t) => s + (t.amount || 0), 0);
    // 401k fund exchanges lock market gains into cost basis, so transaction deposits
    // undercount. Use snapshot cost_basis_total (= value - unrealized P/L) for 401k only.
    const snapshotCostBasis = nonPending.reduce((s, p) => s + (p.cost_basis_total || 0), 0);
    const deposits = acct === '74509'
      ? (snapshotCostBasis > 0 ? snapshotCostBasis : txDeposits)
      : txDeposits;

    const realizedPnL = state.db.transactions
      .filter(t => t.account_number === acct && t.type === 'sell' && t.realized_pnl != null)
      .reduce((s, t) => s + t.realized_pnl, 0);

    accountRows.push({ acct, name: ACCOUNTS[acct] || acct, value: val, dailyGL: dgl, unrealizedGL: ugl, deposits, realizedPnL });
    totalValue       += val;
    totalDailyGL     += dgl;
    totalUnrealizedGL += ugl;
  }

  accountRows.sort((a, b) => ORDER.indexOf(a.acct) - ORDER.indexOf(b.acct));

  const allDates = Object.values(byAcct).flat().map(s => s.date).filter(Boolean);
  const lastUpdated = allDates.length ? allDates.sort().reverse()[0] : null;

  return { totalValue, totalDailyGL, totalUnrealizedGL, accountRows, lastUpdated };
}

const ACCT_COLORS = {
  'Z39427432': '#4f8ef7',
  '263684031': '#22c993',
  '74509':     '#f5a623',
};

function computeReturnSeries() {
  const snaps = state.db.position_snapshots;
  const dates = [...new Set(snaps.map(s => s.date))].sort();
  if (dates.length === 0) return { dates: [], series: {} };

  const ORDER = ['Z39427432', '263684031', '74509'];
  const accounts = [...new Set(snaps.map(s => s.account_number))]
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  const series = {};
  for (const acct of accounts) {
    const acctSnaps = snaps.filter(s => s.account_number === acct);
    const points = [];
    let prevIndex = 1.0;

    for (const date of dates) {
      const day = acctSnaps.filter(s => s.date === date && !s.is_pending);
      if (day.length === 0) continue;

      const totalGL = day.reduce((s, p) => s + (p.todays_gain_loss_dollar || 0), 0);
      const totalVal = day.reduce((s, p) => s + (p.current_value || 0), 0);
      const prevVal = totalVal - totalGL;

      if (points.length === 0) {
        // anchor first day at 1.0
        points.push({ date, index: 1.0 });
      } else if (prevVal > 0) {
        prevIndex = points[points.length - 1].index * (1 + totalGL / prevVal);
        points.push({ date, index: prevIndex });
      }
    }

    if (points.length > 0) series[acct] = points;
  }

  return { dates, series };
}

function renderReturnChart() {
  const ORDER = ['Z39427432', '263684031', '74509'];

  // Merge: GitHub Actions series (Individual/ROTH IRA via yfinance) +
  // snapshot-based series (401k and any account Actions can't fetch).
  // Actions data wins per account if it has ≥ 2 points.
  const actionsSeries   = (state.chartData && state.chartData.series) || {};
  const snapshotSeries  = computeReturnSeries().series;
  const rawSeries = {};
  const allKnown = new Set([...Object.keys(actionsSeries), ...Object.keys(snapshotSeries)]);
  for (const a of allKnown) {
    const act  = actionsSeries[a]  || [];
    const snap = snapshotSeries[a] || [];
    rawSeries[a] = act.length >= 2 ? act : snap.length >= 2 ? snap : [];
  }

  const allAccts = Object.keys(rawSeries)
    .filter(a => (rawSeries[a] || []).length >= 2)
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  if (allAccts.length === 0) {
    return `
      <div style="padding:12px 16px 0">
        <div class="card" style="padding:14px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px">Return Index</div>
          <div class="text-muted text-sm" style="text-align:center;padding:20px 0 4px">
            Chart appears after next scheduled price fetch (weekdays 9:35 AM &amp; 4:05 PM ET)
          </div>
        </div>
      </div>`;
  }

  // Which accounts to draw
  const filterAcct = state.view.chartAcct || 'all';
  const visibleAccts = filterAcct === 'all' ? allAccts : allAccts.filter(a => a === filterAcct);

  // Account switcher chips
  const chips = [{ id: 'all', label: 'All' }, ...allAccts.map(a => ({ id: a, label: ACCOUNTS[a] || a }))];
  const chipsHTML = chips.map(c =>
    `<button class="filter-chip chart-acct-chip${filterAcct === c.id ? ' active' : ''}"
      data-acct="${c.id}"
      style="padding:3px 10px;font-size:11px;border-radius:14px">${c.label}</button>`
  ).join('');

  // Dates union for visible accounts
  const allDates = [...new Set(visibleAccts.flatMap(a => rawSeries[a].map(p => p.date)))].sort();

  // SVG dimensions
  const W = 340, H = 160;
  const PL = 42, PR = 12, PT = 10, PB = 28;
  const plotW = W - PL - PR, plotH = H - PT - PB;

  const allIdx = visibleAccts.flatMap(a => rawSeries[a].map(p => p.index));
  const minY = Math.min(...allIdx);
  const maxY = Math.max(...allIdx);
  const pad = Math.max((maxY - minY) * 0.18, 0.004);
  const yMin = minY - pad, yMax = maxY + pad;

  const xOf = d => PL + (allDates.indexOf(d) / Math.max(allDates.length - 1, 1)) * plotW;
  const yOf = v => PT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const baseY = yOf(1.0).toFixed(1);

  let paths = '', endDots = '';
  for (const acct of visibleAccts) {
    const pts = rawSeries[acct];
    const color = ACCT_COLORS[acct] || '#888';
    const d = pts.map((p, i) =>
      `${i === 0 ? 'M' : 'L'}${xOf(p.date).toFixed(1)},${yOf(p.index).toFixed(1)}`
    ).join(' ');
    paths += `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = pts[pts.length - 1];
    endDots += `<circle cx="${xOf(last.date).toFixed(1)}" cy="${yOf(last.index).toFixed(1)}" r="3.5" fill="${color}"/>`;
  }

  let xLabels = '';
  const xStep = Math.max(1, Math.ceil(allDates.length / 6));
  for (let i = 0; i < allDates.length; i += xStep) {
    xLabels += `<text x="${xOf(allDates[i]).toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="9" fill="var(--text-muted)">${allDates[i].slice(5)}</text>`;
  }

  let yLabels = '';
  for (const v of [minY + pad * 0.6, 1.0, maxY - pad * 0.6]) {
    const y = yOf(v);
    if (y < PT - 4 || y > PT + plotH + 4) continue;
    yLabels += `<text x="${PL - 4}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="var(--text-muted)">${((v - 1) * 100).toFixed(1)}%</text>`;
  }

  const legend = visibleAccts.map(a => {
    const last = rawSeries[a][rawSeries[a].length - 1];
    const pct = ((last.index - 1) * 100).toFixed(1);
    const sign = last.index >= 1 ? '+' : '';
    const col = last.index >= 1 ? 'var(--positive)' : 'var(--negative)';
    return `<span style="display:inline-flex;align-items:center;gap:3px">
      <svg width="14" height="3" style="vertical-align:middle"><line x1="0" y1="1.5" x2="14" y2="1.5" stroke="${ACCT_COLORS[a]||'#888'}" stroke-width="2"/></svg>
      <span style="font-size:10px;color:var(--text-muted)">${ACCOUNTS[a] || a}</span>
      <span style="font-size:10px;color:${col};font-weight:600">${sign}${pct}%</span>
    </span>`;
  }).join('<span style="margin:0 6px"></span>');

  const updatedAt = state.chartData && state.chartData.updated_at
    ? new Date(state.chartData.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

  return `
    <div style="padding:12px 16px 0">
      <div class="card" style="padding:12px 10px 8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding:0 4px">
          <span style="font-size:13px;font-weight:600">Return Index</span>
          <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">${chipsHTML}</div>
        </div>
        <div style="padding:0 4px 6px;display:flex;flex-wrap:wrap;gap:6px">${legend}</div>
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="overflow:visible;display:block">
          <line x1="${PL}" y1="${baseY}" x2="${(W - PR).toFixed(1)}" y2="${baseY}"
                stroke="var(--border)" stroke-width="1" stroke-dasharray="3,2"/>
          ${paths}${endDots}${xLabels}${yLabels}
        </svg>
        ${updatedAt ? `<div class="text-xs text-muted" style="text-align:right;padding:4px 4px 0">Updated ${updatedAt}</div>` : ''}
      </div>
    </div>`;
}

function getPredictionAccuracy(preds) {
  const verified = preds.filter(p => p.result === 'correct' || p.result === 'wrong');
  const correct = verified.filter(p => p.result === 'correct').length;
  return { total: preds.length, verified: verified.length, correct };
}

// ============================================================
// REALIZED P/L COMPUTATION
// ============================================================
function recomputeRealizedPnL() {
  // Build hash-indexed map for mutation; reset all sell realized_pnl
  const txMap = {};
  for (const tx of state.db.transactions) {
    txMap[tx.hash] = tx;
    if (tx.type === 'sell') tx.realized_pnl = null;
  }

  // Process chronologically for average-cost tracking
  const sorted = [...state.db.transactions].sort((a, b) => a.date.localeCompare(b.date));

  // Average-cost pools: key = `symbol|account_number`
  const pools = {}; // { totalCost: number, totalQty: number }

  for (const tx of sorted) {
    if (!tx.symbol || !tx.account_number) continue;
    const key = `${tx.symbol}|${tx.account_number}`;

    if (tx.type === 'buy' && tx.quantity != null && tx.quantity !== 0) {
      if (!pools[key]) pools[key] = { totalCost: 0, totalQty: 0 };
      const qty = Math.abs(tx.quantity);
      // Use abs(amount) as total cost (captures commissions/fees); fall back to qty * price
      const cost = tx.amount != null ? Math.abs(tx.amount) : qty * (tx.price || 0);
      pools[key].totalCost += cost;
      pools[key].totalQty += qty;

    } else if (tx.type === 'sell' && tx.quantity != null && tx.quantity !== 0 && tx.amount != null) {
      const pool = pools[key];
      if (!pool || pool.totalQty < 0.0001) continue;
      const qty = Math.abs(tx.quantity);
      const avgCost = pool.totalCost / pool.totalQty;
      const costBasis = avgCost * qty;
      // Fidelity sell amounts are positive (proceeds received)
      const proceeds = Math.abs(tx.amount);
      txMap[tx.hash].realized_pnl = proceeds - costBasis;
      pool.totalCost = Math.max(0, pool.totalCost - costBasis);
      pool.totalQty = Math.max(0, pool.totalQty - qty);
    }
  }
}

// ============================================================
// CSV PARSING
// ============================================================
function parseFidelityDate(str) {
  // "May-21-2026" → "2026-05-21"
  // "May 21, 2026" → "2026-05-21"
  if (!str) return null;
  str = str.trim();
  let m;
  m = str.match(/^([A-Za-z]+)-(\d+)-(\d{4})$/);
  if (m) {
    const month = MONTH_MAP[m[1].slice(0,3)];
    if (!month) return null;
    return `${m[3]}-${String(month).padStart(2,'0')}-${String(parseInt(m[2])).padStart(2,'0')}`;
  }
  m = str.match(/^([A-Za-z]+)\s+(\d+),\s*(\d{4})$/);
  if (m) {
    const month = MONTH_MAP[m[1].slice(0,3)];
    if (!month) return null;
    return `${m[3]}-${String(month).padStart(2,'0')}-${String(parseInt(m[2])).padStart(2,'0')}`;
  }
  return null;
}

function parseRunDate(str) {
  // "05/21/2026" → "2026-05-21"
  if (!str) return null;
  const m = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function classifyTx(action) {
  if (!action) return 'other';
  const a = action.toUpperCase();
  if (a.includes('YOU BOUGHT')) return 'buy';
  if (a.includes('YOU SOLD')) return 'sell';
  // intra-account fund exchanges (Exchange In / Exchange Out) are NOT deposits
  if (a.startsWith('EXCHANGE')) return 'exchange';
  if (a.includes('CHANGE IN MARKET VALUE')) return 'other';
  if (a.includes('DIRECT DEPOSIT') || a.includes(' ACH ') || a.includes('TRANSFER') ||
      a.includes('CONTRIBUTION') || a.includes('ROLLOVER') || a.includes('EMPLOYER') ||
      a.includes('PROFIT SHARING') || a.includes('CONVERSION')) return 'deposit';
  if (a.includes('DIVIDEND') || a.includes('REINVESTMENT')) return 'dividend';
  return 'other';
}

// Re-apply classifyTx to all saved transactions using action_raw.
// Needed because type is persisted in db.json and may predate classifier fixes.
function recomputeTransactionTypes() {
  for (const tx of state.db.transactions) {
    if (tx.action_raw) tx.type = classifyTx(tx.action_raw);
  }
}

function isValidAccountNumber(str) {
  // Valid: starts with Z followed by digits, or all digits
  return /^[A-Z]\d+$/.test(str) || /^\d+$/.test(str);
}

function parsePositionsCSV(text) {
  // Find snapshot date from footer before PapaParse strips it
  let snapshotDate = null;
  const dateMatch = text.match(/Date downloaded\s+([A-Za-z]+-\d+-\d{4})/i);
  if (dateMatch) snapshotDate = parseFidelityDate(dateMatch[1]);

  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  });

  const snapshots = [];
  for (const row of parsed.data) {
    const acctNum = (row['Account Number'] || '').trim();
    const symbol = (row['Symbol'] || '').trim();

    // Skip footer rows (non-account lines)
    if (!isValidAccountNumber(acctNum)) continue;
    // Skip money-market sweep
    if (SKIP_SYMBOLS.has(symbol)) continue;
    // Skip if no current value (likely a category header row)
    const cv = parseNumeric(row['Current Value']);
    if (cv == null) continue;

    const isPending = PENDING_SYMBOLS.has(symbol);

    snapshots.push({
      date: snapshotDate,
      account_number: acctNum,
      account_name: (row['Account Name'] || ACCOUNTS[acctNum] || acctNum).trim(),
      symbol: symbol,
      description: (row['Description'] || '').trim(),
      is_pending: isPending,             // unsettled cash — counted in totals, hidden in table
      quantity: isPending ? null : parseNumeric(row['Quantity']),
      last_price: isPending ? null : parseNumeric(row['Last Price']),
      current_value: cv,
      todays_gain_loss_dollar: isPending ? 0 : parseNumeric(row["Today's Gain/Loss Dollar"]),
      todays_gain_loss_pct: isPending ? 0 : parseNumeric(row["Today's Gain/Loss Percent"]),
      total_gain_loss_dollar: isPending ? 0 : parseNumeric(row["Total Gain/Loss Dollar"]),
      total_gain_loss_pct: isPending ? 0 : parseNumeric(row["Total Gain/Loss Percent"]),
      cost_basis_total: isPending ? null : parseNumeric(row['Cost Basis Total']),
      average_cost_basis: isPending ? null : parseNumeric(row['Average Cost Basis']),
    });
  }

  return { date: snapshotDate, positions: snapshots };
}

function parseHistoryCSV(text) {
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: h => h.trim(),
    error: () => {},
  });

  const newTxs = [];
  let dupeCount = 0;
  const seenSet = new Set(state.db.seen_tx_hashes);

  for (const row of parsed.data) {
    // Must have a valid run date
    const runDate = parseRunDate(row['Run Date']);
    if (!runDate) continue;

    const acctNum = (row['Account Number'] || '').trim();
    if (!acctNum) continue;

    const action = (row['Action'] || '').trim();
    const symbol = (row['Symbol'] || '').trim();
    const qty = parseNumeric(row['Quantity']);
    const amount = parseNumeric(row['Amount ($)']);

    const hash = hashTx(row);
    if (seenSet.has(hash)) { dupeCount++; continue; }

    const type = classifyTx(action);

    // Realized PnL for sells
    let realized_pnl = null;
    if (type === 'sell' && symbol && qty != null && amount != null) {
      const avgCost = getAvgCostBasis(symbol, acctNum);
      if (avgCost != null) {
        realized_pnl = amount - avgCost * Math.abs(qty);
      }
    }

    newTxs.push({
      hash,
      date: runDate,
      account_number: acctNum,
      account_name: (row['Account'] || ACCOUNTS[acctNum] || acctNum).trim(),
      action_raw: action,
      type,
      symbol,
      description: (row['Description'] || '').trim(),
      price: parseNumeric(row['Price ($)']),
      quantity: qty,
      commission: parseNumeric(row['Commission ($)']),
      fees: parseNumeric(row['Fees ($)']),
      amount,
      settlement_date: (row['Settlement Date'] || '').trim(),
      realized_pnl,
    });

    seenSet.add(hash);
  }

  return { newTxs, dupeCount };
}

// Detect which CSV type a parsed result is
function detectCSVType(text) {
  const firstLine = text.slice(0, 500);
  if (firstLine.includes('Run Date') && firstLine.includes('Action')) return 'history';
  if (firstLine.includes('Account Name') && firstLine.includes('Last Price')) return 'positions';
  return 'unknown';
}

// ============================================================
// NAVIGATION
// ============================================================
function switchTab(tab) {
  state.view.tab = tab;
  state.view.positionTicker = null;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}

function updateHeader(title, actions = '') {
  document.getElementById('page-title').textContent = title;
  document.getElementById('header-actions').innerHTML = actions;
}

// ============================================================
// TOAST
// ============================================================
let toastTimer;
function showToast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ============================================================
// MODAL
// ============================================================
function showModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function hideModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
}

// ============================================================
// RENDERING
// ============================================================
function render() {
  const { tab } = state.view;
  const content = document.getElementById('main-content');

  switch (tab) {
    case 'dashboard':  renderDashboard(content);  break;
    case 'positions':  renderPositions(content);  break;
    case 'predictions':renderPredictions(content);break;
    case 'journal':    renderJournal(content);     break;
    case 'history':    renderHistory(content);     break;
    default:           renderDashboard(content);
  }
}

// ─── Dashboard ───────────────────────────────────────────────
function renderDashboard(el) {
  updateHeader('Dashboard',
    `<button class="btn-icon" id="btn-settings" title="Settings">⚙</button>`
  );

  const d = getDashboardData();
  const totalDailyPct = d.totalValue > 0 ? (d.totalDailyGL / (d.totalValue - d.totalDailyGL)) * 100 : 0;
  const priceUpdated = state.prices.updated_at
    ? new Date(state.prices.updated_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
    : null;

  el.innerHTML = `
    <div class="total-value">
      <div class="label">Total Portfolio</div>
      <div class="amount">${fmtMoneyFull(d.totalValue)}</div>
      <div class="daily ${colorClass(d.totalDailyGL)}">
        ${fmtMoneyFull(d.totalDailyGL, true)} (${fmtPct(totalDailyPct)}) today
      </div>
    </div>

    <div style="padding:0 16px">
      ${d.accountRows.length === 0 ? `
        <div class="card text-muted text-sm" style="padding:16px;text-align:center">No data — upload a Positions CSV</div>
      ` : d.accountRows.map(a => `
        <div class="card" style="padding:12px 14px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:7px">
              <span style="width:8px;height:8px;border-radius:50%;background:${ACCT_COLORS[a.acct]||'var(--text-muted)'};display:inline-block;flex-shrink:0"></span>
              <span style="font-weight:600;font-size:14px">${a.name}</span>
            </div>
            <span style="font-size:16px;font-weight:700">${fmtMoneyFull(a.value)}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;font-size:13px">
            <div>
              <div class="stat-label" style="margin-bottom:2px">Deposits</div>
              <div>${a.deposits > 0 ? fmtMoneyFull(a.deposits) : '—'}</div>
            </div>
            <div>
              <div class="stat-label" style="margin-bottom:2px">Unrealized P/L</div>
              <div class="${colorClass(a.unrealizedGL)}">${fmtMoneyFull(a.unrealizedGL, true)}</div>
            </div>
            <div>
              <div class="stat-label" style="margin-bottom:2px">Realized P/L</div>
              <div class="${colorClass(a.realizedPnL)}">${a.realizedPnL !== 0 ? fmtMoneyFull(a.realizedPnL, true) : '—'}</div>
            </div>
            <div>
              <div class="stat-label" style="margin-bottom:2px">Today's G/L</div>
              <div class="${colorClass(a.dailyGL)}">${fmtMoneyFull(a.dailyGL, true)}</div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>

    ${renderReturnChart()}

    <div style="padding:8px 16px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px" class="text-muted text-xs">
        <span>Positions as of <strong style="color:var(--text)">${fmtDate(d.lastUpdated)}</strong></span>
        ${priceUpdated ? `<span>Prices: ${priceUpdated}</span>` : ''}
      </div>
      <button class="btn btn-primary" id="btn-upload-dash">⬆ Upload CSV</button>
    </div>
  `;

  document.getElementById('btn-upload-dash').onclick = showImportModal;
  document.getElementById('btn-settings').onclick = showSettingsModal;
  el.querySelectorAll('.chart-acct-chip').forEach(c => {
    c.onclick = () => { state.view.chartAcct = c.dataset.acct; renderDashboard(el); };
  });
}

// ─── Positions ───────────────────────────────────────────────
function renderPositions(el) {
  if (state.view.positionTicker) {
    renderPositionDetail(el, state.view.positionTicker);
    return;
  }

  updateHeader('Positions', `<button class="btn-icon" id="btn-upload-pos" title="Upload">⬆</button>`);

  const byAcct = getLatestPositionsByAccount();
  const allAccts = Object.keys(byAcct);

  // Build filter chips
  const chips = [{ id: 'all', label: 'All' }, ...allAccts.map(a => ({ id: a, label: ACCOUNTS[a] || a }))];
  const filterAcct = state.view.posAcct || 'all';

  let positions = [];
  if (filterAcct === 'all') {
    positions = Object.values(byAcct).flat();
  } else {
    positions = byAcct[filterAcct] || [];
  }
  // Pending-settlement rows are counted in value totals but not shown in the table
  positions = positions.filter(p => !p.is_pending);

  if (allAccts.length === 0) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📊</div>
        <div class="empty-title">No positions yet</div>
        <div class="empty-sub">Upload a Portfolio Positions CSV to get started</div>
      </div>
      <div style="padding:0 16px 16px"><button class="btn btn-primary" id="btn-upload-pos2">⬆ Upload CSV</button></div>
    `;
    el.querySelector('#btn-upload-pos2').onclick = showImportModal;
    document.getElementById('btn-upload-pos').onclick = showImportModal;
    return;
  }

  el.innerHTML = `
    <div class="filter-bar">
      ${chips.map(c => `<button class="filter-chip${filterAcct === c.id ? ' active' : ''}" data-acct="${c.id}">${c.label}</button>`).join('')}
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Value</th>
            <th>Today</th>
            <th>Total G/L</th>
          </tr>
        </thead>
        <tbody>
          ${positions.length === 0 ? `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:24px">No positions</td></tr>` :
            positions.sort((a,b) => (b.current_value||0)-(a.current_value||0)).map(p => `
            <tr data-ticker="${p.symbol}" data-acct="${p.account_number}">
              <td>
                <div class="sym">${p.symbol}</div>
                <div class="sub">${fmtQty(p.quantity)} sh</div>
              </td>
              <td>
                ${fmtMoneyFull(p.current_value)}
                <div class="sub">${p.last_price ? '$' + p.last_price.toFixed(2) : ''}</div>
              </td>
              <td class="${colorClass(p.todays_gain_loss_dollar)}">
                ${fmtMoneyFull(p.todays_gain_loss_dollar, true)}
                <div class="sub">${fmtPct(p.todays_gain_loss_pct)}</div>
              </td>
              <td class="${colorClass(p.total_gain_loss_dollar)}">
                ${fmtMoneyFull(p.total_gain_loss_dollar, true)}
                <div class="sub">${fmtPct(p.total_gain_loss_pct)}</div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  el.querySelectorAll('.filter-chip').forEach(c => {
    c.onclick = () => { state.view.posAcct = c.dataset.acct; renderPositions(el); };
  });

  el.querySelectorAll('tbody tr[data-ticker]').forEach(row => {
    row.onclick = () => {
      state.view.positionTicker = row.dataset.ticker;
      renderPositionDetail(el, row.dataset.ticker);
    };
  });

  document.getElementById('btn-upload-pos').onclick = showImportModal;
}

function renderPositionDetail(el, ticker) {
  updateHeader(ticker,
    `<button class="back-btn" id="btn-back-pos">← Back</button>`
  );

  // Latest price from prices.json
  const priceData = state.prices.prices[ticker];
  const livePrice = priceData ? priceData.close : null;

  // Position data
  const byAcct = getLatestPositionsByAccount();
  const allPos = Object.values(byAcct).flat().filter(p => p.symbol === ticker);

  // Notes for this ticker
  const notes = (state.db.notes[ticker] || []).sort((a,b) => b.date.localeCompare(a.date));

  // Predictions for this ticker
  const preds = state.db.predictions.filter(p => p.ticker === ticker).sort((a,b) => b.prediction_date.localeCompare(a.prediction_date));

  el.innerHTML = `
    <div style="padding:12px 16px 4px">
      ${livePrice ? `<div class="price-badge" style="margin-bottom:8px">$${livePrice.toFixed(2)} <span class="text-muted text-xs">latest close</span></div>` : ''}
      ${allPos.map(p => `
        <div class="card-sm" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between">
            <span>${ACCOUNTS[p.account_number] || p.account_number}</span>
            <span class="fw-700">${fmtMoneyFull(p.current_value)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px" class="text-sm text-muted">
            <span>${fmtQty(p.quantity)} sh @ ${p.average_cost_basis ? '$'+p.average_cost_basis.toFixed(2)+' avg' : '—'}</span>
            <span class="${colorClass(p.total_gain_loss_dollar)}">${fmtMoneyFull(p.total_gain_loss_dollar, true)} (${fmtPct(p.total_gain_loss_pct)})</span>
          </div>
        </div>
      `).join('')}
    </div>

    <div class="section-heading">Predictions</div>
    <div style="padding:0 16px 4px">
      ${preds.length === 0 ? `<div class="text-muted text-sm" style="padding:4px 0">No predictions yet</div>` :
        preds.slice(0, 5).map(p => predCardHTML(p)).join('')}
    </div>

    <div class="section-heading">Notes</div>
    <div style="padding:0 16px 4px">
      ${notes.length === 0 ? `<div class="text-muted text-sm" style="padding:4px 0">No notes yet</div>` :
        notes.map(n => `
          <div class="note-card" data-note-id="${n.id}" data-ticker="${ticker}">
            <div class="note-date">${fmtDate(n.date)}</div>
            <div class="note-text">${escHtml(n.text)}</div>
            ${n.verification ? `<div class="note-verification">↳ ${escHtml(n.verification)}</div>` : ''}
          </div>
        `).join('')}
    </div>
    <div style="height:16px"></div>
  `;

  document.getElementById('btn-back-pos').onclick = () => {
    state.view.positionTicker = null;
    renderPositions(el);
  };

  el.querySelectorAll('.note-card').forEach(card => {
    card.onclick = () => showEditNoteModal(card.dataset.ticker, card.dataset.noteId);
  });

}

// ─── Predictions ─────────────────────────────────────────────
function predCardHTML(p) {
  const dirSymbol = p.direction === 'up' ? '↑' : '↓';
  const dirClass = p.direction === 'up' ? 'direction-up' : 'direction-down';
  const badgeClass = p.result === 'correct' ? 'badge-correct' : p.result === 'wrong' ? 'badge-wrong' : 'badge-pending';
  const badgeLabel = p.result === 'correct' ? '✓ Correct' : p.result === 'wrong' ? '✗ Wrong' : '⏳ Pending';

  const liveP = state.prices.prices[p.ticker];
  const priceStr = p.price_at_prediction ? `$${p.price_at_prediction.toFixed(2)}` : '';

  return `
    <div class="pred-card" data-pred-id="${p.id}">
      <div class="pred-header">
        <div>
          <span class="pred-ticker">${p.ticker}</span>
          <span class="pred-direction ${dirClass}" style="margin-left:8px">${dirSymbol}</span>
        </div>
        <span class="badge ${badgeClass}">${badgeLabel}</span>
      </div>
      <div class="pred-meta">${p.prediction_type} · ${fmtDate(p.prediction_date)} ${priceStr ? '· ' + priceStr : ''}</div>
      ${p.reason ? `<div class="pred-reason">${escHtml(p.reason)}</div>` : ''}
      ${p.actual_open != null ? `
        <div class="text-xs text-muted">Open: $${p.actual_open.toFixed(2)} · Close: ${p.actual_close != null ? '$'+p.actual_close.toFixed(2) : '—'}</div>
      ` : ''}
    </div>
  `;
}

function renderPredictions(el) {
  updateHeader('Predictions', '');

  const preds = [...state.db.predictions].sort((a,b) => b.prediction_date.localeCompare(a.prediction_date));
  const pending = preds.filter(p => !p.result);
  const verified = preds.filter(p => p.result);
  const acc = getPredictionAccuracy(preds);

  el.innerHTML = `
    <div class="accuracy-bar">
      Accuracy: <span>${acc.verified > 0 ? Math.round(acc.correct / acc.verified * 100) + '%' : '—'}</span>
      &nbsp;(${acc.correct}/${acc.verified} verified · ${acc.total} total)
    </div>

    ${pending.length > 0 ? `
      <div class="section-heading">Pending (${pending.length})</div>
      <div style="padding:0 16px">
        ${pending.map(p => predCardHTML(p)).join('')}
      </div>
    ` : ''}

    ${verified.length > 0 ? `
      <div class="section-heading">Verified (${verified.length})</div>
      <div style="padding:0 16px">
        ${verified.map(p => predCardHTML(p)).join('')}
      </div>
    ` : ''}

    ${preds.length === 0 ? `
      <div class="empty">
        <div class="empty-icon">◈</div>
        <div class="empty-title">No predictions yet</div>
        <div class="empty-sub">Tap + to add your first prediction</div>
      </div>
    ` : ''}
    <div style="height:80px"></div>
  `;

  // Attach FAB (floating action button)
  let fab = document.getElementById('fab-new-pred');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'fab-new-pred';
    fab.className = 'fab';
    fab.innerHTML = '+';
    document.body.appendChild(fab);
  }
  fab.style.display = '';
  fab.onclick = showNewPredictionModal;

  // Pred card click → detail (could expand later)
  el.querySelectorAll('.pred-card').forEach(card => {
    card.style.cursor = 'pointer';
  });
}

// ─── Journal ─────────────────────────────────────────────────
function renderJournal(el) {
  updateHeader('Journal', '');

  const notes = state.db.notes; // { ticker: [{id, date, text, verification}] }
  const tickers = Object.keys(notes).filter(t => notes[t].length > 0).sort();

  el.innerHTML = `
    ${tickers.length === 0 ? `
      <div class="empty">
        <div class="empty-icon">✎</div>
        <div class="empty-title">No notes yet</div>
        <div class="empty-sub">Tap + to log your first note</div>
      </div>
    ` : tickers.map(ticker => `
      <div class="note-group">
        <div class="note-ticker-header">${ticker}</div>
        ${[...notes[ticker]].sort((a,b) => b.date.localeCompare(a.date)).map(n => `
          <div class="note-card" data-note-id="${n.id}" data-ticker="${ticker}">
            <div class="note-date">${fmtDate(n.date)}</div>
            <div class="note-text">${escHtml(n.text)}</div>
            ${n.verification ? `<div class="note-verification">↳ ${escHtml(n.verification)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `).join('')}
    <div style="height:80px"></div>
  `;

  let fab = document.getElementById('fab-new-note');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'fab-new-note';
    fab.className = 'fab';
    fab.innerHTML = '+';
    document.body.appendChild(fab);
  }
  fab.style.display = '';
  fab.onclick = () => showNewNoteModal();

  el.querySelectorAll('.note-card').forEach(card => {
    card.onclick = () => showEditNoteModal(card.dataset.ticker, card.dataset.noteId);
  });
}

// ─── History ─────────────────────────────────────────────────
function renderHistory(el) {
  updateHeader('History', '');

  const txs = [...state.db.transactions].sort((a,b) => b.date.localeCompare(a.date));
  const accts = [...new Set(txs.map(t => t.account_number))];
  const { histAcct, histFrom, histTo } = state.view;

  const chips = [{ id: 'all', label: 'All' }, ...accts.map(a => ({ id: a, label: ACCOUNTS[a] || a }))];

  let filtered = txs;
  if (histAcct !== 'all') filtered = filtered.filter(t => t.account_number === histAcct);
  if (histFrom) filtered = filtered.filter(t => t.date >= histFrom);
  if (histTo) filtered = filtered.filter(t => t.date <= histTo);

  const totalDeposits = filtered.filter(t => t.type === 'deposit' && t.amount > 0).reduce((s,t) => s + t.amount, 0);
  const totalRealized = filtered.filter(t => t.type === 'sell' && t.realized_pnl != null).reduce((s,t) => s + t.realized_pnl, 0);

  const txColor = { buy: 'var(--buy)', sell: 'var(--sell)', deposit: 'var(--deposit)', dividend: 'var(--dividend)', other: 'var(--text-muted)' };

  el.innerHTML = `
    <div class="filter-bar">
      ${chips.map(c => `<button class="filter-chip${histAcct === c.id ? ' active' : ''}" data-acct="${c.id}">${c.label}</button>`).join('')}
    </div>
    <div style="padding:0 16px 8px;display:flex;gap:8px">
      <input type="date" id="hist-from" value="${histFrom}" placeholder="From" style="flex:1;font-size:13px;padding:6px 8px">
      <input type="date" id="hist-to" value="${histTo}" placeholder="To" style="flex:1;font-size:13px;padding:6px 8px">
    </div>
    <div style="padding:0 16px 12px;display:flex;gap:16px" class="text-sm">
      <span>Deposits: <strong>${fmtMoneyFull(totalDeposits)}</strong></span>
      <span>Realized P/L: <strong class="${colorClass(totalRealized)}">${fmtMoneyFull(totalRealized, true)}</strong></span>
    </div>

    ${filtered.length === 0 ? `
      <div class="empty"><div class="empty-sub">No transactions</div></div>
    ` : filtered.map(t => `
      <div class="tx-row">
        <div class="tx-dot ${t.type}"></div>
        <div class="tx-body">
          <div class="tx-top">
            <span class="tx-sym">${t.symbol || t.description.slice(0,20) || t.type}</span>
            <span class="tx-amount ${t.amount > 0 ? 'positive' : t.amount < 0 ? 'negative' : ''}">${fmtMoneyFull(t.amount, true)}</span>
          </div>
          <div class="tx-detail">
            ${fmtDate(t.date)} · ${t.type.toUpperCase()}
            ${t.quantity ? ` · ${fmtQty(t.quantity)} sh` : ''}
            ${t.price ? ` @ $${t.price.toFixed(2)}` : ''}
            ${t.realized_pnl != null ? ` · P/L: <span class="${colorClass(t.realized_pnl)}">${fmtMoneyFull(t.realized_pnl, true)}</span>` : ''}
            ${t.fees ? ` · Fee: $${t.fees.toFixed(2)}` : ''}
          </div>
        </div>
      </div>
    `).join('')}
    <div style="height:16px"></div>
  `;

  el.querySelectorAll('.filter-chip').forEach(c => {
    c.onclick = () => { state.view.histAcct = c.dataset.acct; renderHistory(el); };
  });
  el.querySelector('#hist-from').onchange = e => { state.view.histFrom = e.target.value; renderHistory(el); };
  el.querySelector('#hist-to').onchange = e => { state.view.histTo = e.target.value; renderHistory(el); };
}

// ============================================================
// SETTINGS MODAL
// ============================================================
function showSettingsModal() {
  const { owner, repo, pat } = state.settings;
  showModal(`
    <div class="modal-title">Settings</div>

    <div class="settings-section">
      <h3>GitHub Repository</h3>
      <div class="form-group" style="padding:0 0 12px">
        <label class="form-label">Owner (username or org)</label>
        <input type="text" id="s-owner" value="${escHtml(owner)}" placeholder="e.g. skyler">
      </div>
      <div class="form-group" style="padding:0 0 12px">
        <label class="form-label">Repo name</label>
        <input type="text" id="s-repo" value="${escHtml(repo)}" placeholder="e.g. investment-tracker">
      </div>
      <div class="form-group" style="padding:0 0 0">
        <label class="form-label">Personal Access Token (PAT)</label>
        <input type="text" id="s-pat" value="${escHtml(pat)}" placeholder="ghp_…" autocomplete="off" spellcheck="false">
        <div class="text-xs text-muted" style="margin-top:4px">Needs <code>contents:write</code> scope. Stored locally, never committed.</div>
      </div>
    </div>

    <div class="settings-section">
      <h3>Actions</h3>
      <div style="display:flex;flex-direction:column;gap:8px;padding:0">
        <button class="btn btn-secondary" id="s-refresh">↻ Refresh from GitHub</button>
        <button class="btn btn-secondary" id="s-trigger">⚡ Trigger Price Fetch</button>
        <button class="btn btn-secondary" id="s-export">⬇ Export db.json</button>
      </div>
    </div>

    <div class="modal-actions" style="margin-top:8px">
      <button class="btn btn-secondary" style="flex:1" id="s-cancel">Cancel</button>
      <button class="btn btn-primary" style="flex:2" id="s-save">Save</button>
    </div>
  `);

  document.getElementById('s-cancel').onclick = hideModal;
  document.getElementById('s-save').onclick = async () => {
    saveSettings({
      owner: document.getElementById('s-owner').value.trim(),
      repo: document.getElementById('s-repo').value.trim(),
      pat: document.getElementById('s-pat').value.trim(),
    });
    hideModal();
    showToast('Settings saved');
    if (isConfigured()) {
      showToast('Fetching data from GitHub…');
      await loadFromGitHub();
      render();
      showToast('Data refreshed ✓');
    }
  };
  document.getElementById('s-refresh').onclick = async () => {
    showToast('Refreshing…');
    await loadFromGitHub();
    render();
    showToast('Refreshed ✓');
  };
  document.getElementById('s-trigger').onclick = triggerPricesFetch;
  document.getElementById('s-export').onclick = () => {
    const blob = new Blob([JSON.stringify(state.db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'db.json';
    a.click();
  };
}

// ============================================================
// IMPORT / CSV UPLOAD
// ============================================================
function showImportModal() {
  showModal(`
    <div class="modal-title">Import CSV</div>
    <div class="upload-area" id="upload-area">
      <div class="upload-icon">📂</div>
      <p><strong>Tap to select files</strong></p>
      <p>Portfolio Positions and/or Accounts History CSV</p>
    </div>
    <div id="import-status" style="padding:0 16px;color:var(--text-muted);font-size:13px"></div>
    <div id="import-preview" class="import-preview" style="padding:0 16px"></div>
    <div class="modal-actions" style="margin-top:8px">
      <button class="btn btn-secondary" style="flex:1" id="imp-cancel">Cancel</button>
      <button class="btn btn-primary" style="flex:2;opacity:0.4;pointer-events:none" id="imp-confirm">Import</button>
    </div>
  `);

  document.getElementById('imp-cancel').onclick = hideModal;
  document.getElementById('upload-area').onclick = () => document.getElementById('file-input').click();

  // Drag and drop
  const area = document.getElementById('upload-area');
  area.ondragover = e => { e.preventDefault(); area.classList.add('drag-over'); };
  area.ondragleave = () => area.classList.remove('drag-over');
  area.ondrop = e => {
    e.preventDefault();
    area.classList.remove('drag-over');
    processFiles([...e.dataTransfer.files]);
  };
}

// FileReader-based read — works on all browsers including old iOS Safari
// file.text() is not available before Safari 14.1 and hangs silently
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file: ' + file.name));
    reader.readAsText(file, 'utf-8');
  });
}

async function processFiles(files) {
  // Always (re-)open the modal — on mobile the file picker can dismiss it
  showImportModal();
  await new Promise(r => setTimeout(r, 30));

  const statusEl = document.getElementById('import-status');
  const previewEl = document.getElementById('import-preview');
  const confirmBtn = document.getElementById('imp-confirm');

  // Wrap everything so any crash shows as a visible error instead of silent hang
  try {
    // Step 0: check PapaParse loaded
    if (typeof Papa === 'undefined') {
      statusEl.textContent = '❌ PapaParse not loaded — hard-refresh the page (Ctrl+Shift+R)';
      return;
    }

    let positionResult = null;
    let historyResult = null;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      statusEl.textContent = `Reading file ${i + 1}/${files.length}: ${file.name}…`;
      await new Promise(r => setTimeout(r, 0)); // let the UI update

      const text = await readFileText(file);

      statusEl.textContent = `Detecting type: ${file.name}…`;
      await new Promise(r => setTimeout(r, 0));

      const type = detectCSVType(text);

      if (type === 'positions') {
        statusEl.textContent = `Parsing positions…`;
        await new Promise(r => setTimeout(r, 0));
        positionResult = parsePositionsCSV(text);
      } else if (type === 'history') {
        statusEl.textContent = `Parsing history…`;
        await new Promise(r => setTimeout(r, 0));
        historyResult = parseHistoryCSV(text);
      } else {
        statusEl.textContent = `❌ "${file.name}" not recognized — must be a Fidelity Portfolio Positions or Accounts History CSV`;
        return;
      }
    }

    if (!positionResult && !historyResult) {
      statusEl.textContent = '❌ No valid CSV data found.';
      return;
    }

    // Build preview
    statusEl.textContent = '';
    let previewHTML = '';

    if (positionResult) {
      const posCount = positionResult.positions.length;
      const accts = [...new Set(positionResult.positions.map(p => ACCOUNTS[p.account_number] || p.account_number))].join(', ');
      previewHTML += `<div class="preview-item"><span>Positions snapshot</span><span class="positive">${posCount} rows (${fmtDate(positionResult.date)})</span></div>`;
      previewHTML += `<div class="preview-item text-muted text-xs"><span>Accounts</span><span>${accts || 'none detected'}</span></div>`;
    }
    if (historyResult) {
      const { newTxs, dupeCount } = historyResult;
      const byType = newTxs.reduce((acc, t) => { acc[t.type] = (acc[t.type] || 0) + 1; return acc; }, {});
      previewHTML += `<div class="preview-item"><span>New transactions</span><span class="positive">${newTxs.length} added</span></div>`;
      if (dupeCount > 0) previewHTML += `<div class="preview-item text-muted text-xs"><span>Duplicates skipped</span><span>${dupeCount}</span></div>`;
      Object.entries(byType).forEach(([t, count]) => {
        previewHTML += `<div class="preview-item text-muted text-xs"><span style="padding-left:12px">↳ ${t}</span><span>${count}</span></div>`;
      });
    }

    previewEl.innerHTML = previewHTML || '<div class="preview-item text-muted">No new data to import.</div>';
    confirmBtn.style.opacity = '1';
    confirmBtn.style.pointerEvents = '';
    confirmBtn.onclick = () => confirmImport(positionResult, historyResult);

  } catch (err) {
    console.error('processFiles error:', err);
    if (statusEl) statusEl.innerHTML = `❌ Error: ${err.message}<br><small style="color:var(--text-muted)">${err.stack ? err.stack.split('\n')[1] : ''}</small>`;
  }
}

async function confirmImport(positionResult, historyResult) {
  // Show saving state inside the modal before closing
  const confirmBtn = document.getElementById('imp-confirm');
  if (confirmBtn) {
    confirmBtn.textContent = '⏳ Saving to GitHub…';
    confirmBtn.style.opacity = '0.7';
    confirmBtn.style.pointerEvents = 'none';
  }
  await new Promise(r => setTimeout(r, 30)); // let button repaint

  if (positionResult && positionResult.positions.length > 0) {
    // Add all new position rows (they're timestamped so duplicates are OK, but let's avoid exact dupes)
    const existingKeys = new Set(
      state.db.position_snapshots.map(s => `${s.date}|${s.account_number}|${s.symbol}`)
    );
    for (const pos of positionResult.positions) {
      const key = `${pos.date}|${pos.account_number}|${pos.symbol}`;
      if (!existingKeys.has(key)) {
        state.db.position_snapshots.push(pos);
        existingKeys.add(key);
      }
    }
  }

  if (historyResult && historyResult.newTxs.length > 0) {
    for (const tx of historyResult.newTxs) {
      state.db.transactions.push(tx);
      state.db.seen_tx_hashes.push(tx.hash);
    }
  }

  recomputeTransactionTypes();
  recomputeRealizedPnL();
  hideModal();
  const saved = await saveDB('data: import CSV');
  if (saved) {
    showToast('Import saved to GitHub ✓');
  } else {
    cacheSave();
    showToast('Saved locally (GitHub failed — check Settings)');
  }
  render();
}

// ============================================================
// PREDICTION FORMS
// ============================================================
function showNewPredictionModal(prefillTicker = '') {
  // Get known tickers for datalist
  const byAcct = getLatestPositionsByAccount();
  const knownTickers = [...new Set(Object.values(byAcct).flat().map(p => p.symbol))].sort();
  const priceData = prefillTicker && state.prices.prices[prefillTicker];
  const currentPrice = priceData ? priceData.close : null;

  showModal(`
    <div class="modal-title">New Prediction</div>

    <div class="form-group">
      <label class="form-label">Ticker</label>
      <input type="text" id="pred-ticker" value="${escHtml(prefillTicker)}" placeholder="e.g. TQQQ" list="ticker-list" autocapitalize="characters" style="text-transform:uppercase">
      <datalist id="ticker-list">${knownTickers.map(t => `<option value="${t}">`).join('')}</datalist>
    </div>

    <div class="form-group">
      <label class="form-label">Direction</label>
      <div class="seg-control">
        <button class="seg-btn active" data-dir="up">↑ Up</button>
        <button class="seg-btn" data-dir="down">↓ Down</button>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Type</label>
      <div class="seg-control">
        <button class="seg-btn active" data-ptype="intraday">Intraday</button>
        <button class="seg-btn" data-ptype="overnight">Overnight</button>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" id="pred-date" value="${today()}">
    </div>

    <div class="form-group">
      <label class="form-label">Price at Prediction ${currentPrice ? '(auto-filled)' : ''}</label>
      <input type="number" id="pred-price" step="0.01" value="${currentPrice ? currentPrice.toFixed(2) : ''}" placeholder="Current price">
    </div>

    <div class="form-group">
      <label class="form-label">Reason (optional)</label>
      <textarea id="pred-reason" placeholder="Why are you making this prediction?"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn btn-secondary" style="flex:1" id="pred-cancel">Cancel</button>
      <button class="btn btn-primary" style="flex:2" id="pred-save">Add Prediction</button>
    </div>
  `);

  // Direction toggle
  let selectedDir = 'up';
  let selectedType = 'intraday';
  document.querySelectorAll('[data-dir]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('[data-dir]').forEach(b => b.classList.toggle('active', b === btn));
      selectedDir = btn.dataset.dir;
    };
  });
  document.querySelectorAll('[data-ptype]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('[data-ptype]').forEach(b => b.classList.toggle('active', b === btn));
      selectedType = btn.dataset.ptype;
    };
  });

  // Auto-fill price when ticker changes
  document.getElementById('pred-ticker').oninput = e => {
    const t = e.target.value.toUpperCase().trim();
    e.target.value = t;
    const pd = state.prices.prices[t];
    if (pd) document.getElementById('pred-price').value = pd.close.toFixed(2);
  };

  document.getElementById('pred-cancel').onclick = hideModal;
  document.getElementById('pred-save').onclick = async () => {
    const ticker = document.getElementById('pred-ticker').value.toUpperCase().trim();
    if (!ticker) { showToast('Enter a ticker'); return; }
    const prediction = {
      id: generateUUID(),
      created_at: new Date().toISOString(),
      ticker,
      direction: selectedDir,
      prediction_type: selectedType,
      prediction_date: document.getElementById('pred-date').value,
      reason: document.getElementById('pred-reason').value.trim(),
      price_at_prediction: parseFloat(document.getElementById('pred-price').value) || null,
      target_price_open: null,
      target_price_close: null,
      actual_open: null,
      actual_close: null,
      result: null,
      verified_at: null,
      verification_note: '',
    };
    state.db.predictions.push(prediction);
    hideModal();
    const saved = await saveDB(`data: add prediction ${ticker} ${selectedDir}`);
    if (saved) showToast('Prediction saved ✓');
    else { cacheSave(); showToast('Saved locally'); }
    render();
  };
}

// ============================================================
// NOTE FORMS
// ============================================================
function showNewNoteModal(prefillTicker = '') {
  const byAcct = getLatestPositionsByAccount();
  const knownTickers = [...new Set(Object.values(byAcct).flat().map(p => p.symbol))].sort();

  showModal(`
    <div class="modal-title">Add Note</div>

    <div class="form-group">
      <label class="form-label">Ticker</label>
      <input type="text" id="note-ticker" value="${escHtml(prefillTicker)}" placeholder="e.g. TQQQ" list="note-ticker-list" autocapitalize="characters" style="text-transform:uppercase">
      <datalist id="note-ticker-list">${knownTickers.map(t => `<option value="${t}">`).join('')}</datalist>
    </div>

    <div class="form-group">
      <label class="form-label">Date</label>
      <input type="date" id="note-date" value="${today()}">
    </div>

    <div class="form-group">
      <label class="form-label">Note</label>
      <textarea id="note-text" placeholder="Your observation, thesis, or trade rationale…" style="min-height:120px"></textarea>
    </div>

    <div class="modal-actions">
      <button class="btn btn-secondary" style="flex:1" id="note-cancel">Cancel</button>
      <button class="btn btn-primary" style="flex:2" id="note-save">Save Note</button>
    </div>
  `);

  document.getElementById('note-ticker').oninput = e => { e.target.value = e.target.value.toUpperCase(); };
  document.getElementById('note-cancel').onclick = hideModal;
  document.getElementById('note-save').onclick = async () => {
    const ticker = document.getElementById('note-ticker').value.toUpperCase().trim();
    const text = document.getElementById('note-text').value.trim();
    if (!ticker) { showToast('Enter a ticker'); return; }
    if (!text) { showToast('Enter a note'); return; }
    const note = {
      id: generateUUID(),
      created_at: new Date().toISOString(),
      date: document.getElementById('note-date').value,
      text,
      verification: '',
    };
    if (!state.db.notes[ticker]) state.db.notes[ticker] = [];
    state.db.notes[ticker].push(note);
    hideModal();
    const saved = await saveDB(`data: add note ${ticker}`);
    if (saved) showToast('Note saved ✓');
    else { cacheSave(); showToast('Saved locally'); }
    render();
  };
}

function showEditNoteModal(ticker, noteId) {
  const notes = state.db.notes[ticker] || [];
  const note = notes.find(n => n.id === noteId);
  if (!note) return;

  showModal(`
    <div class="modal-title">Note — ${ticker}</div>

    <div style="padding:0 16px 16px">
      <div class="text-muted text-xs" style="margin-bottom:6px">${fmtDate(note.date)}</div>
      <div style="font-size:15px;line-height:1.5;margin-bottom:16px">${escHtml(note.text)}</div>

      <label class="form-label">Verification / Follow-up</label>
      <textarea id="note-verif" placeholder="How did this play out?" style="min-height:80px">${escHtml(note.verification || '')}</textarea>
    </div>

    <div class="modal-actions">
      <button class="btn btn-danger" style="flex:1" id="note-delete">Delete</button>
      <button class="btn btn-primary" style="flex:2" id="note-update">Update</button>
    </div>
  `);

  document.getElementById('note-update').onclick = async () => {
    note.verification = document.getElementById('note-verif').value.trim();
    hideModal();
    const saved = await saveDB(`data: update note ${ticker}`);
    if (saved) showToast('Note updated ✓');
    else { cacheSave(); showToast('Saved locally'); }
    render();
  };

  document.getElementById('note-delete').onclick = async () => {
    state.db.notes[ticker] = notes.filter(n => n.id !== noteId);
    if (state.db.notes[ticker].length === 0) delete state.db.notes[ticker];
    hideModal();
    const saved = await saveDB(`data: delete note ${ticker}`);
    if (saved) showToast('Note deleted');
    else { cacheSave(); showToast('Saved locally'); }
    render();
  };
}

// ============================================================
// HELPERS
// ============================================================
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hideFABs() {
  ['fab-new-pred', 'fab-new-note'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// ============================================================
// THEME
// ============================================================
function applyTheme(theme) {
  document.body.classList.toggle('theme-light', theme === 'light');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀';
}

function toggleTheme() {
  const isLight = document.body.classList.contains('theme-light');
  const next = isLight ? 'dark' : 'light';
  localStorage.setItem('pt_theme', next);
  applyTheme(next);
}

// ============================================================
// EVENT HANDLERS
// ============================================================
function setupEventListeners() {
  // Bottom nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      hideFABs();
      switchTab(btn.dataset.tab);
    };
  });

  // File input
  document.getElementById('file-input').onchange = e => {
    const files = [...e.target.files];
    e.target.value = ''; // reset so same file can be re-selected
    if (files.length > 0) processFiles(files);
  };

  // Modal overlay click to close
  document.getElementById('modal-overlay').onclick = e => {
    if (e.target === document.getElementById('modal-overlay')) hideModal();
  };

  // Theme toggle
  document.getElementById('btn-theme').onclick = toggleTheme;
}

// ============================================================
// INIT
// ============================================================
async function init() {
  loadSettings();
  applyTheme(localStorage.getItem('pt_theme') || 'light');
  cacheLoad();

  // Show cached data immediately
  if (state.db.position_snapshots.length > 0 || state.db.transactions.length > 0) {
    document.getElementById('loading-state').style.display = 'none';
    render();
  }

  // Prompt to configure if not set up
  if (!isConfigured()) {
    document.getElementById('loading-state').style.display = 'none';
    render();
    if (!state.db.position_snapshots.length && !state.db.transactions.length) {
      // Show settings hint after brief delay
      setTimeout(() => showToast('⚙ Configure GitHub in Settings to sync data', 4000), 800);
    }
    return;
  }

  // Fetch fresh data from GitHub
  document.getElementById('loading-state').style.display = 'none';
  await loadFromGitHub();
  render();
}

setupEventListeners();
init().catch(console.error);

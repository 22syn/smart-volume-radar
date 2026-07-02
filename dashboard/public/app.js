/**
 * Lean Radar Dashboard — app.js
 * Vanilla JS, no framework. RTL Hebrew UI.
 * Depends on: Chart.js (CDN), styles.css
 */

'use strict';

/* ─── Constants ──────────────────────────────────────────────────────────── */

const SIGNAL_META = {
  breakout:     { label: 'Breakout',     icon: '🎯', cls: 'breakout' },
  highVolume:   { label: 'High Volume',  icon: '🔥', cls: 'highVolume' },
  pullback:     { label: 'Pullback',     icon: '📉', cls: 'pullback' },
  nearBreakout: { label: 'Near Break',   icon: '⏳', cls: 'near' },
  nearHighVol:  { label: 'Near HiVol',   icon: '⏳', cls: 'near' },
  nearPullback: { label: 'Near Pull',    icon: '⏳', cls: 'near' },
};

/** Table column definitions: [key, hebrewLabel, cssClass] */
const COLS = [
  ['ticker',    'טיקר',      'col-ticker'],
  ['region',    'אזור',      'col-region'],
  ['sector',    'סקטור',     'col-sector'],
  ['signals',   'סיגנלים',   'col-signals'],
  ['rvol',      'RVOL',      'col-mono'],
  ['ath_pct',   'ATH%',      'col-mono'],
  ['day_pct',   'יום%',      'col-mono'],
  ['stage2',    'S2',        'col-mono'],
  ['score',     'Score',     'col-score'],
  ['price',     'מחיר',      'col-mono'],
];

const SCORE_BUCKETS   = [-Infinity, 40, 55, 70, 85, Infinity];
const SCORE_LABELS    = ['<40', '40-55', '55-70', '70-85', '85+'];

/* ─── State ──────────────────────────────────────────────────────────────── */

/** @type {Array<object>} */
let allRows = [];
/** @type {Array<object>} */
let summaryDays = [];
/** @type {string|null} */
let selectedDate = null;
let sortKey = 'score';
let sortDir = -1; // -1 = descending
/** @type {Chart|null} */
let chart = null;

/* ─── DOM helpers ─────────────────────────────────────────────────────────── */

/**
 * @param {string} sel
 * @returns {HTMLElement}
 */
const $ = (sel) => document.querySelector(sel);

/**
 * @param {string} sel
 * @returns {NodeList}
 */
const $$ = (sel) => document.querySelectorAll(sel);

function showState(msg) {
  const el = $('#state-msg');
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ─── Signal badge helpers ────────────────────────────────────────────────── */

/**
 * Build badge HTML for a single signal name.
 * @param {string} name - signal key
 * @param {boolean} primary - true if this is the primary signal
 * @returns {string}
 */
function badgeHTML(name, primary) {
  const meta = SIGNAL_META[name] || { label: name, icon: '•', cls: 'near' };
  const cls = primary ? `badge badge--${meta.cls} badge--primary` : `badge badge--${meta.cls}`;
  return `<span class="${cls}" title="${meta.label}">${meta.icon} ${meta.label}</span>`;
}

/**
 * Render the full badge group for a row.
 * @param {object} row
 * @returns {string}
 */
function signalBadgesHTML(row) {
  const primary = (row.signal || '').trim();
  const allSigs = row.signals
    ? row.signals.split(',').map((s) => s.trim()).filter(Boolean)
    : (primary ? [primary] : []);

  // De-duplicate: primary first, then extras
  const extras = allSigs.filter((s) => s !== primary);
  const count = row.signal_count || allSigs.length;

  let html = '<span class="badges">';
  if (primary) html += badgeHTML(primary, true);
  for (const s of extras) html += badgeHTML(s, false);
  if (count > 1) html += `<span class="conf-tag" title="${count} סיגנלים">×${count}</span>`;
  html += '</span>';
  return html;
}

/* ─── Score color ─────────────────────────────────────────────────────────── */

/**
 * Returns a background-color CSS value for a score.
 * Uses dark-appropriate muted tones.
 * @param {number|null} s
 * @returns {string}
 */
function scoreBg(s) {
  if (s == null) return 'transparent';
  if (s >= 85)  return 'rgba(63,185,80,0.32)';
  if (s >= 70)  return 'rgba(63,185,80,0.18)';
  if (s >= 55)  return 'rgba(210,153,34,0.22)';
  return 'rgba(248,81,73,0.20)';
}

/**
 * Returns a foreground color for a score badge (used in card list).
 * @param {number|null} s
 * @returns {string}
 */
function scoreColor(s) {
  if (s == null) return '#8b95a5';
  if (s >= 70)  return '#3fb950';
  if (s >= 55)  return '#d29922';
  return '#f85149';
}

/* ─── Number formatting ───────────────────────────────────────────────────── */

/** @returns {string} */
function fmtPct(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

/** @returns {string} */
function fmtPctClass(v) {
  if (v == null) return 'num-neu';
  const n = Number(v);
  if (n > 0)  return 'num-up';
  if (n < 0)  return 'num-down';
  return 'num-neu';
}

/** @returns {string} */
function fmtRvol(v) {
  if (v == null) return '—';
  return Number(v).toFixed(1) + 'x';
}

/** @returns {string} */
function fmtPrice(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* ─── Day strip ───────────────────────────────────────────────────────────── */

function renderDayStrip() {
  const strip = $('#day-strip');
  if (!summaryDays.length) { strip.innerHTML = ''; return; }

  strip.innerHTML = summaryDays.map((d) => {
    const shortDate = d.scan_date.slice(5); // MM-DD
    const score70 = d.score70 || 0;
    const selected = d.scan_date === selectedDate;
    return `
      <button
        class="day-chip"
        role="listitem"
        data-date="${d.scan_date}"
        aria-selected="${selected}"
        aria-label="${d.scan_date}, סה\"כ ${d.total} סיגנלים"
      >
        <span class="day-chip-date">${shortDate}</span>
        <span class="day-chip-meta">
          <span>${d.total}</span>
          ${score70 > 0 ? `<span class="day-chip-70">${score70}</span>` : ''}
        </span>
      </button>`;
  }).join('');

  strip.querySelectorAll('.day-chip').forEach((btn) => {
    btn.addEventListener('click', () => selectDay(btn.dataset.date));
  });
}

/* ─── Summary cards ───────────────────────────────────────────────────────── */

function renderCards() {
  const s = summaryDays.find((d) => d.scan_date === selectedDate);
  const container = $('#cards');
  if (!s) { container.innerHTML = ''; return; }

  const defs = [
    ['סה"כ',     s.total,        ''],
    ['📈 Breakout', s.breakout,  ''],
    ['🔥 High Vol', s.high_volume, ''],
    ['📉 Pullback', s.pullback,  ''],
    ['⏳ Near',   s.near_all,    ''],
    ['Score≥70', s.score70,      'stat-card--highlight'],
    ['Score≥65', s.score65,      'stat-card--accent'],
  ];

  container.innerHTML = defs.map(([lbl, val, extra]) => `
    <div class="stat-card ${extra}" role="listitem">
      <span class="stat-card-val">${val ?? 0}</span>
      <span class="stat-card-lbl">${lbl}</span>
    </div>`).join('');
}

/* ─── Chart ───────────────────────────────────────────────────────────────── */

function renderChart() {
  const counts = SCORE_LABELS.map(() => 0);
  for (const r of allRows) {
    const s = r.score;
    if (s == null) continue;
    for (let i = 0; i < SCORE_BUCKETS.length - 1; i++) {
      if (s >= SCORE_BUCKETS[i] && s < SCORE_BUCKETS[i + 1]) { counts[i]++; break; }
    }
  }

  if (chart) { chart.destroy(); chart = null; }

  const ctx = $('#dist-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: SCORE_LABELS,
      datasets: [{
        label: 'ציונים',
        data: counts,
        backgroundColor: [
          'rgba(248,81,73,0.55)',
          'rgba(210,153,34,0.55)',
          'rgba(210,153,34,0.70)',
          'rgba(63,185,80,0.55)',
          'rgba(63,185,80,0.80)',
        ],
        borderColor: 'transparent',
        borderRadius: 3,
      }],
    },
    options: {
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1b2130',
          borderColor: '#242c3a',
          borderWidth: 1,
          titleColor: '#e6edf3',
          bodyColor: '#8b95a5',
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b95a5', font: { size: 10, family: 'ui-monospace, monospace' } },
          grid:  { color: '#242c3a' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#8b95a5', font: { size: 10 }, stepSize: 1 },
          grid:  { color: '#242c3a' },
        },
      },
    },
  });
}

/* ─── Filtering / sorting ─────────────────────────────────────────────────── */

function visibleRows() {
  const q   = ($('#search').value || '').trim().toUpperCase();
  const reg = $('#f-region').value;
  const sig = $('#f-signal').value;
  const s2  = $('#f-stage2').checked;

  const filtered = allRows.filter((r) => {
    if (q   && !(r.ticker || '').toUpperCase().includes(q)) return false;
    if (reg && r.region !== reg)   return false;
    if (sig && r.signal !== sig)   return false;
    if (s2  && r.stage2 !== 1)     return false;
    return true;
  });

  return filtered.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') x = x.toLowerCase();
    if (typeof y === 'string') y = y.toLowerCase();
    return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
  });
}

/* ─── Table head ──────────────────────────────────────────────────────────── */

function renderHead() {
  const head = $('#grid-head');
  head.innerHTML = '<tr>' + COLS.map(([k, lbl]) => {
    const sorted = sortKey === k;
    const arrow  = sorted ? (sortDir < 0 ? ' ↓' : ' ↑') : '';
    const aSort  = sorted ? (sortDir < 0 ? 'descending' : 'ascending') : 'none';
    return `<th data-k="${k}" scope="col" aria-sort="${aSort}">${lbl}${arrow}</th>`;
  }).join('') + '</tr>';

  head.querySelectorAll('th').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (sortKey === k) sortDir *= -1;
      else { sortKey = k; sortDir = -1; }
      renderTable();
    });
  });
}

/* ─── Table body ──────────────────────────────────────────────────────────── */

function renderTable() {
  renderHead();

  const vr = visibleRows();
  $('#row-count').textContent = `${vr.length} שורות`;
  showState(vr.length === 0 ? 'אין תוצאות לסינון הנוכחי' : null);

  /* — desktop table — */
  const tbody = $('#grid-body');
  tbody.innerHTML = vr.map((r, i) => {
    const conf = (r.signal_count > 1) || false;
    const tds = COLS.map(([k, , cls]) => {
      let inner = '';
      let extraCls = cls;

      switch (k) {
        case 'ticker':
          inner = r.ticker || '';
          break;
        case 'region':
          inner = r.region || '';
          break;
        case 'sector':
          inner = (r.sector || '').slice(0, 22); // truncate long sector names
          break;
        case 'signals':
          inner = signalBadgesHTML(r);
          break;
        case 'rvol':
          inner = fmtRvol(r.rvol);
          break;
        case 'ath_pct':
          inner = `<span class="${fmtPctClass(r.ath_pct)}">${fmtPct(r.ath_pct)}</span>`;
          break;
        case 'day_pct':
          inner = `<span class="${fmtPctClass(r.day_pct)}">${fmtPct(r.day_pct)}</span>`;
          break;
        case 'stage2':
          inner = r.stage2 ? '<span class="num-up" title="Stage 2">✓</span>' : '';
          break;
        case 'score': {
          const bg = scoreBg(r.score);
          return `<td class="${cls}" style="background:${bg}" data-v="${r.score ?? -1}">${r.score ?? '—'}</td>`;
        }
        case 'price':
          inner = fmtPrice(r.price);
          break;
        default:
          inner = r[k] ?? '';
      }
      return `<td class="${extraCls}">${inner}</td>`;
    }).join('');

    return `<tr data-i="${i}" data-conf="${conf}" tabindex="0" role="row">${tds}</tr>`;
  }).join('');

  /* attach row click handlers */
  tbody.querySelectorAll('tr').forEach((tr) => {
    const idx = parseInt(tr.dataset.i, 10);
    tr.addEventListener('click', () => openDeepDive(vr[idx]));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDeepDive(vr[idx]); });
  });

  /* — mobile card list — */
  const cardList = $('#card-list');
  cardList.innerHTML = vr.map((r, i) => {
    const conf = (r.signal_count > 1) || false;
    const sc   = r.score ?? null;
    const scBg  = scoreBg(sc);
    const scClr = scoreColor(sc);
    return `
      <div
        class="signal-card"
        data-i="${i}"
        data-conf="${conf}"
        tabindex="0"
        role="button"
        aria-label="${r.ticker}, ציון ${sc ?? '—'}"
      >
        <div class="sc-top">
          <span class="sc-ticker">${r.ticker || ''}</span>
          <span class="sc-score-badge" style="background:${scBg};color:${scClr}">Score ${sc ?? '—'}</span>
        </div>
        <div class="sc-badges">${signalBadgesHTML(r)}</div>
        <div class="sc-grid">
          <div class="sc-kv"><span class="sc-k">RVOL</span><span class="sc-v">${fmtRvol(r.rvol)}</span></div>
          <div class="sc-kv"><span class="sc-k">יום%</span><span class="sc-v ${fmtPctClass(r.day_pct)}">${fmtPct(r.day_pct)}</span></div>
          <div class="sc-kv"><span class="sc-k">ATH%</span><span class="sc-v ${fmtPctClass(r.ath_pct)}">${fmtPct(r.ath_pct)}</span></div>
          <div class="sc-kv"><span class="sc-k">מחיר</span><span class="sc-v">${fmtPrice(r.price)}</span></div>
          <div class="sc-kv"><span class="sc-k">אזור</span><span class="sc-v">${r.region || ''}</span></div>
          <div class="sc-kv"><span class="sc-k">S2</span><span class="sc-v ${r.stage2 ? 'num-up' : ''}">${r.stage2 ? '✓' : '—'}</span></div>
        </div>
      </div>`;
  }).join('');

  cardList.querySelectorAll('.signal-card').forEach((card) => {
    const idx = parseInt(card.dataset.i, 10);
    card.addEventListener('click', () => openDeepDive(vr[idx]));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDeepDive(vr[idx]); });
  });
}

/* ─── Deep-dive panel ─────────────────────────────────────────────────────── */

function openDeepDive(r) {
  const tvSymbol = (r.ticker || '').replace(/\./g, '-');
  const tvUrl    = `https://www.tradingview.com/symbols/${tvSymbol}/`;

  const pairs = [
    ['Score',  r.score ?? '—'],
    ['RVOL',   fmtRvol(r.rvol)],
    ['ATH%',   fmtPct(r.ath_pct)],
    ['יום%',   fmtPct(r.day_pct)],
    ['לפיבוט', r.dist_pivot != null ? fmtPct(r.dist_pivot) : '—'],
    ['מחיר',   fmtPrice(r.price)],
    ['Stage2', r.stage2 ? '✓ כן' : '✗ לא'],
    ['אזור',   r.region || '—'],
  ];

  const gridHTML = pairs.map(([k, v]) => `
    <div class="dd-kv">
      <div class="dd-k">${k}</div>
      <div class="dd-v">${v}</div>
    </div>`).join('');

  $('#deepdive-inner').innerHTML = `
    <button class="btn-close" id="btn-close-dd" aria-label="סגור פאנל">✕</button>
    <div class="dd-ticker">${r.ticker || ''}</div>
    <div class="dd-sub">${r.sector || ''} · ${r.region || ''}</div>
    <div class="dd-badges">${signalBadgesHTML(r)}</div>
    <div class="dd-grid">${gridHTML}</div>
    <a class="dd-tv-link" href="${tvUrl}" target="_blank" rel="noopener noreferrer">
      פתח ב-TradingView ↗
    </a>`;

  const panel   = $('#deepdive');
  const overlay = $('#deepdive-overlay');
  panel.hidden   = false;
  overlay.hidden = false;
  overlay.removeAttribute('aria-hidden');

  // move focus into panel
  panel.querySelector('#btn-close-dd').addEventListener('click', closeDeepDive);
  overlay.addEventListener('click', closeDeepDive, { once: true });

  // trap Escape
  panel._escHandler = (e) => { if (e.key === 'Escape') closeDeepDive(); };
  document.addEventListener('keydown', panel._escHandler);
}

function closeDeepDive() {
  const panel   = $('#deepdive');
  const overlay = $('#deepdive-overlay');
  panel.hidden   = true;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  if (panel._escHandler) {
    document.removeEventListener('keydown', panel._escHandler);
    panel._escHandler = null;
  }
}

/* ─── Day selection ───────────────────────────────────────────────────────── */

async function selectDay(date) {
  if (date === selectedDate) return;
  selectedDate = date;

  // update strip selection state
  $$('#day-strip .day-chip').forEach((btn) => {
    btn.setAttribute('aria-selected', btn.dataset.date === date ? 'true' : 'false');
  });

  // update header date label
  $('#selected-date').textContent = date || '';

  showState('טוען…');
  try {
    const url = date ? `/api/signals?from=${date}&to=${date}` : '/api/signals';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    allRows = await resp.json();
  } catch (err) {
    showState(`שגיאה בטעינת נתונים: ${err.message}`);
    allRows = [];
  }

  renderCards();
  renderChart();
  renderTable();
  updateHeaderMeta();
}

/* ─── Header meta ─────────────────────────────────────────────────────────── */

function updateHeaderMeta() {
  const s = summaryDays.find((d) => d.scan_date === selectedDate);
  if (!s) { $('#header-meta').textContent = ''; return; }
  $('#header-meta').textContent = `${s.total} סיגנלים · Score≥70: ${s.score70 ?? 0}`;
}

/* ─── Boot ────────────────────────────────────────────────────────────────── */

async function boot() {
  // wire filter controls
  ['#search', '#f-region', '#f-signal', '#f-stage2'].forEach((sel) =>
    $(sel).addEventListener('input', renderTable)
  );

  showState('טוען נתוני היסטוריה…');

  try {
    const resp = await fetch('/api/summary');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    summaryDays = await resp.json();
  } catch (err) {
    showState(`שגיאה בטעינת סיכום: ${err.message}`);
    return;
  }

  if (!summaryDays.length) {
    showState('אין נתונים זמינים');
    return;
  }

  // render the day strip (selection happens in selectDay)
  renderDayStrip();

  // select most recent day (index 0 = newest first per API contract)
  const latestDate = summaryDays[0].scan_date;
  await selectDay(latestDate);
}

boot();

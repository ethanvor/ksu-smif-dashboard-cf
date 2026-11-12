// KSU SMIF Dashboard — app shell, data loading, views.
import { gicsFor, fullIndustry } from './gics.js';
import { IPS, stockChecks, weeklyAdjBeta, regBeta, sizeLimits } from './ips.js';
import {
  computePortfolio, symbolStats, portfolioStats, windowBacktest, windowAsHeld, actualBacktest, applyTrades, periodReturns, weightedBeta,
  fmt, cls, toGics, SECTORS, CASH_LIKE, sleeveSeries, viewWeeks, calendarYears, trailingPeriods, assetClassOf, verifyPrices,
} from './analytics.js';
import { buildHistory, rowsFromSheet, looksLikeTransactions, heldSince, sharesOn } from './history.js';

// ======================================================================
// State & persistence
// ======================================================================
const store = {
  get(k, d) { try { const v = localStorage.getItem('smif.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('smif.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem('smif.' + k); } catch { /* ignore */ } },
  sget(k) { try { return sessionStorage.getItem('smif.' + k) || ''; } catch { return ''; } },
  sset(k, v) { try { sessionStorage.setItem('smif.' + k, v); } catch { /* ignore */ } },
};

const S = {
  base: null,          // portfolio being displayed
  master: null,        // last master copy from the server
  seed: null,          // data/portfolio.json shipped with the site
  source: 'seed',      // 'master' | 'seed' | 'local'
  api: false,          // serverless API reachable?
  writable: false,     // server has ADMIN_KEY configured
  live: false,
  market: {},          // symbol -> chart data
  stats: {},           // symbol -> risk stats
  pstats: null,        // portfolio risk stats
  fetchedAt: null,
  rf: store.get('rf', null),
  rfAutoSaved: store.get('rfAuto', null),
  rfAuto: null,
  settings: { name: '', ...store.get('settings', {}), maxPos: 5, band: 3 }, // IPS: sectors rebalanced beyond ±3 pts; trades may not push a sector past ±2 pts
  view: 'overview',
  tmColor: 'ret', secBasis: 'equity', perfMode: 'ret', perfRange: store.get('perfRange', '1Y'), perfView: store.get('perfView', 'ret'), perfFrom: null, perfTo: null, perfWin: null, perfBasis: 'held', // actual results from the transaction history
  showTrades: store.get('showTrades', false),
  showAdj: store.get('showAdj', false),
  long: {}, longLoaded: false, longLoading: null,
  trades: [],
  stock: null,         // screener current stock
  trade: { side: 'buy', mode: 'shares' },
  draft: null,
  pendingUpload: null,
};
const rf = () => (S.rf != null ? S.rf : S.rfAuto != null ? S.rfAuto : S.rfAutoSaved != null ? S.rfAutoSaved : 0.04);
let calc = null;

// ======================================================================
// Helpers
// ======================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tip = (t) => `<span class="tip" tabindex="0" data-tip="${esc(t)}">i</span>`;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function modal(html) {
  $('#modalBody').classList.remove('wide');
  $('#modalBody').innerHTML = html;
  $('#modal').classList.add('open');
  return $('#modalBody');
}
const closeModal = () => { $('#modal').classList.remove('open'); $('#modalBody').classList.remove('wide'); };
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

async function getJSON(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error(`HTTP ${r.status} (not JSON)`);
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
    return j;
  } finally {
    clearTimeout(timer);
  }
}

// ======================================================================
// Charts (ECharts) — shared dark/KSU styling
// ======================================================================
const THEME_COLORS = {
  dark: { gold: '#FFC629', goldDim: 'rgba(255,198,41,0.25)', gray: '#8e8c88', grayLight: '#b2b4b2',
    up: '#3ccf7f', down: '#f0625a', blue: '#3987e5', violet: '#9085e9', orange: '#d95926',
    ink: '#f2f0ea', ink2: '#c9c6bd', muted: '#8e8a82', grid: 'rgba(255,255,255,0.07)', axis: 'rgba(255,255,255,0.18)',
    surface: '#181614', page: '#0c0b0a', goldText: '#FFC629', tile: '#3a3835', pop: '#1f1c19', wash: 'rgba(255,255,255,0.04)', line: 'rgba(255,255,255,0.08)' },
  light: { gold: '#E3A500', goldDim: 'rgba(227,165,0,0.25)', gray: '#8a8783', grayLight: '#7c7f7c',
    up: '#11804a', down: '#c8372e', blue: '#2f6fc4', violet: '#6f62d6', orange: '#c24e1d',
    ink: '#1d1a17', ink2: '#4a4540', muted: '#77716a', grid: 'rgba(45,41,38,0.08)', axis: 'rgba(45,41,38,0.25)',
    surface: '#ffffff', page: '#ffffff', goldText: '#8a6200', tile: '#e9e5dc', pop: '#ffffff', wash: 'rgba(45,41,38,0.04)', line: 'rgba(45,41,38,0.12)' },
};
const C = { ...THEME_COLORS.dark };
const charts = {};
function chart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (charts[id] && !charts[id].isDisposed() && charts[id].getDom() !== el) charts[id].dispose();
  if (!charts[id] || charts[id].isDisposed()) { el.innerHTML = ''; charts[id] = echarts.init(el, null, { renderer: 'canvas' }); }
  return charts[id];
}
const baseText = { color: C.ink2, fontFamily: 'Montserrat, system-ui, sans-serif', fontSize: 11 };
const tooltipBase = {
  backgroundColor: '#1f1c19', borderColor: 'rgba(255,198,41,0.35)', borderWidth: 1,
  textStyle: { color: C.ink, fontFamily: 'Montserrat, system-ui', fontSize: 12 }, extraCssText: 'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:min(300px,calc(100vw - 32px));white-space:normal;',
  confine: true, // keep chart tooltips inside the chart (and the screen) on phones
};
const axisCommon = {
  axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
  axisLabel: { color: C.muted, fontFamily: 'Montserrat, system-ui', fontSize: 11 },
  splitLine: { lineStyle: { color: C.grid } },
};
// ---------- light / dark mode ----------
function applyTheme(t) {
  t = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  Object.assign(C, THEME_COLORS[t]);
  tooltipBase.backgroundColor = C.pop;
  tooltipBase.borderColor = t === 'light' ? 'rgba(196,146,0,0.45)' : 'rgba(255,198,41,0.35)';
  tooltipBase.textStyle.color = C.ink;
  tooltipBase.extraCssText = tooltipBase.extraCssText.replace(/box-shadow:[^;]*;/, `box-shadow:0 10px 30px rgba(0,0,0,${t === 'light' ? '.15' : '.5'});`);
  axisCommon.axisLine.lineStyle.color = C.axis;
  axisCommon.axisLabel.color = C.muted;
  axisCommon.splitLine.lineStyle.color = C.grid;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f5f3ee' : '#0c0b0a');
  const b = document.getElementById('themeBtn');
  if (b) { b.textContent = t === 'light' ? '☾' : '☀'; b.title = t === 'light' ? 'Switch to dark mode' : 'Switch to light mode'; b.setAttribute('aria-label', b.title); }
}
applyTheme(localStorage.getItem('smif.theme') || document.documentElement.dataset.theme || 'dark');
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
const SHORT = { 'Information Technology': 'Info Tech', 'Communication Services': 'Comm. Services', 'Consumer Discretionary': 'Cons. Disc.', 'Consumer Staples': 'Cons. Staples', 'Health Care': 'Health Care', 'Fixed Income': 'Fixed Income', 'Money Market': 'Money Mkt' };
const shortName = (v) => (isMobile() ? SHORT[v] || v : v);
function setChart(id, option, onClick) {
  const ch = chart(id);
  if (!ch) return;
  const o = { textStyle: baseText, animationDuration: 800, animationEasing: 'cubicOut', ...option };
  const m = isMobile();
  if (o.grid) {
    o.grid = { ...o.grid, containLabel: true, left: m ? 10 : Math.min(o.grid.left ?? 10, 12), right: m ? Math.min(o.grid.right ?? 10, 40) : o.grid.right };
  }
  const fixAxis = (ax) => {
    if (Array.isArray(ax)) return ax.map(fixAxis);
    if (!ax) return ax;
    // ECharts sizes the chart margins (containLabel) from each axis label's OWN font, which defaults to plain
    // sans-serif — narrower than Montserrat, so long labels like "Communication Services" got clipped.
    // Give every axis label and axis name the real font so the space reserved matches what's drawn.
    ax.axisLabel = { fontFamily: baseText.fontFamily, ...ax.axisLabel };
    ax.nameTextStyle = { fontFamily: baseText.fontFamily, ...ax.nameTextStyle };
    if (m && ax.name) ax.nameTextStyle = { ...ax.nameTextStyle, align: ax.nameLocation === 'middle' ? 'center' : 'left', fontSize: 10 };
    if (ax.type === 'category' && m) {
      const f0 = ax.axisLabel?.formatter;
      ax.axisLabel = { ...ax.axisLabel, fontSize: 10, width: 110, overflow: 'truncate', formatter: (v, i) => { const x = SHORT[v] || v; return typeof f0 === 'function' ? f0(x, i) : x; } };
    }
    return ax;
  };
  o.yAxis = fixAxis(o.yAxis); o.xAxis = fixAxis(o.xAxis);
  // a y-axis title sits centred over the axis line by default and can poke out past the left edge
  [].concat(o.yAxis || []).forEach((ax) => { if (ax?.name && (!ax.nameLocation || ax.nameLocation === 'end') && !ax.nameRotate) ax.nameTextStyle = { align: 'left', ...ax.nameTextStyle }; });
  if (m && o.legend && !o.legend.orient) o.legend = { ...o.legend, itemGap: 8, textStyle: { ...o.legend.textStyle, fontSize: 10 } };
  if (m && Array.isArray(o.series)) o.series.forEach((x) => { if (x.endLabel) x.endLabel = { ...x.endLabel, show: false }; });
  ch.setOption(o, true);
  ch.off('click');
  if (onClick) { ch.on('click', onClick); ch.getZr().setCursorStyle && null; }
}
// open a ticker in the screener from anywhere
function openStock(t) {
  if (!t || CASH_LIKE.has(t) || t === 'SNOXX') return;
  show('screener');
  analyze(t);
}
window.addEventListener('resize', () => Object.values(charts).forEach((c) => c && !c.isDisposed() && c.resize()));
const emptyChart = (id, msg) => { if (charts[id]) { charts[id].dispose(); delete charts[id]; } document.getElementById(id).innerHTML = `<div class="skeleton">${msg}</div>`; };
const lerpColor = (a, b, t) => {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16)), pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
};
const divColor = (v, cap) => {
  if (v == null) return '#3a3835';
  const t = Math.min(1, Math.abs(v) / cap);
  return lerpColor('3a3835', v >= 0 ? '1f9a5a' : 'c8443d', 0.25 + 0.75 * t);
};

// ======================================================================
// Data loading
// ======================================================================
async function loadPortfolio() {
  S.seed = await getJSON('data/portfolio.json');
  try {
    const r = await getJSON('/api/portfolio', {}, 8000);
    S.api = true;
    S.writable = !!r.writable;
    S.master = r.master;
  } catch {
    S.api = false;
  }
  const local = store.get('localPortfolio', null);
  if (local) { S.base = local; S.source = 'local'; }
  else if (S.master) { S.base = S.master; S.source = 'master'; }
  else { S.base = S.seed; S.source = 'seed'; }
  // reference data always comes from the shipped seed if missing
  ['benchmark', 'spxConstituents', 'snapshotReturns', 'watchlist', 'focusList'].forEach((k) => { if (!S.base[k]) S.base[k] = S.seed[k]; });
  await loadTxHistory();
}
// Trade history: the officers' latest upload (master store) if any, else the file shipped with the site.
async function loadTxHistory() {
  let h = null;
  if (S.api) { try { h = (await getJSON('/api/portfolio?doc=history', {}, 10000)).history; } catch { /* fall back */ } }
  const lh = store.get('localHist', null);
  if (lh) h = lh;
  if (!h) { try { h = await getJSON('data/history.json', {}, 15000); } catch { h = null; } }
  S.hist = h;
}

function allSymbols() {
  return [...new Set(S.base.holdings.map((h) => h.ticker).filter((t) => !CASH_LIKE.has(t) && t !== 'SNOXX'))];
}

async function loadMarket() {
  if (!S.api) { S.live = false; return; }
  try {
    const syms = [...allSymbols(), 'SPY', '^IRX'];
    // Small batches in parallel: each server function must finish in ~10s, so don't ask one for 40 tickers.
    const chunks = [['SPY', '^IRX']];
    const rest = syms.filter((s) => s !== 'SPY' && s !== '^IRX');
    for (let i = 0; i < rest.length; i += 6) chunks.push(rest.slice(i, i + 6));
    const res = await Promise.allSettled(chunks.map((c) => getJSON(`/api/market?symbols=${encodeURIComponent(c.join(','))}&range=1y`, {}, 25000)));
    let ok = 0;
    const failed = [];
    res.forEach((r, i) => {
      if (r.status !== 'fulfilled') { failed.push(...chunks[i]); console.warn('Batch failed', chunks[i], r.reason?.message); return; }
      r.value.data.forEach((d) => { if (d && !d.error && d.closes?.length) { S.market[d.symbol.toUpperCase()] = d; ok++; } else if (d) failed.push(d.symbol); });
    });
    if (failed.length) console.warn('No live data for:', failed.join(', '));
    const irx = S.market['^IRX'];
    if (irx && irx.price > 0 && irx.price < 20) { S.rfAuto = irx.price / 100; store.set('rfAuto', S.rfAuto); } // 13-week T-bill yield
    S.live = ok > 2 && !!S.market.SPY;
    S.fetchedAt = new Date();
    computeStats();
  } catch (e) {
    console.warn('Live data unavailable:', e.message);
    S.live = false;
  }
}

function computeStats() {
  S.stats = {};
  const spy = S.market.SPY;
  Object.entries(S.market).forEach(([sym, m]) => { if (sym !== '^IRX') S.stats[sym] = symbolStats(m, spy, rf()); });
  calc = computePortfolio(S.base, S.live ? S.market : {});
  S.pstats = S.live ? portfolioStats(calc, S.market, rf()) : null;
}

function recalc() {
  calc = computePortfolio(S.base, S.live ? S.market : {});
  if (S.live) S.pstats = portfolioStats(calc, S.market, rf());
}

// ======================================================================
// Header status
// ======================================================================
function renderStatus() {
  const pill = $('#statusPill');
  pill.className = 'pill ' + (S.live ? 'live' : 'snap');
  const src = { master: 'Master copy', seed: 'Excel import', local: 'Your local copy' }[S.source];
  const localTag = S.source === 'local' ? ' · LOCAL COPY' : '';
  $('#statusText').textContent = (S.live
    ? `Live · ${S.fetchedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : `Snapshot · ${S.base.meta?.asOf || ''}`) + localTag;
  if (S.source === 'local') pill.classList.add('local');
  let bn = document.getElementById('localBanner');
  if (S.source === 'local' && !bn) {
    bn = document.createElement('div'); bn.id = 'localBanner'; bn.className = 'local-banner';
    bn.innerHTML = 'You\'re viewing <b>your own local copy</b>, not the shared master. <button class="btn sm" id="lbBack">Back to master</button>';
    document.querySelector('main').prepend(bn);
    $('#lbBack').onclick = () => { store.del('localPortfolio'); S.base = S.master || S.seed; S.source = S.master ? 'master' : 'seed'; bn.remove(); refreshAll(true); };
  } else if (S.source !== 'local' && bn) bn.remove();
  pill.title = `${src}. ${S.live ? 'Prices from Yahoo Finance (delayed).' : 'Prices from the workbook snapshot — live data needs the deployed site.'}`;
  $('#footMeta').textContent = `Showing: ${src}${S.base.meta?.version ? ' v' + S.base.meta.version : ''} · last updated ${S.base.meta?.updatedAt ? new Date(S.base.meta.updatedAt).toLocaleString() : '—'} by ${S.base.meta?.updatedBy || '—'}`;
}

// ======================================================================
// Overview
// ======================================================================
function renderOverview() {
  const c = calc;
  countUp($('#heroValue'), c.total, (v) => { const [w, ct] = fmt.usdC(v).split('.'); return `${w}<span class="cents">.${ct}</span>`; });
  const dc = $('#heroChg');
  dc.className = 'chg ' + (c.dayGl >= 0 ? 'up' : 'down');
  const mt = S.live && S.market.SPY?.marketTime ? new Date(S.market.SPY.marketTime) : null;
  const sameDay = !mt || mt.toDateString() === new Date().toDateString();
  const when = sameDay ? 'today' : `on ${mt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  dc.textContent = `${c.dayGl >= 0 ? '▲' : '▼'} ${fmt.usd(Math.abs(c.dayGl))} (${fmt.spct(c.dayPct, 2)}) ${when}`;
  const spyDay = S.live ? S.stats.SPY?.periods?.['1D'] : S.base.benchmark?.snapshot?.SPY?.change;
  $('#heroVs').textContent = spyDay != null ? `S&P 500 ${fmt.spct(spyDay, 2)}` : '';
  $('#heroMeta').innerHTML = `
    <div>Cost basis<b class="num">${fmt.usd(c.costBasis)}</b></div>
    <div>Unrealized gain<b class="num ${cls(c.unrealized)}">${fmt.usd(c.unrealized)} · ${fmt.spct(c.unrealizedPct)}</b></div>
    <div>Positions<b class="num">${c.rows.length}</b></div>
    <div>As of<b>${asOfLabel()}</b></div>`;

  // asset mix donut (direct labels → identity isn't color-alone)
  const mix = [
    { name: 'Equities', value: c.eqValue, itemStyle: { color: C.gold } },
    { name: 'Fixed income', value: c.fiValue, itemStyle: { color: C.blue } },
    { name: 'Money market', value: c.mmValue, itemStyle: { color: C.violet } },
    { name: 'Cash', value: c.cash, itemStyle: { color: C.gray } },
  ].filter((d) => d.value > 0);
  setChart('chAssetMix', {
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p) => `<b>${p.name}</b><br>${fmt.usd(p.value)} · ${p.percent.toFixed(1)}%` },
    legend: { show: true, orient: 'vertical', right: 0, top: 'middle', textStyle: { color: C.ink2 }, itemWidth: 10, itemHeight: 10, icon: 'roundRect',
      formatter: (n) => { const d = mix.find((x) => x.name === n); return `${n}  ${fmt.pct(d.value / c.total)}`; } },
    series: [{ type: 'pie', radius: ['55%', '82%'], center: ['32%', '50%'], padAngle: 2, itemStyle: { borderRadius: 6, borderColor: C.surface, borderWidth: 2 },
      label: { show: false }, data: mix }],
  });

  // KPI tiles
  const ps = S.pstats;
  const tiles = [
    ['Equity weight', fmt.pct(c.eqValue / c.total), `${c.nEquity} stocks · ${fmt.usd(c.eqValue)}`, 'Share of the fund invested in individual stocks.'],
    ['Fixed income & cash', fmt.pct((c.fiValue + c.cashLike) / c.total), `${fmt.usd(c.fiValue)} bonds · ${fmt.usd(c.cashLike)} available to deploy`, `Everything that isn't a stock: bond ETFs (${fmt.usd(c.fiValue)}), the Treasury money-market fund SNOXX (${fmt.usd(c.mmValue)}) and cash (${fmt.usd(c.cash)}). "Available to deploy" is cash plus the money-market fund. Trade Lab buys are paid from cash only.`],
    ['Portfolio beta', ps ? fmt.x(ps.beta) : '—', ps ? 'vs S&P 500, 1-year daily' : 'Needs live data', 'How much the fund tends to move when the S&P 500 moves 1%. 1.0 = same as the market; 0.8 = 20% calmer.'],
    ['Sharpe ratio', ps ? fmt.x(ps.sharpe) : '—', ps ? `S&P 500: ${fmt.x(ps.benchStats?.sharpe)}` : 'Needs live data', 'Return earned above the risk-free rate per unit of volatility. Higher is better; above 1 is strong.'],
  ];
  $('#kpiTiles').innerHTML = tiles.map(([l, v, f, t]) => `<div class="card tile"><div class="label">${l} ${tip(t)}</div><div class="value num">${v}</div><div class="foot">${f}</div></div>`).join('');

  // Performance chart
  if (S.live && ps) {
    renderPerfChart();
  } else {
    renderSnapshotPerf();
  }

  // Movers
  const movers = c.rows.filter((r) => r.dayChg != null && r.assetClass === 'Equity').sort((a, b) => b.dayChg - a.dayChg);
  const li = (r) => `<div class="list-item clickable" data-open="${r.ticker}" title="Analyze ${r.ticker}"><div><span class="tk" style="font-weight:800">${r.ticker}</span> <span style="color:var(--muted);font-size:12px">${esc(r.name).slice(0, 26)}</span></div><div class="num ${cls(r.dayChg)}" style="font-weight:700">${fmt.spct(r.dayChg, 2)}</div></div>`;
  $('#movers').innerHTML = `<h3>Leaders</h3><div class="list">${movers.slice(0, 5).map(li).join('')}</div><h3 style="margin-top:14px">Laggards</h3><div class="list">${movers.slice(-5).reverse().map(li).join('')}</div>`;
  $$('#movers [data-open]').forEach((el) => el.addEventListener('click', () => openStock(el.dataset.open)));

  // Top 10
  const top = [...c.rows].filter((r) => r.assetClass === 'Equity').sort((a, b) => b.value - a.value).slice(0, 10).reverse();
  setChart('chTop10', {
    grid: { left: 60, right: 56, top: 6, bottom: 20 },
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p) => { const r = top[p.dataIndex]; return `<b>${r.ticker}</b> ${esc(r.name)}<br>${fmt.usd(r.value)} · ${fmt.pct(r.weight, 2)} of fund`; } },
    xAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    yAxis: { type: 'category', data: top.map((r) => r.ticker), ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink, fontWeight: 700 } },
    series: [{ type: 'bar', data: top.map((r) => r.weight), barWidth: '58%', itemStyle: { color: C.gold, borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: C.ink2, formatter: (p) => fmt.pct(p.value, 1) } }],
  }, (p) => openStock(top[p.dataIndex]?.ticker));
  renderSectorBars('chSectorOv', 'equity');
}

// ---------- Overview performance chart with selectable period ----------
function rangeStart(r) {
  const d = new Date();
  const back = { '1M': [0, 1], '3M': [0, 3], '6M': [0, 6], '1Y': [1, 0], '3Y': [3, 0], '5Y': [5, 0], '10Y': [10, 0] }[r];
  if (r === 'YTD') return `${d.getFullYear() - 1}-12-31`;
  if (r === 'Custom') return S.perfFrom || new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  d.setFullYear(d.getFullYear() - back[0]);
  d.setMonth(d.getMonth() - back[1]);
  return d.toISOString().slice(0, 10);
}
async function fetchSeries(syms, range, interval, into) {
  const chunks = [];
  for (let i = 0; i < syms.length; i += 6) chunks.push(syms.slice(i, i + 6));
  const res = await Promise.allSettled(chunks.map((c) => getJSON(`/api/market?symbols=${encodeURIComponent(c.join(','))}&range=${range}&interval=${interval}`, {}, 25000)));
  res.forEach((r) => { if (r.status === 'fulfilled') r.value.data.forEach((d) => { if (d && !d.error && d.closes?.length) into[d.symbol.toUpperCase()] = d; }); });
}
async function loadLongHistory() {
  if (S.longLoaded) return;
  if (S.longLoading) return S.longLoading;
  S.longLoading = fetchSeries([...allSymbols(), 'SPY'], '10y', '1wk', S.long).then(() => { S.longLoaded = !!S.long.SPY; S.longLoading = null; });
  return S.longLoading;
}
// stocks we owned during the window but have since sold also need prices for the ACTUAL line
const tried = { d: new Set(), w: new Set() };
async function loadFormerHoldings(start, long) {
  if (!S.hist || !S.api) return;
  const into = long ? S.long : S.market, key = long ? 'w' : 'd';
  const need = heldSince(S.hist, start).filter((t) => t !== 'SNOXX' && !into[t] && !tried[key].has(t));
  if (!need.length) return;
  need.forEach((t) => tried[key].add(t));
  $('#perfStats').innerHTML = `<span>Loading prices for ${need.length} stocks we've since sold…</span>`;
  await fetchSeries(need, long ? '10y' : '1y', long ? '1wk' : '1d', into);
  // same accuracy rule as the Performance tab: a history that doesn't match our Schwab trade prices is not used
  need.forEach((t) => { const h = S.hist.tickers[t]; if (h && into[t] && !verifyPrices(h, into[t]).ok) delete into[t]; });
}
async function renderPerfChart() {
  // Without live prices there's nothing to compare over time: show the workbook's period returns instead
  if (!S.live || !S.market.SPY) return renderSnapshotPerf();
  const r = S.perfRange;
  $('#perfRange').style.display = '';
  $('#perfView').style.display = '';
  $('#tradeToggleWrap').style.display = S.hist ? '' : 'none';
  $('#tradeToggle').checked = S.showTrades;
  $$('#perfRange button').forEach((b) => b.classList.toggle('on', b.dataset.v === r));
  $('#perfFrom').max = $('#perfTo').max = new Date().toISOString().slice(0, 10);
  const start = rangeStart(r);
  const long = r === '3Y' || r === '5Y' || r === '10Y' || (r === 'Custom' && start < (S.market.SPY.dates[0] || ''));
  $('#perfDates').style.display = r === 'Custom' ? '' : 'none';
  // 3Y and longer use the same checked weekly price store as the Performance tab, so both always agree
  const shared = long && S.hist && S.api;
  if (shared && !RV.loaded) {
    $('#perfStats').innerHTML = '<span>Loading and checking weekly prices since 2009…</span>';
    await loadAllHistory();
    if (S.perfRange !== r || S.view !== 'overview') return;
  }
  if (long && !shared && !S.longLoaded) {
    $('#perfStats').innerHTML = '<span>Loading 10 years of weekly prices…</span>';
    await loadLongHistory();
    if (S.perfRange !== r || S.view !== 'overview') return;
    if (!S.longLoaded) { $('#perfStats').innerHTML = '<span class="down">Couldn\'t load long-term history.</span>'; return; }
  }
  const asHeld = S.perfBasis === 'held';
  if (asHeld && S.hist && !shared) {
    await loadFormerHoldings(start, long);
    if (S.perfRange !== r || S.view !== 'overview') return;
  }
  const mkt = shared ? RV.all : long ? S.long : S.market;
  const bt = asHeld
    ? (S.hist ? actualBacktest(S.hist, mkt, start) : windowAsHeld(calc, mkt, start))
    : windowBacktest(calc, mkt, rf(), start, long ? 52 : 252);
  if (!bt) { emptyChart('chPerf', 'Not enough data for this period'); return; }
  const label = { '1M': 'past month', '3M': 'past 3 months', '6M': 'past 6 months', YTD: 'year to date', '1Y': 'past year', '3Y': 'past 3 years', '5Y': 'past 5 years', '10Y': 'past 10 years', Custom: 'custom range' }[r];
  S.perfTitleBase = `SMIF vs S&P 500 — ${label}`;
  let notes;
  if (bt.actual) {
    notes = [`Actual results, rebuilt from ${fmt.n(S.hist.transactions)} Schwab transactions: each day values exactly what the fund owned (including stocks since sold) plus cash and dividends. Money added or withdrawn is excluded, so this measures investment performance only.`];
  } else if (asHeld) {
    notes = ['Each stock counts from the date we first bought it. Upload the Schwab transaction history on the Master Copy page for the full record, including stocks since sold.'];
  } else {
    notes = ["Today's holdings at today's weights applied to the whole period — shows how the current portfolio would have done, not the fund's actual returns."];
  }
  if (long) notes.push('Weekly prices.');
  $('#perfHint').textContent = notes.join(' ');
  // mark trading days on the actual line (dates snapped to the chart's dates)
  let marks = [];
  if (bt.actual && bt.trades.length) {
    const byDay = {};
    bt.trades.forEach((t) => {
      const d = bt.dates.find((x) => x >= t.date);
      if (!d) return;
      (byDay[d] = byDay[d] || { buys: [], sells: [] })[t.type === 'Buy' ? 'buys' : 'sells'].push(t.ticker);
    });
    marks = Object.entries(byDay).map(([d, v]) => ({ xAxis: d, info: v, label: { show: false } }));
  }
  // window to show: whole range, or the custom From/To dates
  let s0 = 0, e0 = bt.dates.length - 1;
  if (r === 'Custom' && S.perfTo) { const k = bt.dates.findIndex((d) => d > S.perfTo); if (k > 1) e0 = k - 1; }
  S.perfBt = { bt, marks, long, short: r === '1M' || r === '3M' };
  S.perfWin = { s: s0, e: e0, full: r !== 'Custom' };
  drawPerf(true);
}
// Every number on the chart is measured from the first day you're looking at, so it always starts at 0%.
function perfWindowStats(bt, s, e) {
  const sm = bt.smif[e] / bt.smif[s] - 1, sp = bt.bench[e] / bt.bench[s] - 1;
  const yrs = (new Date(bt.dates[e]) - new Date(bt.dates[s])) / (365.25 * 864e5);
  const ann = (g) => (yrs >= 1 ? Math.pow(1 + g, 1 / yrs) - 1 : null);
  return { sm, sp, diff: sm - sp, smA: ann(sm), spA: ann(sp), yrs };
}
function perfData(bt, s) {
  const b0 = bt.smif[s], c0 = bt.bench[s];
  // % return from the first day in view (starts at 0%); gap = SMIF's return minus the S&P's
  const sm = bt.smif.map((v) => +((v / b0 - 1) * 100).toFixed(2));
  const sp = bt.bench.map((v) => +((v / c0 - 1) * 100).toFixed(2));
  return { sm, sp, gap: sm.map((v, i) => +(v - sp[i]).toFixed(2)) };
}
function perfStatsHTML(bt, s, e) {
  const w = perfWindowStats(bt, s, e);
  const custom = !S.perfWin.full || S.perfRange === 'Custom';
  $('#perfTitle').textContent = custom ? `SMIF vs S&P 500 — ${fdate(bt.dates[s])} to ${fdate(bt.dates[e])}` : S.perfTitleBase;
  $('#perfStats').innerHTML = `
    <span>SMIF <b class="${cls(w.sm)}">${fmt.spct(w.sm)}</b></span>
    <span>S&amp;P 500 <b class="${cls(w.sp)}">${fmt.spct(w.sp)}</b></span>
    <span>Difference <b class="${cls(w.diff)}">${fmt.spct(w.diff)}</b></span>
    ${w.smA != null ? `<span>Annualized <b>${fmt.spct(w.smA)}</b> vs <b>${fmt.spct(w.spA)}</b></span>` : ''}`;
  $('#perfFrom').value = bt.dates[s]; $('#perfTo').value = bt.dates[e];
  $('#perfReset').style.display = S.perfWin.full ? 'none' : '';
}
function drawPerf(fresh) {
  const { bt, marks, long, short } = S.perfBt;
  const { s, e } = S.perfWin;
  const D = perfData(bt, s);
  S.perfD = { D, s };
  const gapView = S.perfView === 'diff';
  $$('#perfView button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.perfView));
  perfStatsHTML(bt, s, e);
  const pctAxis = { ...axisCommon.axisLabel, formatter: (v) => `${v > 0 ? '+' : ''}${v}%` };
  const zeroLine = { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: C.axis, type: 'solid', width: 1 }, data: [{ yAxis: 0 }] };
  const tradeLines = marks.length && S.showTrades ? marks : [];
  const tooltip = { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.gold, opacity: 0.5 } },
    formatter: (p) => {
      const d = p[0].axisValue, i = bt.dates.indexOf(d), { D, s } = S.perfD;
      let h = `<b>${fdate(d)}</b><span style="color:${C.muted}"> · since ${fdate(bt.dates[s])}</span><br>`;
      h += `<span style="color:${C.gold}">●</span> SMIF: ${fmt.spct(D.sm[i] / 100)}<br><span style="color:${C.grayLight}">●</span> S&amp;P 500: ${fmt.spct(D.sp[i] / 100)}<br>`;
      h += D.gap[i] >= 0 ? `<span style="color:${C.up}">SMIF ahead of the S&amp;P 500 by ${D.gap[i].toFixed(1)}%</span>` : `<span style="color:${C.down}">SMIF behind the S&amp;P 500 by ${(-D.gap[i]).toFixed(1)}%</span>`;
      if (bt.actual && i >= 0) h += `<br><span style="color:${C.muted}">Fund value: ${fmt.usd(bt.values[i])}</span>`;
      const m = S.showTrades && marks.find((x) => x.xAxis === d);
      if (m) {
        const list = (a) => (a.length > 6 ? a.slice(0, 6).join(', ') + ` +${a.length - 6} more` : a.join(', '));
        if (m.info.buys.length) h += `<br><span style="color:#3ccf7f">Bought: ${list(m.info.buys)}</span>`;
        if (m.info.sells.length) h += `<br><span style="color:#f0625a">Sold: ${list(m.info.sells)}</span>`;
      }
      return h;
    } };
  const series = gapView
    ? [{ name: 'SMIF minus S&P 500', type: 'line', data: D.gap, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold },
        areaStyle: { origin: 0, color: 'rgba(255,198,41,0.14)' },
        endLabel: { show: true, color: C.ink, formatter: (p) => `${p.value >= 0 ? '+' : ''}${p.value.toFixed(1)}%` },
        markLine: { ...zeroLine, data: [{ yAxis: 0 }, ...tradeLines.map((m) => ({ ...m, lineStyle: { color: 'rgba(255,198,41,0.28)', type: 'dashed', width: 1 } }))] } }]
    : [{ name: bt.actual ? 'SMIF (actual)' : 'SMIF', type: 'line', data: D.sm, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold },
        areaStyle: { origin: 0, color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,198,41,0.22)' }, { offset: 1, color: 'rgba(255,198,41,0)' }]) },
        endLabel: { show: true, color: C.ink, formatter: (p) => `SMIF ${fmt.spct(p.value / 100)}` }, labelLayout: { moveOverlap: 'shiftY' },
        markLine: { ...zeroLine, data: [{ yAxis: 0 }, ...tradeLines.map((m) => ({ ...m, lineStyle: { color: 'rgba(255,198,41,0.28)', type: 'dashed', width: 1 } }))] } },
      { name: 'S&P 500 (SPY)', type: 'line', data: D.sp, showSymbol: false, lineStyle: { width: 2, color: C.grayLight }, itemStyle: { color: C.grayLight },
        endLabel: { show: true, color: C.ink2, formatter: (p) => `SPY ${fmt.spct(p.value / 100)}` }, labelLayout: { moveOverlap: 'shiftY' } }];
  if (!fresh && charts.chPerf) { charts.chPerf.setOption({ animationDurationUpdate: 0, series }, { replaceMerge: ['series'] }); return; }
  // new time frame: wipe the old lines first so they draw in cleanly instead of morphing into the new shape
  if (charts.chPerf && !charts.chPerf.isDisposed()) charts.chPerf.clear();
  setChart('chPerf', {
    grid: { left: 44, right: gapView ? 70 : 78, top: 20, bottom: 58 },
    tooltip,
    legend: gapView ? { show: false } : { top: 0, right: 0, textStyle: { color: C.ink2 }, icon: 'roundRect', itemWidth: 12, itemHeight: 3 },
    xAxis: { type: 'category', data: bt.dates, ...axisCommon, splitLine: { show: false },
      axisLabel: { ...axisCommon.axisLabel, formatter: (v) => axisDate(v, long ? 'long' : short ? 'short' : 'mid') } },
    yAxis: { type: 'value', scale: true, ...axisCommon, axisLabel: pctAxis },
    dataZoom: [
      { type: 'slider', xAxisIndex: 0, startValue: s, endValue: e, height: 20, bottom: 6, left: isMobile() ? 16 : 92, right: isMobile() ? 16 : 92, showDetail: !isMobile(), brushSelect: false, borderColor: C.line, backgroundColor: C.wash,
        fillerColor: 'rgba(255,198,41,.12)', handleStyle: { color: C.gold, borderColor: C.gold }, moveHandleStyle: { color: 'rgba(255,198,41,.4)' },
        dataBackground: { lineStyle: { color: C.axis }, areaStyle: { color: C.wash } },
        selectedDataBackground: { lineStyle: { color: C.gold }, areaStyle: { color: 'rgba(255,198,41,.08)' } },
        textStyle: { color: C.ink2, fontSize: 10 }, labelFormatter: (i) => fdate(bt.dates[i]) },
    ],
    series,
  });
  const ch = charts.chPerf;
  ch.off('datazoom');
  ch.on('datazoom', () => {
    const z = ch.getOption().dataZoom[0];
    const ns = Math.max(0, Math.round(z.startValue)), ne = Math.min(bt.dates.length - 1, Math.round(z.endValue));
    if (ne - ns < 2 || (ns === S.perfWin.s && ne === S.perfWin.e)) return;
    S.perfWin = { s: ns, e: ne, full: ns === 0 && ne === bt.dates.length - 1 };
    if (S.perfRange !== 'Custom') $('#perfDates').style.display = S.perfWin.full ? 'none' : '';
    clearTimeout(S.perfZT);
    S.perfZT = setTimeout(() => drawPerf(false), 40);
    perfStatsHTML(bt, ns, ne);
  });
}

function renderSnapshotPerf() {
  const c = calc;
  // Snapshot: weighted SMIF return over each period from the Stock History tab
  const per = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y'];
  const sr = S.base.snapshotReturns || {};
  const vals = per.map((p) => {
    let w = 0, r = 0;
    c.rows.forEach((row) => { const v = sr[row.ticker]?.[p]; if (v != null) { r += row.weight * v; w += row.weight; } });
    return w ? +(r / w).toFixed(4) : null;
  });
  $('#perfTitle').textContent = 'SMIF return by period';
  $('#perfHint').textContent = 'Weighted by current holdings · workbook snapshot. Live data enables the period selector and S&P comparison.';
  $('#perfRange').style.display = 'none';
  $('#perfView').style.display = 'none'; $('#perfDates').style.display = 'none';
  $('#perfStats').innerHTML = '';
  setChart('chPerf', {
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => fmt.spct(v) },
    xAxis: { type: 'category', data: per, ...axisCommon, splitLine: { show: false } },
    yAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    series: [{ name: 'SMIF', type: 'bar', barMaxWidth: 34, data: vals.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? C.gold : C.down, borderRadius: v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
      label: { show: true, position: 'top', color: C.ink2, formatter: (p) => fmt.spct(p.value) } }],
  });

  $('#tradeToggleWrap').style.display = 'none';
}

function asOfLabel() {
  const now = S.live && S.fetchedAt ? S.fetchedAt : new Date();
  const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (S.live) return `${date} · ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
  return `${date} <span style="color:var(--muted);font-size:12px;font-weight:500">(workbook prices)</span>`;
}

// animated number roll-up (runs once per element, then just sets the value)
function countUp(el, to, render, ms = 1100) {
  if (!el) return;
  const from = el._v ?? (el._v === undefined ? to * 0.6 : to);
  el._v = to;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(from - to) < 1e-9) { el.innerHTML = render(to); return; }
  const t0 = performance.now();
  cancelAnimationFrame(el._raf);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 4);
    el.innerHTML = render(from + (to - from) * e);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// ticker tape across the header — click any name to analyze it
function renderTape() {
  const tape = $('#tape');
  const rows = calc.rows.filter((r) => r.assetClass === 'Equity' && r.dayChg != null).sort((a, b) => b.weight - a.weight);
  if (!rows.length) { tape.classList.add('hidden'); return; }
  tape.classList.remove('hidden');
  const spy = S.live ? S.stats.SPY?.periods?.['1D'] : S.base.benchmark?.snapshot?.SPY?.change;
  const item = (t, px, ch) => `<button class="tape-item" data-open="${t}"><b>${t}</b><span>${px}</span><span class="${cls(ch)}">${ch >= 0 ? '▲' : '▼'} ${fmt.spct(ch, 2).replace('+', '')}</span></button>`;
  const head = `<button class="tape-item" data-open=""><b style="color:var(--gold)">SMIF</b><span class="${cls(calc.dayPct)}">${fmt.spct(calc.dayPct, 2)}</span></button>` + (spy != null ? `<button class="tape-item" data-open="SPY"><b>S&amp;P 500</b><span class="${cls(spy)}">${fmt.spct(spy, 2)}</span></button>` : '');
  const html = head + rows.map((r) => item(r.ticker, fmt.usdC(r.price), r.dayChg)).join('');
  $('#tapeTrack').innerHTML = html + html; // doubled for a seamless loop
  $$('#tapeTrack [data-open]').forEach((b) => b.addEventListener('click', () => b.dataset.open ? openStock(b.dataset.open) : show('overview')));
}

function sectorData(basis) {
  const bw = S.base.benchmark?.sectorWeights || {};
  const list = SECTORS.map((s) => ({ s, smif: calc.sectors[s]?.[basis === 'equity' ? 'wEq' : 'wTotal'] || 0, spx: bw[s] || 0 }));
  Object.keys(calc.sectors).forEach((s) => { if (!SECTORS.includes(s)) list.push({ s, smif: calc.sectors[s][basis === 'equity' ? 'wEq' : 'wTotal'], spx: 0 }); });
  return list.sort((a, b) => b.spx - a.spx);
}
function renderSectorBars(id, basis) {
  const d = sectorData(basis).reverse();
  setChart(id, {
    grid: { left: 14, right: 30, top: 28, bottom: 20, containLabel: true },
    legend: { top: 0, right: 0, textStyle: { color: C.ink2 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p) => { const r = d[p[0].dataIndex]; return `<b>${r.s}</b><br>SMIF: ${fmt.pct(r.smif)}<br>S&P 500: ${fmt.pct(r.spx)}<br>Difference: ${fmt.pts(r.smif - r.spx)}`; } },
    xAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    yAxis: { type: 'category', data: d.map((x) => x.s), ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2, fontSize: 11, width: isMobile() ? 110 : 170, overflow: 'truncate' } },
    series: [
      { name: 'SMIF', type: 'bar', data: d.map((x) => x.smif), itemStyle: { color: C.gold, borderRadius: [0, 4, 4, 0] }, barGap: '15%', barWidth: '34%' },
      { name: 'S&P 500', type: 'bar', data: d.map((x) => x.spx), itemStyle: { color: C.gray, borderRadius: [0, 4, 4, 0] }, barWidth: '34%' },
    ],
  });
}

// ======================================================================
// Allocation
// ======================================================================
function renderAllocation() {
  const byS = {};
  calc.rows.forEach((r) => {
    const s = r.assetClass === 'Equity' ? r.sector || 'Other' : r.assetClass;
    (byS[s] = byS[s] || []).push(r);
  });
  if (calc.cash > 0) byS.Cash = [{ ticker: 'CASH', name: 'Uninvested cash', value: calc.cash, weight: calc.cash / calc.total, ret: null, dayChg: null }];
  const mode = S.tmColor;
  const data = Object.entries(byS).map(([s, rs]) => ({
    name: s,
    value: rs.reduce((a, r) => a + r.value, 0),
    itemStyle: { color: C.tile, borderColor: C.page, borderWidth: 3, gapWidth: 2 },
    children: rs.map((r) => {
      const v = mode === 'ret' ? r.ret : r.dayChg;
      return { name: r.ticker, value: r.value, r, itemStyle: { color: divColor(v, mode === 'ret' ? 1 : 0.04), borderRadius: 4 } };
    }),
  }));
  setChart('chTreemap', {
    tooltip: { ...tooltipBase, formatter: (p) => {
      const r = p.data.r;
      if (!r) return `<b>${p.name}</b><br>${fmt.usd(p.value)} · ${fmt.pct(p.value / calc.total)} of fund`;
      return `<b>${r.ticker}</b> ${esc(r.name)}<br>Value: ${fmt.usd(r.value)} (${fmt.pct(r.weight, 2)})<br>Return since buy: <b>${fmt.spct(r.ret)}</b><br>Today: ${fmt.spct(r.dayChg, 2)}`;
    } },
    series: [{
      type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, width: '100%', height: '100%', top: 0, left: 0,
      upperLabel: { show: true, height: isMobile() ? 20 : 24, color: C.goldText, fontWeight: 700, fontSize: isMobile() ? 10 : 12, backgroundColor: 'transparent', overflow: 'truncate', ellipsis: '',
        formatter: (p) => (p.name ? `${shortName(p.name)}  ${fmt.pct(p.value / calc.total, isMobile() ? 0 : 1)}` : '') },
      label: { show: true, color: '#fff', fontWeight: 700, fontSize: isMobile() ? 10 : 12, lineHeight: isMobile() ? 12 : 15, overflow: 'truncate', ellipsis: '',
        formatter: (p) => { const r = p.data.r; if (!r) return p.name; const v = mode === 'ret' ? r.ret : r.dayChg; return isMobile() ? p.name : `${p.name}\n{s|${fmt.spct(v, mode === 'ret' ? 0 : 1)}}`; },
        rich: { s: { fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.85)' } } },
      levels: [{ itemStyle: { borderColor: C.page, borderWidth: 4, gapWidth: 4 } }, { itemStyle: { gapWidth: 2 } }],
      data,
    }],
  }, (p) => p.data?.r && openStock(p.data.r.ticker));
  renderSectorBars('chSector', S.secBasis);
  const d = sectorData('equity').map((x) => ({ ...x, diff: x.smif - x.spx })).sort((a, b) => a.diff - b.diff);
  const band = S.settings.band / 100;
  const lim = Math.max(band, ...d.map((x) => Math.abs(x.diff))) + 0.012; // room for the value labels
  setChart('chActive', {
    grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p) => { const r = d[p.dataIndex]; return `<b>${r.s}</b><br>${r.diff >= 0 ? 'Overweight' : 'Underweight'} by ${Math.abs(r.diff * 100).toFixed(1)} pts<br>SMIF ${fmt.pct(r.smif)} vs S&P ${fmt.pct(r.spx)}`; } },
    xAxis: { type: 'value', min: -lim, max: lim, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, hideOverlap: true, formatter: (v) => (Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? (v > 0 ? '+' : '') + Math.round(v * 100) + ' pts' : '') } },
    yAxis: { type: 'category', data: d.map((x) => x.s), ...axisCommon, splitLine: { show: false }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.ink2, fontSize: isMobile() ? 10 : 12 } },
    series: [{ type: 'bar', barWidth: '55%', data: d.map((x) => ({ value: x.diff, label: { position: x.diff >= 0 ? 'right' : 'left' }, itemStyle: { color: x.diff >= 0 ? C.gold : C.blue, borderRadius: x.diff >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4], opacity: Math.abs(x.diff) > band ? 1 : 0.65 } })),
      label: { show: true, color: C.ink2, fontSize: 11, formatter: (p) => fmt.pts(p.value) },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: C.muted, type: 'dashed', opacity: 0.7 },
        label: { color: C.muted, fontSize: 10, position: 'end', distance: 4, formatter: (p) => (p.value > 0 ? '+' : '−') + S.settings.band + ' pts rebalance' },
        data: [{ xAxis: band }, { xAxis: -band }, { xAxis: 0, lineStyle: { type: 'solid', color: C.muted, opacity: 0.45 }, label: { show: false } }] } }],
  });

  // weights table grouped by sector
  const groups = Object.entries(byS).sort((a, b) => b[1].reduce((x, r) => x + r.value, 0) - a[1].reduce((x, r) => x + r.value, 0));
  const maxW = Math.max(...calc.rows.map((r) => r.weight));
  const spx = Object.fromEntries((S.base.spxConstituents || []).map((x) => [x.ticker, x.weight]));
  S.openSectors = S.openSectors || new Set();
  const th = (label, t) => `<th class="n" style="cursor:default">${label} ${tip(t)}</th>`;
  let html = `<thead><tr><th style="cursor:default">Sector / holding</th><th class="n" style="cursor:default">Value</th>${
    th('Weight (total)', 'Share of the WHOLE fund — stocks, bonds, money market and cash all included. Use this for position size (the IPS limits) and risk.')}${
    th('Weight in equities', 'Share of the STOCK portion only — cash, bonds and money market are left out. Use this to compare with the S&P 500, which is 100% stocks.')}${
    th('S&amp;P 500 weight', 'How much of the S&P 500 index this sector or stock makes up. Compare it with "Weight in equities" to see if we are over- or underweight.')}</tr></thead><tbody>`;
  groups.forEach(([s, rs], gi) => {
    const v = rs.reduce((a, r) => a + r.value, 0);
    const open = S.openSectors.has(s);
    html += `<tr class="sector-row fold-row${open ? ' open' : ''}" data-sector="${esc(s)}" tabindex="0" role="button" aria-expanded="${open}"><td><span class="caret">▸</span>${esc(s)} <span class="tag">${rs.length}</span></td><td class="n">${fmt.usd(v)}</td><td class="n">${fmt.pct(v / calc.total, 2)}</td><td class="n">${s in calc.sectors ? fmt.pct(calc.sectors[s].wEq, 2) : '—'}</td><td class="n">${S.base.benchmark.sectorWeights[s] != null ? fmt.pct(S.base.benchmark.sectorWeights[s], 2) : ''}</td></tr>`;
    rs.sort((a, b) => b.value - a.value).forEach((r) => {
      html += `<tr class="child-row clickable" data-parent="${esc(s)}" data-open="${r.ticker}" ${open ? '' : 'hidden'}><td style="padding-left:34px"><span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span></td><td class="n">${fmt.usd(r.value)}</td>
        <td class="n"><div class="wbar"><i style="width:${(r.weight / maxW) * 90}px"></i>${fmt.pct(r.weight, 2)}</div></td>
        <td class="n">${r.weightEq != null ? fmt.pct(r.weightEq, 2) : '—'}</td><td class="n">${spx[r.ticker] != null ? fmt.pct(spx[r.ticker], 2) : '—'}</td></tr>`;
    });
  });
  const tbl = $('#tblWeights');
  tbl.innerHTML = html + '</tbody>';
  const toggle = (row, force) => {
    const s = row.dataset.sector, open = force ?? !S.openSectors.has(s);
    open ? S.openSectors.add(s) : S.openSectors.delete(s);
    row.classList.toggle('open', open); row.setAttribute('aria-expanded', open);
    $$(`tr[data-parent="${CSS.escape(s)}"]`, tbl).forEach((tr) => (tr.hidden = !open));
  };
  $$('tr.fold-row', tbl).forEach((row) => {
    row.addEventListener('click', () => toggle(row));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(row); } });
  });
  $$('tr.child-row', tbl).forEach((tr) => tr.addEventListener('click', () => openStock(tr.dataset.open)));
  const btn = $('#wExpand');
  const syncBtn = () => (btn.textContent = S.openSectors.size === groups.length ? 'Collapse all' : 'Expand all');
  syncBtn();
  btn.onclick = () => { const all = S.openSectors.size !== groups.length; $$('tr.fold-row', tbl).forEach((r) => toggle(r, all)); syncBtn(); };
  $$('tr.fold-row', tbl).forEach((row) => row.addEventListener('click', syncBtn));
}

// ======================================================================
// Performance
// ======================================================================
function renderPerformance() {
  const pc = S.perfClass || 'all';
  const rows = calc.rows.filter((r) => r.ret != null && r.assetClass !== 'Money Market' && (pc === 'all' || (pc === 'eq' ? r.assetClass === 'Equity' : r.assetClass === 'Fixed Income')));
  const best = [...rows].sort((a, b) => b.ret - a.ret)[0];
  const worst = [...rows].sort((a, b) => a.ret - b.ret)[0];
  const winners = rows.filter((r) => r.ret > 0).length;
  $('#perfTiles').innerHTML = [
    ['Total unrealized gain', `<span class="${cls(calc.unrealized)}">${fmt.usd(calc.unrealized)}</span>`, `${fmt.spct(calc.unrealizedPct)} on ${fmt.usd(calc.costBasis)} cost`],
    ['Winners vs losers', `${winners} / ${rows.length - winners}`, `${fmt.pct(winners / rows.length, 0)} of positions are up`],
    ['Best performer', `<span class="up">${best?.ticker}</span>`, `${fmt.spct(best?.ret, 0)} since ${best?.purchaseDate || '—'}`],
    ['Worst performer', `<span class="down">${worst?.ticker}</span>`, `${fmt.spct(worst?.ret, 0)} since ${worst?.purchaseDate || '—'}`],
  ].map(([l, v, f]) => `<div class="card tile"><div class="label">${l}</div><div class="value">${v}</div><div class="foot">${f}</div></div>`).join('');

  const mode = S.perfMode;
  const key = { ret: 'ret', gl: 'gl', ann: 'annRet' }[mode];
  const sorted = [...rows].filter((r) => r[key] != null).sort((a, b) => b[key] - a[key]);
  $('#perfBarTitle').textContent = { ret: 'Return since purchase (%)', gl: 'Unrealized gain / loss ($)', ann: 'Annualized return (simple, as in the workbook)' }[mode];
  const f = mode === 'gl' ? (v) => fmt.usd(v) : (v) => fmt.spct(v, 0);
  const tipFmt = (p) => { const r = sorted[p.dataIndex]; return `<b>${r.ticker}</b> ${esc(r.name)}<br>Return: ${fmt.spct(r.ret)} · ${fmt.usd(r.gl)}<br>Avg cost ${fmt.usdC(r.avgCost)} → ${fmt.usdC(r.price)}<br>Held ${r.days} days (since ${r.purchaseDate})${mode === 'ann' && r.days < 180 ? '<br><i>Short holding — annualized figure is exaggerated</i>' : ''}`; };
  const valAxis = { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: mode === 'gl' ? (v) => fmt.big(v) : (v) => fmt.pct(v, 0) } };
  const barData = sorted.map((r) => ({ value: r[key], itemStyle: { color: r[key] >= 0 ? C.up : C.down } }));
  const dom = document.getElementById('chPerfBar');
  if (isMobile()) {
    // phones: horizontal bars so every ticker label fits
    dom.style.height = Math.max(420, sorted.length * 20 + 60) + 'px';
    setChart('chPerfBar', {
      grid: { left: 4, right: 52, top: 8, bottom: 24 },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: tipFmt, confine: true },
      xAxis: valAxis,
      yAxis: { type: 'category', data: sorted.map((r) => r.ticker), inverse: true, ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2, fontSize: 10, interval: 0 } },
      series: [{ type: 'bar', barWidth: '62%', data: barData.map((d) => ({ ...d, itemStyle: { ...d.itemStyle, borderRadius: d.value >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] } })),
        label: { show: true, position: 'right', color: C.muted, fontSize: 9, formatter: (p) => f(p.value) } }],
    }, (p) => openStock(sorted[p.dataIndex]?.ticker));
  } else {
    dom.style.height = '';
    setChart('chPerfBar', {
      grid: { left: 60, right: 20, top: 30, bottom: 60 },
      tooltip: { ...tooltipBase, trigger: 'item', formatter: tipFmt },
      xAxis: { type: 'category', data: sorted.map((r) => r.ticker), ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2, rotate: 60, fontSize: 10, interval: 0 } },
      yAxis: valAxis,
      series: [{ type: 'bar', barMaxWidth: 22, data: barData.map((d) => ({ ...d, itemStyle: { ...d.itemStyle, borderRadius: d.value >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
        label: { show: true, position: 'top', color: C.muted, fontSize: 9, formatter: (p) => (p.dataIndex < 3 || p.dataIndex > sorted.length - 4 ? f(p.value) : '') } }],
    }, (p) => openStock(sorted[p.dataIndex]?.ticker));
  }
  chart('chPerfBar').resize();

  const sc = rows.filter((r) => r.days > 90 && r.cagr != null);
  setChart('chHoldScatter', {
    grid: { left: 56, right: 24, top: 40, bottom: 44 },
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p) => { const r = sc[p.dataIndex]; return `<b>${r.ticker}</b><br>Held ${(r.days / 365.25).toFixed(1)} yrs<br>Annualized (compound): ${fmt.spct(r.cagr)}<br>Total: ${fmt.spct(r.ret)}<br>Weight ${fmt.pct(r.weight, 2)}`; } },
    xAxis: { type: 'value', name: 'Years held', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: C.muted }, ...axisCommon },
    yAxis: { type: 'value', name: 'Annualized return', nameTextStyle: { color: C.muted }, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    series: [{ type: 'scatter', data: sc.map((r) => [r.days / 365.25, r.cagr]), symbolSize: (v, p) => 8 + Math.sqrt(sc[p.dataIndex].weight) * 70,
      itemStyle: { color: 'rgba(255,198,41,0.55)', borderColor: '#0c0b0a', borderWidth: 2 },
      label: { show: true, formatter: (p) => sc[p.dataIndex].ticker, position: 'top', color: C.ink2, fontSize: 10 }, labelLayout: { hideOverlap: true },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: C.muted, type: 'dashed' }, data: [{ yAxis: 0 }], label: { show: false } } }],
  });
  $('#chHoldScatter').title = 'Holdings held under 90 days are left out — annualizing a few weeks of returns is misleading.';

  // heatmap of recent returns
  const per = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y'];
  const eq = calc.rows.filter((r) => r.assetClass === 'Equity').sort((a, b) => b.weight - a.weight);
  const getR = (t, p) => (S.live && S.stats[t]?.periods ? S.stats[t].periods[p] : S.base.snapshotReturns?.[t]?.[p]);
  $('#heatHint').textContent = S.live ? 'Live · price change over each window' : 'Workbook snapshot';
  const hd = [];
  eq.forEach((r, i) => per.forEach((p, j) => { const v = getR(r.ticker, p); hd.push([j, i, v == null ? '-' : +v.toFixed(4)]); }));
  setChart('chHeat', {
    grid: { left: 60, right: 10, top: 24, bottom: 60 },
    tooltip: { ...tooltipBase, formatter: (p) => `<b>${eq[p.value[1]].ticker}</b> · ${per[p.value[0]]}: ${p.value[2] === '-' ? 'n/a' : fmt.spct(p.value[2])}` },
    xAxis: { type: 'category', data: per, position: 'top', ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2 } },
    yAxis: { type: 'category', data: eq.map((r) => r.ticker), inverse: true, ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2, fontSize: 10 } },
    visualMap: { min: -0.25, max: 0.25, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 160, itemWidth: 10, text: ['+25%', '-25%'], textStyle: { color: C.muted }, inRange: { color: ['#c8443d', '#3a3835', '#1f9a5a'] } },
    series: [{ type: 'heatmap', data: hd, itemStyle: { borderColor: '#141210', borderWidth: 2, borderRadius: 3 },
      label: { show: true, fontSize: 9, color: '#fff', formatter: (p) => (p.value[2] === '-' ? '' : String(Math.round(p.value[2] * 100) || 0)) } }],
  });
  chart('chHeat').getDom().style.height = Math.max(420, eq.length * 17 + 90) + 'px';
  chart('chHeat').resize();
}

// ======================================================================
// Risk
// ======================================================================
const GLOSS = {
  beta: 'How much a stock tends to move when the S&P 500 moves 1%. 1.0 = moves with the market, 1.5 = 50% bigger swings, 0.5 = half as jumpy.',
  vol: 'Volatility: how much the price swings, annualized (standard deviation of daily returns × √252). 20% is typical for a large stock.',
  sharpe: 'Return earned above the risk-free rate, divided by volatility. It answers "was the return worth the bumpiness?" Above 1 is strong, below 0 means cash beat it.',
  sortino: 'Like Sharpe, but only counts downside swings as risk — upside volatility isn\'t penalized.',
  maxDD: 'Maximum drawdown: the worst drop from a peak to a later low over the past year. Shows the pain you would have sat through.',
  alpha: "Jensen's alpha: return above what the stock's beta alone would predict. Positive = beat its risk-adjusted expectation.",
  corr: 'Correlation with the S&P 500 (−1 to 1). Lower means it diversifies the fund more.',
  r52: 'Where today\'s price sits in its 52-week range — far left is near the low, far right near the high.',
};
function renderRisk() {
  $('#rfInput').value = (rf() * 100).toFixed(2);
  $('#glossary').innerHTML = [['Beta', GLOSS.beta], ['Volatility', GLOSS.vol], ['Sharpe ratio', GLOSS.sharpe], ['Sortino ratio', GLOSS.sortino], ['Max drawdown', GLOSS.maxDD], ['Alpha', GLOSS.alpha], ['Correlation', GLOSS.corr],
    ['Risk-free rate', `Return on a riskless investment (3-month T-bill). ${S.rfAuto != null ? `Auto-set from the 13-week T-bill yield (^IRX): ${fmt.pct(S.rfAuto, 2)}.` : 'Edit it above.'}`]]
    .map(([k, v]) => `<div><b>${k}</b>${esc(v)}</div>`).join('');
  if (!S.live || !S.pstats) {
    $('#riskTiles').innerHTML = `<div class="card span-2" style="grid-column:1/-1"><div class="empty"><b>Risk metrics need live market data</b>They're calculated from a year of daily prices pulled from Yahoo Finance by the site's server functions. Deploy the site (see README) and this page fills in automatically.</div></div>`;
    ['chRiskRet', 'chDD'].forEach((id) => emptyChart(id, 'Live data required'));
    $('#tblRisk').innerHTML = '';
    return;
  }
  const ps = S.pstats, bs = ps.benchStats;
  const t = [
    ['Beta', fmt.x(ps.beta), 'S&P 500 = 1.00', GLOSS.beta],
    ['Volatility', fmt.pct(ps.vol), `S&P 500: ${fmt.pct(bs.vol)}`, GLOSS.vol],
    ['Sharpe ratio', fmt.x(ps.sharpe), `S&P 500: ${fmt.x(bs.sharpe)}`, GLOSS.sharpe],
    ['Sortino ratio', fmt.x(ps.sortino), `S&P 500: ${fmt.x(bs.sortino)}`, GLOSS.sortino],
    ['1-year return', `<span class="${cls(ps.totalRet)}">${fmt.spct(ps.totalRet)}</span>`, `S&P 500: ${fmt.spct(bs.totalRet)}`, 'What today\'s holdings, at today\'s weights, returned over the past year (a backtest, not the fund\'s actual history).'],
    ['Max drawdown', `<span class="down">${fmt.pct(ps.maxDD)}</span>`, `S&P 500: ${fmt.pct(bs.maxDD)}`, GLOSS.maxDD],
    ['Alpha', `<span class="${cls(ps.alpha)}">${fmt.spct(ps.alpha)}</span>`, 'vs CAPM expectation', GLOSS.alpha],
    ['Correlation', fmt.x(ps.corr), 'with S&P 500', GLOSS.corr],
  ];
  $('#riskTiles').innerHTML = t.map(([l, v, f, g]) => `<div class="card tile"><div class="label">${l} ${tip(g)}</div><div class="value num">${v}</div><div class="foot">${f}</div></div>`).join('');
  if (ps.series.missing.length) $('#riskTiles').insertAdjacentHTML('beforeend', `<div class="warn-box" style="grid-column:1/-1">⚠ No price history for ${ps.series.missing.join(', ')} — left out of the risk calc.</div>`);

  const pts = calc.rows.filter((r) => S.stats[r.ticker] && r.assetClass !== 'Money Market');
  setChart('chRiskRet', {
    grid: { left: 56, right: 24, top: 40, bottom: 44 },
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p) => p.data.tip },
    xAxis: { type: 'value', name: 'Volatility (risk)', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: C.muted }, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    yAxis: { type: 'value', name: '1-year return', nameTextStyle: { color: C.muted }, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    series: [
      { name: 'Holdings', type: 'scatter', symbolSize: 10, itemStyle: { color: 'rgba(255,198,41,0.6)', borderColor: '#0c0b0a', borderWidth: 2 },
        data: pts.map((r) => { const s = S.stats[r.ticker]; return { value: [s.vol, s.periods['1Y']], tip: `<b>${r.ticker}</b><br>Vol ${fmt.pct(s.vol)} · 1Y ${fmt.spct(s.periods['1Y'])}<br>Beta ${fmt.x(s.beta)} · Sharpe ${fmt.x(s.sharpe)}` }; }),
        label: { show: true, formatter: (p) => pts[p.dataIndex].ticker, position: 'right', color: C.muted, fontSize: 9 }, labelLayout: { hideOverlap: true } },
      { name: 'Benchmarks', type: 'scatter', symbol: 'diamond', symbolSize: 18,
        data: [
          { value: [ps.vol, ps.totalRet], itemStyle: { color: C.gold, borderColor: '#fff', borderWidth: 1.5 }, tip: `<b>SMIF portfolio</b><br>Vol ${fmt.pct(ps.vol)} · 1Y ${fmt.spct(ps.totalRet)}` },
          { value: [bs.vol, bs.totalRet], itemStyle: { color: C.grayLight, borderColor: '#fff', borderWidth: 1.5 }, tip: `<b>S&P 500 (SPY)</b><br>Vol ${fmt.pct(bs.vol)} · 1Y ${fmt.spct(bs.totalRet)}` },
        ],
        label: { show: true, position: 'top', color: C.ink, fontWeight: 700, formatter: (p) => (p.dataIndex === 0 ? 'SMIF' : 'S&P 500') } },
    ],
  });
  const bdd = ps.benchStats.dd;
  setChart('chDD', {
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    legend: { top: 0, right: 0, textStyle: { color: C.ink2 }, icon: 'roundRect', itemWidth: 12, itemHeight: 3 },
    tooltip: { ...tooltipBase, trigger: 'axis', valueFormatter: (v) => fmt.pct(v) },
    xAxis: { type: 'category', data: ps.series.dates, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => axisDate(v, 'short') } },
    yAxis: { type: 'value', max: 0, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    series: [
      { name: 'SMIF', type: 'line', data: ps.dd, showSymbol: false, lineStyle: { color: C.gold, width: 2 }, itemStyle: { color: C.gold }, areaStyle: { color: 'rgba(255,198,41,0.15)' } },
      { name: 'S&P 500', type: 'line', data: bdd, showSymbol: false, lineStyle: { color: C.grayLight, width: 2 }, itemStyle: { color: C.grayLight } },
    ],
  });

  const rows = pts.map((r) => {
    const s = S.stats[r.ticker];
    return { ...r, beta: s.beta, vol: s.vol, sharpe: s.sharpe, sortino: s.sortino, maxDD: s.maxDD, r1y: s.periods['1Y'], corr: s.corr, betaContrib: r.weight * (s.beta ?? 0), pos52: s.high52 > s.low52 ? (r.price - s.low52) / (s.high52 - s.low52) : null };
  });
  sortableTable('#tblRisk', [
    { k: 'ticker', l: 'Ticker', f: (r) => `<span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span>` },
    { k: 'assetClass', l: 'Class', f: (r) => acTag(r.assetClass) },
    { k: 'weight', l: 'Weight', n: 1, f: (r) => fmt.pct(r.weight, 2) },
    { k: 'beta', l: 'Beta', n: 1, f: (r) => fmt.x(r.beta), t: GLOSS.beta },
    { k: 'betaContrib', l: 'Beta contribution', n: 1, f: (r) => fmt.x(r.betaContrib, 3), t: 'Weight × beta. Adds up to the portfolio\'s weighted beta — shows which positions drive market sensitivity.' },
    { k: 'vol', l: 'Volatility', n: 1, f: (r) => fmt.pct(r.vol), t: GLOSS.vol },
    { k: 'sharpe', l: 'Sharpe', n: 1, f: (r) => `<span class="${cls(r.sharpe)}">${fmt.x(r.sharpe)}</span>`, t: GLOSS.sharpe },
    { k: 'sortino', l: 'Sortino', n: 1, f: (r) => fmt.x(r.sortino), t: GLOSS.sortino },
    { k: 'maxDD', l: 'Max drawdown', n: 1, f: (r) => `<span class="down">${fmt.pct(r.maxDD)}</span>`, t: GLOSS.maxDD },
    { k: 'corr', l: 'Corr. to S&P', n: 1, f: (r) => fmt.x(r.corr), t: GLOSS.corr },
    { k: 'r1y', l: '1Y return', n: 1, f: (r) => `<span class="${cls(r.r1y)}">${fmt.spct(r.r1y)}</span>` },
    { k: 'pos52', l: '52-wk range', n: 1, f: (r) => (r.pos52 == null ? '—' : `<div class="range52" style="width:90px;display:inline-block;margin:0"><i style="left:${r.pos52 * 100}%;width:10px;height:10px;top:-2px"></i></div>`), t: GLOSS.r52 },
  ], rows, 'betaContrib');
}

// generic sortable table
function sortableTable(sel, cols, rows, defKey, defDir = -1) {
  const el = $(sel);
  el._st = el._st || { k: defKey, d: defDir };
  const draw = () => {
    const { k, d } = el._st;
    const data = [...rows].sort((a, b) => { const x = a[k], y = b[k]; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d; });
    el.innerHTML = `<thead><tr>${cols.map((c) => `<th data-k="${c.k}" class="${c.n ? 'n' : ''}">${c.l}${c.t ? ' ' + tip(c.t) : ''}${k === c.k ? `<span class="arr">${d > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${data.map((r) => `<tr${r.ticker && !CASH_LIKE.has(r.ticker) && r.ticker !== 'SNOXX' ? ` class="clickable" ${el.id === 'tblFormer' ? 'data-hist' : 'data-open'}="${r.ticker}"` : ''}>${cols.map((c) => `<td class="${c.n ? 'n' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $$('tbody tr[data-open]', el).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('.tip, input, button, a')) openStock(tr.dataset.open); }));
    $$('th', el).forEach((th) => th.addEventListener('click', (e) => {
      if (e.target.classList.contains('tip')) return;
      const nk = th.dataset.k;
      el._st = { k: nk, d: el._st.k === nk ? -el._st.d : nk === 'ticker' || nk === 'name' || nk === 'sector' ? 1 : -1 };
      draw();
    }));
  };
  draw();
}

// ======================================================================
// Holdings
// ======================================================================
function renderHoldings() {
  const sel = $('#hSector');
  const secs = [...new Set(calc.rows.map((r) => r.sector).filter(Boolean))].sort();
  if (sel.options.length !== secs.length + 1) sel.innerHTML = '<option value="">All sectors / classes</option>' + secs.map((s) => `<option>${esc(s)}</option>`).join('');
  const q = $('#hSearch').value.trim().toLowerCase();
  const sec = sel.value, ac = $('#hClass').value;
  const rows = calc.rows.filter((r) => (!q || r.ticker.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)) && (!sec || r.sector === sec) && (!ac || r.assetClass === ac));
  sortableTable('#tblHoldings', [
    { k: 'ticker', l: 'Holding', f: (r) => `<span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span>` },
    { k: 'assetClass', l: 'Class', f: (r) => acTag(r.assetClass) },
    { k: 'sector', l: 'Sector', f: (r) => (r.assetClass === 'Equity' ? `<span class="tag">${esc(r.sector)}</span>` : '<span style="color:var(--muted)">—</span>') },
    { k: 'quantity', l: 'Shares', n: 1, f: (r) => fmt.n(r.quantity, 2) },
    { k: 'avgCost', l: 'Avg cost', n: 1, f: (r) => fmt.usdC(r.avgCost) },
    { k: 'price', l: 'Price', n: 1, f: (r) => fmt.usdC(r.price) + (r.live ? '' : ' <span title="Snapshot price" style="color:var(--muted)">•</span>') },
    { k: 'dayChg', l: 'Today', n: 1, f: (r) => `<span class="${cls(r.dayChg)}">${fmt.spct(r.dayChg, 2)}</span>` },
    { k: 'value', l: 'Market value', n: 1, f: (r) => fmt.usd(r.value) },
    { k: 'weight', l: 'Weight', n: 1, f: (r) => fmt.pct(r.weight, 2) },
    { k: 'gl', l: 'Unrealized G/L', n: 1, f: (r) => `<span class="${cls(r.gl)}">${fmt.usd(r.gl)}</span>` },
    { k: 'ret', l: '% return', n: 1, f: (r) => `<span class="${cls(r.ret)}">${fmt.spct(r.ret)}</span>` },
    { k: 'purchaseDate', l: 'First bought', n: 1, f: (r) => r.purchaseDate || '—' },
    { k: 'days', l: 'Days held', n: 1, f: (r) => fmt.n(r.days) },
    { k: 'annRet', l: 'Annualized', n: 1, f: (r) => `<span class="${cls(r.annRet)}">${fmt.spct(r.annRet)}</span>`, t: 'Return ÷ years held — same formula as the workbook. Exaggerated for very recent buys.' },
    { k: 'hist', l: 'History', f: (r) => (S.hist?.tickers[r.ticker] ? `<button class="btn sm hist-btn" data-hist="${r.ticker}">🕘 ${S.hist.tickers[r.ticker].trades.length}</button>` : '') },
  ], rows, 'value');
  renderHistoryLists();
}

// ---------- fund trading history (from the Schwab transaction export) ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// chart axis dates, month first: "Mar 2024" (long ranges), "Mar '24" (1–3 years), "Mar 15" (short ranges)
const axisDate = (v, mode) => {
  const [y, m, d] = String(v).slice(0, 10).split('-');
  if (!m) return v;
  const mo = MON[+m - 1];
  return mode === 'long' ? `${mo} ${y}` : mode === 'short' ? `${mo} ${+d}` : `${mo} '${y.slice(2)}`;
};
const fdate = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'today');
const yearsBetween = (a, b) => ((b ? new Date(b) : new Date()) - new Date(a)) / (365.25 * 86400000);
const heldFor = (a, b) => { const y = yearsBetween(a, b); return y >= 1 ? `${y.toFixed(1)} yrs` : `${Math.max(1, Math.round(y * 12))} mo`; };
const TYPE_CLS = { Buy: 'buy', Sell: 'sell', 'Spin-off': 'evt', Merger: 'evt', 'Ticker change': 'evt', Split: 'evt', 'Stock dividend': 'evt', 'Cash in lieu': 'evt', 'Shares received': 'evt', 'Shares removed': 'evt' };

const ADJ = new Set(['Cash in lieu', 'Stock dividend']);
const TYPE_TIP = {
  'Cash in lieu': 'Cash in lieu of fractional shares. The company paid part of its dividend in stock; we can only hold whole shares, so Schwab automatically sold the leftover fraction and paid us cash. Not a trade decision.',
  'Stock dividend': 'The company paid part of its dividend in extra shares instead of cash. Any fraction is paid out in cash shortly after (see "Cash in lieu").',
};
const MONEY_TYPES = new Set(['Buy', 'Sell', 'Cash in lieu']);
function txTableHTML(sym, limit) {
  const h = S.hist.tickers[sym];
  const all = [...h.trades].reverse();
  const rows = S.showAdj ? all : all.filter((t) => !ADJ.has(t.type));
  const hidden = all.length - rows.length;
  const rowHTML = (t) => `<tr${ADJ.has(t.type) ? ' class="adj-row"' : ''}><td>${fdate(t.date)}</td><td><span class="ttype ${TYPE_CLS[t.type] || 'evt'}">${esc(t.type)}</span>${TYPE_TIP[t.type] ? ' ' + tip(TYPE_TIP[t.type]) : ''}</td><td class="n">${fmt.n(t.shares, 2)}</td>
    <td class="n">${t.price && MONEY_TYPES.has(t.type) ? fmt.usdC(t.price) : '—'}</td><td class="n">${t.amount && MONEY_TYPES.has(t.type) ? fmt.usd(t.amount) : '—'}</td><td class="n">${fmt.n(t.after, 2)}</td></tr>`;
  return `<div class="table-wrap hist-table"><table><thead><tr><th style="cursor:default">Date</th><th style="cursor:default">Action</th><th class="n" style="cursor:default">Shares</th><th class="n" style="cursor:default">Price</th><th class="n" style="cursor:default">Amount</th><th class="n" style="cursor:default">Shares after</th></tr></thead>
    <tbody>${rows.slice(0, limit).map(rowHTML).join('')}</tbody></table></div>
    ${hidden ? `<div class="hint" style="color:var(--muted);font-size:12px;margin-top:6px">${hidden} dividend adjustment${hidden > 1 ? 's' : ''} hidden (stock dividends and cash in lieu of fractional shares). These are automatic, not trades.</div>` : ''}
    ${rows.length > limit ? `<button class="btn sm mt hist-all" data-hist="${esc(sym)}">See all ${rows.length} transactions</button>` : ''}`;
}
document.addEventListener('change', (e) => {
  if (!e.target.classList?.contains('adjToggle')) return;
  S.showAdj = e.target.checked; store.set('showAdj', S.showAdj);
  document.querySelectorAll('.adjToggle').forEach((x) => (x.checked = S.showAdj));
  document.querySelectorAll('.hist-tx').forEach((w) => (w.innerHTML = txTableHTML(w.dataset.sym, +w.dataset.limit)));
});

// Banner on the stock card for a stock the fund used to own: when we exited, at what price, and how it has done since.
function prevOwnedHTML(s) {
  const h = S.hist?.tickers?.[s.symbol];
  if (s.held || !h?.periods?.length) return '';
  const last = h.periods[h.periods.length - 1];
  const sells = h.trades.filter((t) => t.type === 'Sell' && Math.abs(t.shares) > 0.999 && t.date <= (last.to || '9999'));
  const ls = sells[sells.length - 1];
  const px = ls ? ls.price || Math.abs(ls.amount) / Math.abs(ls.shares) : null;
  const since = px && s.price ? s.price / px - 1 : null;
  const spans = h.periods.map((p) => `${fdate(p.from)} – ${fdate(p.to)}`).join(' · ');
  const bits = [
    `<span class="po-k">Last position sold</span><b>${fdate(last.to)}</b>${px ? ` at ${fmt.usdC(px)}` : ''}`,
    since != null ? `<span class="po-k">Since we sold</span><b class="${cls(since)}">${fmt.spct(since)}</b>${s.price ? ` (now ${fmt.usdC(s.price)})` : ''}` : '',
    `<span class="po-k">Realized gain</span><b class="${cls(h.realized)}">${fmt.usd(h.realized)}</b>`,
    `<span class="po-k">Owned</span><b>${h.periods.length === 1 ? 'once' : h.periods.length + ' times'}</b>`,
  ].filter(Boolean).map((x) => `<div>${x}</div>`).join('');
  return `<div class="prev-owned mt" role="note">
    <div class="po-head"><span class="po-badge">🕘 Previously owned</span><span class="po-span">${spans}</span><button class="btn sm ghost po-more" type="button" onclick="const d=document.querySelector('[data-fold=hist]');if(d){d.open=true;d.scrollIntoView({behavior:'smooth',block:'start'})}">Full history</button></div>
    <div class="po-grid">${bits}</div></div>`;
}

function historyHTML(sym, opts = {}) {
  const h = S.hist?.tickers?.[sym];
  if (!S.hist) return '';
  if (!h) return `<div class="hist-status never"><b>Never owned.</b> The fund has no record of trading ${esc(sym)} since ${fdate(S.hist.from)}.</div>`;
  const cur = h.periods.find((p) => !p.to);
  const past = h.periods.filter((p) => p.to);
  const status = cur
    ? `<div class="hist-status now"><b>We own ${esc(sym)}</b> — holding since ${fdate(cur.from)} (${heldFor(cur.from)})${past.length ? ` · also owned it ${past.length === 1 ? 'once' : past.length + ' times'} before` : ''}.</div>`
    : `<div class="hist-status past"><b>We used to own ${esc(sym)}</b> — ${past.map((p) => `${fdate(p.from)} → ${fdate(p.to)}`).join(' · ')}.</div>`;
  // timeline
  const t0 = h.trades[0].date, span = Math.max(1, (new Date() - new Date(t0)) / 86400000);
  const pos = (d) => (((d ? new Date(d) : new Date()) - new Date(t0)) / 86400000 / span) * 100;
  const y0 = +t0.slice(0, 4), y1 = new Date().getFullYear();
  const step = Math.max(1, Math.ceil((y1 - y0) / 6));
  const ticks = [];
  for (let y = y0 + 1; y <= y1; y += step) ticks.push(`<span style="left:${pos(`${y}-01-01`)}%">${y}</span>`);
  const bars = h.periods.map((p) => `<i class="${p.to ? '' : 'open'}" style="left:${pos(p.from)}%;width:${Math.max(0.8, pos(p.to) - pos(p.from))}%" title="${fdate(p.from)} → ${fdate(p.to)}"></i>`).join('');
  const dots = h.trades.filter((t) => t.type === 'Buy' || t.type === 'Sell').map((t) => `<b class="${t.type === 'Buy' ? 'b' : 's'}" style="left:${pos(t.date)}%" title="${t.type} ${fmt.n(t.shares, 2)} on ${fdate(t.date)}"></b>`).join('');
  const timeline = `<div class="hist-tl"><div class="track">${bars}${dots}</div><div class="ticks">${ticks.join('')}</div>
    <div class="legend"><span><i class="lg-held"></i>Held</span><span><b class="b"></b>Buy</span><span><b class="s"></b>Sell</span></div></div>`;
  const realizedTip = 'Profit or loss locked in by selling, using the average-cost method. Schwab\'s tax lots can differ slightly.';
  const stats = `<div class="metrics hist-metrics">
    ${metric('Times owned', h.periods.length, cur ? 'Holding now' : 'Fully sold')}
    ${metric('Total bought', fmt.usd(h.bought), '')}
    ${metric('Total sold', fmt.usd(h.sold), '')}
    ${metric('Realized gain', `<span class="${cls(h.realized)}">${fmt.usd(h.realized)}</span>`, 'From shares sold', realizedTip)}
    ${metric('Dividends received', fmt.usd(h.dividends), h.foreignTax ? `after ${fmt.usd(h.foreignTax)} foreign tax` : '', 'All cash dividends and distributions paid to the fund while we owned it.')}
  </div>`;
  const hasAdj = h.trades.some((t) => ADJ.has(t.type));
  const toggle = hasAdj ? `<label class="switch adj-toggle" title="Stock dividends and the cash paid for leftover fractional shares — automatic, not fund decisions"><input type="checkbox" class="adjToggle"${S.showAdj ? ' checked' : ''} /><span class="track"><i></i></span>Show dividend adjustments</label>` : '';
  const table = `<div class="hist-tx" data-sym="${esc(sym)}" data-limit="${opts.limit || 8}">${txTableHTML(sym, opts.limit || 8)}</div>`;
  return status + timeline + stats + `<div class="row mt" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;min-width:0"><h3 style="margin:0">Transactions</h3>${toggle}</div>` + table;
}

function openHistory(sym) {
  const h = S.hist?.tickers?.[sym];
  const b = modal(`<div class="row" style="justify-content:space-between"><h2>${esc(sym)} <span style="color:var(--muted);font-weight:500;font-size:14px">${esc(h?.name || '')}</span></h2><button class="btn sm" id="hmClose">✕</button></div>
    ${historyHTML(sym, { limit: 500 })}
    <div class="row"><button class="btn sm" id="hmOpen">Analyze ${esc(sym)} in the Trade Lab →</button></div>`);
  $('#modalBody').classList.add('wide');
  $('#hmClose', b).onclick = closeModal;
  $('#hmOpen', b).onclick = () => { closeModal(); openStock(sym); };
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-hist]');
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  openHistory(btn.dataset.hist);
}, true);

let tlShown = 40;
function renderHistoryLists() {
  const H = S.hist;
  if (!H) { $('#histTiles').innerHTML = ''; $('#tblFormer').innerHTML = '<tbody><tr><td class="empty">Upload the Schwab transaction history on the Master Copy page to see former holdings.</td></tr></tbody>'; $('#tblTrades').innerHTML = ''; $('#tlMore').style.display = 'none'; return; }
  const all = Object.values(H.tickers).filter((t) => t.ticker !== 'SNOXX');
  const former = all.filter((t) => !t.periods.some((p) => !p.to) && t.periods.length);
  const yrs = yearsBetween(H.from);
  $('#histTiles').innerHTML = [
    ['Stocks owned since ' + H.from.slice(0, 4), fmt.n(all.filter((t) => t.periods.length).length), `${calc.nEquity + calc.rows.filter((r) => r.assetClass === 'Fixed Income').length} held today · ${former.length} sold`],
    ['Buys & sells', fmt.n(H.totals.trades), `over ${yrs.toFixed(0)} years`],
    ['Realized gains', `<span class="${cls(H.totals.realized)}">${fmt.usd(H.totals.realized)}</span>`, 'locked in by selling (average cost)'],
    ['Dividends received', fmt.usd(H.totals.dividends), `since ${fdate(H.from)}`],
  ].map(([l, v, f]) => `<div class="card tile"><div class="label">${l}</div><div class="value num">${v}</div><div class="foot">${f}</div></div>`).join('');
  const q = ($('#fhSearch').value || '').trim().toLowerCase();
  const rows = former.filter((t) => !q || t.ticker.toLowerCase().includes(q) || (t.name || '').toLowerCase().includes(q)).map((t) => {
    const last = t.periods[t.periods.length - 1];
    return { ...t, assetClass: assetClassOf(t.ticker, t.name, currentClasses()), from: t.periods[0].from, to: last.to, held: t.periods.reduce((a, p) => a + yearsBetween(p.from, p.to), 0) };
  });
  sortableTable('#tblFormer', [
    { k: 'ticker', l: 'Holding', f: (r) => `<span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span>` },
    { k: 'assetClass', l: 'Class', f: (r) => acTag(r.assetClass || assetClassOf(r.ticker, r.name, currentClasses())) },
    { k: 'from', l: 'First bought', n: 1, f: (r) => fdate(r.from) },
    { k: 'to', l: 'Last sold', n: 1, f: (r) => fdate(r.to) },
    { k: 'held', l: 'Time held', n: 1, f: (r) => (r.held >= 1 ? r.held.toFixed(1) + ' yrs' : Math.max(1, Math.round(r.held * 12)) + ' mo') + (r.periods.length > 1 ? ` <span class="tag">${r.periods.length}×</span>` : '') },
    { k: 'realized', l: 'Realized gain', n: 1, f: (r) => `<span class="${cls(r.realized)}">${fmt.usd(r.realized)}</span>`, t: 'Profit or loss from selling, average-cost method.' },
    { k: 'dividends', l: 'Dividends', n: 1, f: (r) => fmt.usd(r.dividends) },
    { k: 'hist', l: '', f: (r) => `<button class="btn sm hist-btn" data-hist="${r.ticker}">History</button>` },
  ], rows.map((r) => ({ ...r, ticker: r.ticker })), 'to');
  // trade log
  const type = $('#tlType').value, tq = ($('#tlSearch').value || '').trim().toUpperCase();
  const trades = [];
  all.forEach((t) => t.trades.forEach((x) => { if ((x.type === 'Buy' || x.type === 'Sell') && (!type || x.type === type) && (!tq || t.ticker.includes(tq))) trades.push({ ...x, ticker: t.ticker, name: t.name }); }));
  trades.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.ticker.localeCompare(b.ticker)));
  $('#tblTrades').innerHTML = `<thead><tr><th style="cursor:default">Date</th><th style="cursor:default">Action</th><th style="cursor:default">Holding</th><th style="cursor:default">Class</th><th class="n" style="cursor:default">Shares</th><th class="n" style="cursor:default">Price</th><th class="n" style="cursor:default">Amount</th></tr></thead><tbody>${
    trades.slice(0, tlShown).map((t) => `<tr class="clickable" data-hist="${t.ticker}"><td>${fdate(t.date)}</td><td><span class="ttype ${t.type === 'Buy' ? 'buy' : 'sell'}">${t.type}</span></td><td><span class="tk">${t.ticker}</span><span class="nm">${esc(t.name)}</span></td><td>${acTag(assetClassOf(t.ticker, t.name, currentClasses()))}</td><td class="n">${fmt.n(t.shares, 2)}</td><td class="n">${fmt.usdC(t.price)}</td><td class="n">${fmt.usd(t.amount)}</td></tr>`).join('')}</tbody>`;
  $('#tlMore').style.display = trades.length > tlShown ? '' : 'none';
  $('#tlMore').textContent = `Show more (${trades.length - tlShown} left)`;
}

// ======================================================================
// Screener & trade lab
// ======================================================================
function universe() {
  const m = new Map();
  const put = (sym, o) => m.set(sym, { ...(m.get(sym) || {}), symbol: sym, ...o });
  Object.values(S.hist?.tickers || {}).forEach((t) => t.name && put(t.ticker, { name: t.name, past: true }));
  [['SPY', 'SPDR S&P 500 ETF (S&P 500 index)'], ['AGG', 'iShares Core US Aggregate Bond ETF'], ['QQQ', 'Invesco QQQ (Nasdaq-100)'], ['DIA', 'SPDR Dow Jones Industrial Average ETF'], ['IWM', 'iShares Russell 2000 ETF'], ['BIL', 'SPDR 1-3 Month T-Bill ETF']].forEach(([t, n]) => put(t, { name: n, type: 'ETF' }));
  (S.base.spxConstituents || []).forEach((x) => put(x.ticker, { name: x.name, sector: x.sector, spx: x.weight }));
  [...(S.base.watchlist || []), ...(S.base.focusList || [])].forEach((t) => { if (!m.has(t)) put(t, { name: '', type: 'Watchlist' }); });
  S.base.holdings.forEach((h) => put(h.ticker, { name: h.name, sector: h.sector, held: true }));
  return [...m.values()];
}
// ---------- broad search: tickers, company names, nicknames, missing spaces/hyphens and small typos ----------
// "t mobile", "tmobile", "T-Mobile" → TMUS · "coke" → KO · "nvida" → NVDA
const normQ = (x) => String(x || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const NAME_JUNK = /\b(inc|incorporated|corp|corporation|company|co|ltd|limited|plc|holdings?|group|the|class [a-c]|common stock|n\.?v|s\.?a|ag|se|lp|trust)\b\.?/gi;
const SEARCH_ALIASES = { tmobile: 'TMUS', google: 'GOOGL', alphabet: 'GOOGL', facebook: 'META', coke: 'KO', cocacola: 'KO', pepsi: 'PEP', jpmorgan: 'JPM', jpm: 'JPM', chase: 'JPM', berkshire: 'BRK-B', att: 'T', walmart: 'WMT', mcdonalds: 'MCD', exxon: 'XOM', goldman: 'GS', goldmansachs: 'GS', bofa: 'BAC', bankofamerica: 'BAC', wellsfargo: 'WFC', unitedhealth: 'UNH', lilly: 'LLY', elililly: 'LLY', jnj: 'JNJ', johnsonandjohnson: 'JNJ', pg: 'PG', proctergamble: 'PG', proctorandgamble: 'PG', proctorgamble: 'PG', amex: 'AXP', homedepot: 'HD', lockheed: 'LMT', lockheedmartin: 'LMT', raytheon: 'RTX', disney: 'DIS', sp500: 'SPY', snp500: 'SPY', snp: 'SPY', sandp: 'SPY', sandp500: 'SPY', nasdaq: 'QQQ', dow: 'DIA', russell: 'IWM', tbills: 'BIL', bonds: 'AGG', tsmc: 'TSM', taiwansemi: 'TSM', taiwansemiconductor: 'TSM', toyota: 'TM', sony: 'SONY', asml: 'ASML', alibaba: 'BABA', shopify: 'SHOP', spotify: 'SPOT', palantir: 'PLTR', coinbase: 'COIN', robinhood: 'HOOD', snowflake: 'SNOW', airbnb: 'ABNB', blackrock: 'BLK', cvs: 'CVS', ups: 'UPS', fedex: 'FDX', ibm: 'IBM', amd: 'AMD', hp: 'HPQ', dell: 'DELL', ge: 'GE', gm: 'GM', ford: 'F', tesla: 'TSLA', nvidia: 'NVDA', microsoft: 'MSFT', apple: 'AAPL', amazon: 'AMZN', netflix: 'NFLX', costco: 'COST', starbucks: 'SBUX', nike: 'NKE', boeing: 'BA', intel: 'INTC', broadcom: 'AVGO', salesforce: 'CRM', oracle: 'ORCL', paypal: 'PYPL', visa: 'V', mastercard: 'MA', verizon: 'VZ', chevron: 'CVX', pfizer: 'PFE', merck: 'MRK', abbvie: 'ABBV', uber: 'UBER' };
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > max) return max + 1; prev = cur;
  }
  return prev[b.length];
}
function findSymbols(q) {
  const qn = normQ(q); if (!qn) return [];
  const qw = String(q).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const alias = SEARCH_ALIASES[qn];
  const out = [];
  universe().forEach((x) => {
    const sn = normQ(x.symbol), clean = String(x.name || '').replace(NAME_JUNK, ' '), nn = normQ(clean);
    const words = clean.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let sc = 0;
    if (sn === qn) sc = 100;
    else if (alias === x.symbol) sc = 96;
    else if (nn && nn === qn) sc = 92;
    else if (nn.startsWith(qn) && qn.length >= 2) sc = 82;
    else if (qn.length <= 5 && sn.startsWith(qn)) sc = 76;
    else if (qw.length && qw.every((w) => words.some((n) => n.startsWith(w)))) sc = 72;
    else if (qn.length >= 3 && nn.includes(qn)) sc = 62;
    else if (qn.length >= 4) {
      const max = qn.length >= 8 ? 2 : 1;
      if (lev(nn.slice(0, qn.length), qn, max) <= max || words.some((w) => w.length >= 4 && lev(w, qn, max) <= max)) sc = 45;
    }
    if (sc) out.push({ ...x, score: sc });
  });
  if (alias && !out.some((x) => x.symbol === alias)) out.push({ symbol: alias, name: '', score: 96 });
  return out.sort((a, b) => b.score - a.score || (b.held ? 1 : 0) - (a.held ? 1 : 0) || (b.spx || 0) - (a.spx || 0) || (b.past ? 1 : 0) - (a.past ? 1 : 0));
}
// Turn whatever was typed into a ticker: exact ticker → it; otherwise the best name match; otherwise Yahoo's search.
async function resolveSymbol(q) {
  const raw = String(q || '').trim(); if (!raw) return '';
  const tick = raw.toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
  const hits = findSymbols(raw);
  if (hits[0] && (hits[0].score >= 96 || hits[0].symbol === tick)) return hits[0].symbol;
  const tickerish = /^[A-Za-z]{1,5}([.\-][A-Za-z]{1,2})?$/.test(raw);
  if (hits[0] && hits[0].score >= 60 && !(tickerish && raw === raw.toUpperCase())) return hits[0].symbol;
  if (S.api && !(tickerish && raw === raw.toUpperCase())) {
    try {
      const r = await getJSON(`/api/profile?q=${encodeURIComponent(raw)}`, {}, 4000);
      const y = r.results?.[0], qn = normQ(raw);
      // trust Yahoo's top hit if it looks like what was typed; otherwise prefer our own close match (typos like "nvida")
      const looks = y && (normQ(y.symbol).startsWith(qn.slice(0, 3)) || lev(normQ(String(y.name || '').replace(NAME_JUNK, ' ')).slice(0, qn.length), qn, 2) <= 2 || normQ(y.name).includes(qn));
      if (y && (looks || !hits[0] || hits[0].score < 45)) return y.symbol;
    } catch { /* fall through */ }
  }
  if (hits[0] && hits[0].score >= 45 && !(tickerish && raw === raw.toUpperCase())) return hits[0].symbol;
  return tick;
}
// one search box with a suggestion list (used by the screener and the compare box)
function attachSearch(input, box, pick) {
  let idx = -1, timer;
  const show = (list) => {
    idx = -1;
    if (!list.length) { box.classList.remove('open'); return; }
    box.innerHTML = list.slice(0, 8).map((x) => `<div data-s="${esc(x.symbol)}"><span><b>${esc(x.symbol)}</b> ${esc(x.name || '')}</span><small>${x.held ? 'HELD · ' : x.past ? 'PAST · ' : ''}${esc(x.sector || x.exchange || x.type || '')}</small></div>`).join('');
    box.classList.add('open');
    $$('div', box).forEach((d) => d.addEventListener('mousedown', (e) => { e.preventDefault(); box.classList.remove('open'); pick(d.dataset.s); }));
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (!q) return show([]);
    const local = findSymbols(q);
    show(local);
    clearTimeout(timer);
    if (S.api && q.length >= 2) timer = setTimeout(async () => {
      try {
        const r = await getJSON(`/api/profile?q=${encodeURIComponent(q)}`, {}, 6000);
        if (input.value.trim() !== q) return;
        const seen = new Set(local.map((x) => x.symbol));
        show([...local, ...r.results.filter((x) => !seen.has(x.symbol))]);
      } catch { /* local suggestions are enough */ }
    }, 280);
  });
  input.addEventListener('keydown', async (e) => {
    const items = $$('div', box);
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) { e.preventDefault(); idx = Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((d, i) => d.classList.toggle('hl', i === idx)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = idx >= 0 && items[idx] ? items[idx].dataset.s : await resolveSymbol(input.value);
      box.classList.remove('open'); pick(v);
    }
    if (e.key === 'Escape') box.classList.remove('open');
  });
  input.addEventListener('blur', () => setTimeout(() => box.classList.remove('open'), 150));
}

// Market cap at the last price. If Yahoo's figure is missing (or the profile is an older saved copy),
// rebuild it from shares outstanding × the latest price.
function withMarketCap(prof, price) {
  if (!prof) return prof;
  const p = { ...prof };
  if (p.sharesOutstanding && price && (p.marketCap == null || p.stale)) { p.marketCap = p.sharesOutstanding * price; p.capNote = 'shares × last price'; }
  else if (p.marketCap != null) p.capNote = p.capSource && p.capSource !== 'Yahoo' ? p.capSource : '';
  return p;
}
async function retryProfile(sym) {
  for (const wait of [1500, 4000]) {
    await new Promise((r) => setTimeout(r, wait));
    if (S.stock?.symbol !== sym) return;
    try {
      const p = await getJSON(`/api/profile?symbol=${encodeURIComponent(sym)}`, {}, 8000);
      if (S.stock?.symbol !== sym || !p) return;
      S.stock.prof = withMarketCap(p, S.stock.price);
      const box = $('#valFold'); if (box) box.outerHTML = valuationHTML(S.stock);
      refreshIps(); return;
    } catch { /* try again */ }
  }
  if (S.stock?.symbol === sym) { S.stock.profFailed = true; refreshIps(); }
}
async function analyze(sym) {
  sym = String(sym || '').trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
  if (!sym) return;
  $('#scrInput').value = sym;
  $('#scrSuggest').classList.remove('open');
  $('#stockCard').innerHTML = `<div class="empty"><b>Analyzing ${esc(sym)}…</b>Pulling a year of prices and fundamentals.</div>`;
  const held = S.base.holdings.find((h) => h.ticker === sym);
  const spx = (S.base.spxConstituents || []).find((x) => x.ticker === sym);
  let m = S.market[sym], prof = null, err = null;
  if (S.api) {
    const [mr, pr] = await Promise.allSettled([
      m ? Promise.resolve(null) : getJSON(`/api/market?symbols=${encodeURIComponent(sym + (S.market.SPY ? '' : ',SPY'))}&range=1y`, {}, 20000),
      getJSON(`/api/profile?symbol=${encodeURIComponent(sym)}`, {}, 4500),
    ]);
    if (mr.status === 'fulfilled' && mr.value) mr.value.data.forEach((d) => { if (d && !d.error && d.closes?.length) S.market[d.symbol.toUpperCase()] = d; else if (d?.symbol?.toUpperCase() === sym) err = d.error; });
    if (mr.status === 'rejected') err = mr.reason?.message;
    if (pr.status === 'fulfilled') prof = pr.value;
    else retryProfile(sym); // keep trying quietly; the card fills in when it arrives
    m = S.market[sym];
    prof = withMarketCap(prof, m?.price ?? held?.price);
    if (m && S.market.SPY) S.stats[sym] = symbolStats(m, S.market.SPY, rf());
  }
  const st = S.stats[sym];
  const price = m?.price ?? held?.price ?? null;
  S.stock = {
    symbol: sym,
    name: prof?.name || m?.name || held?.name || spx?.name || sym,
    sector: null, industry: '',
    assetClass: held?.assetClass || assetClassOf(sym, prof?.name || m?.name || spx?.name || ''),
    price, live: !!m, m, prof, st, held, spx,
  };
  if (!m && !held && !price) {
    S.stock.manual = true;
  }
  if (S.stock.assetClass === 'Equity') {
    S.stock.gics = gicsFor(held, prof, held?.sector || (prof?.sector ? toGics(prof.sector) : spx?.sector), spx?.sector, sym);
    S.stock.sector = S.stock.gics.sector || 'Other';
    S.stock.industry = S.stock.gics.industry || prof?.industry || '';
  } else { // bond ETFs and money-market funds have no GICS sector
    S.stock.gics = null; S.stock.sector = S.stock.assetClass; S.stock.industry = '';
  }
  renderStockCard(err);
  syncTradePanel();
}

function metric(k, v, s, t) {
  return `<div class="metric"><div class="k">${k}${t ? tip(t) : ''}</div><div class="v num">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
}
function valuationHTML(s) {
  const p = s.prof || {};
  const upside = p.targetMeanPrice && s.price ? p.targetMeanPrice / s.price - 1 : null;
  return `<details class="fold mt" data-fold="val" id="valFold"><summary><span>Valuation &amp; fundamentals</span><small>${[p.trailingPE != null ? `P/E ${fmt.x(p.trailingPE, 1)}` : '', p.dividendYield != null ? `Yield ${fmt.pct(p.dividendYield, 2)}` : '', upside != null ? `Target ${fmt.spct(upside)}` : ''].filter(Boolean).join(' · ') || 'Tap to view'}</small></summary>
  <div class="metrics">
    ${metric('Market cap', fmt.big(p.marketCap), p.capNote ? esc(p.capNote) : '', 'Total value of all shares outstanding, at the latest price. If Yahoo is slow, it is rebuilt from shares outstanding × the last price.')}
    ${metric('P/E (trailing)', fmt.x(p.trailingPE, 1), '', 'Price ÷ last 12 months of earnings per share. How many dollars you pay for $1 of profit.')}
    ${metric('P/E (forward)', fmt.x(p.forwardPE, 1), '', 'Price ÷ next year\'s expected earnings.')}
    ${metric('PEG', fmt.x(p.pegRatio), '', 'P/E divided by expected growth. Around 1 = fairly priced for its growth.')}
    ${metric('EV / EBITDA', fmt.x(p.evToEbitda, 1), '', 'Enterprise value ÷ operating cash earnings. Compares companies regardless of debt.')}
    ${metric('Price / book', fmt.x(p.priceToBook), '', 'Price ÷ book value per share.')}
    ${metric('Dividend yield', fmt.pct(p.dividendYield, 2), p.payoutRatio != null ? `Payout ${fmt.pct(p.payoutRatio, 0)}` : '', 'Annual dividends ÷ price.')}
    ${metric('ROE', fmt.pct(p.roe), '', 'Return on equity: profit ÷ shareholders\' equity.')}
    ${metric('Profit margin', fmt.pct(p.profitMargin), p.operatingMargin != null ? `Operating ${fmt.pct(p.operatingMargin)}` : '', 'Net income ÷ revenue.')}
    ${metric('Revenue growth', `<span class="${cls(p.revenueGrowth)}">${fmt.spct(p.revenueGrowth)}</span>`, 'Year over year', 'Most recent quarter vs the same quarter a year ago.')}
    ${metric('Debt / equity', p.debtToEquity != null ? fmt.x(p.debtToEquity / 100) + 'x' : '—', '', 'Total debt ÷ shareholders\' equity.')}
    ${metric('Analyst target', fmt.usdC(p.targetMeanPrice), upside != null ? `<span class="${cls(upside)}">${fmt.spct(upside)} upside</span> · ${p.analystCount || 0} analysts` : '', 'Average 12-month price target from Wall Street analysts.')}
  </div>
</details>`
}
function renderStockCard(err) {
  const s = S.stock, m = s.m, p = s.prof || {}, st = s.st;
  const day = m ? (m.dayPrevClose ? m.price / m.dayPrevClose - 1 : null) : s.held?.prevClose ? s.held.price / s.held.prevClose - 1 : null;
  const hr = s.held ? calc.rows.find((r) => r.ticker === s.symbol) : null;
  const secW = calc.sectors[s.sector]?.wEq || 0, secB = S.base.benchmark.sectorWeights[s.sector];
  const upside = p.targetMeanPrice && s.price ? p.targetMeanPrice / s.price - 1 : null;
  const pos52 = st && st.high52 > st.low52 ? (s.price - st.low52) / (st.high52 - st.low52) : null;
  let h = `<div class="stock-head">
    <div><div class="row"><h2 style="font-size:24px">${esc(s.symbol)}</h2>${s.held ? `<span class="tag gold">In portfolio</span>` : S.hist?.tickers?.[s.symbol] ? `<span class="tag prev-tag">Previously owned</span>` : ''}${s.spx ? `<span class="tag">S&amp;P 500 · ${fmt.pct(s.spx.weight, 2)}</span>` : ''}</div>
      <div style="color:var(--ink-2);margin-top:4px">${esc(s.name)}</div>
      ${s.assetClass === 'Equity' ? gicsLine(s) : `<div class="gics-line">${acTag(s.assetClass)}<span style="color:var(--muted)">${s.assetClass === 'Fixed Income' ? '· bond fund · compared with the Bloomberg US Aggregate (AGG), not the S&amp;P 500' : '· cash-like · earns roughly the T-bill yield'}${s.m?.exchange ? ' · ' + esc(s.m.exchange) : ''}</span></div>`}</div>
    <div class="px-wrap"><div class="px num">${s.price != null ? fmt.usdC(s.price) : '—'}</div>${day != null ? `<span class="chg ${day >= 0 ? 'up' : 'down'}">${fmt.spct(day, 2)} today</span>` : ''}
      <div style="color:var(--muted);font-size:11px;margin-top:6px">${s.live ? 'Live (delayed) · Yahoo Finance' : s.held ? 'Snapshot price from workbook' : 'No live data'}</div></div></div>`;
  if (err && !s.live) h += `<div class="warn-box">⚠ Couldn't load market data for ${esc(s.symbol)} (${esc(err)}). ${s.held ? 'Using the workbook price.' : 'Enter a price manually in the trade panel to simulate.'}</div>`;
  if (!S.api && !s.held) h += `<div class="warn-box">Live data is available once the site is deployed with its server functions. For now, type a price manually in the trade panel.</div>`;
  h += prevOwnedHTML(s);
  if (hr) h += `<div class="warn-box ok" style="margin-top:12px"><span>We own <b>${fmt.n(hr.quantity, 2)} shares</b> worth ${fmt.usd(hr.value)} (${fmt.pct(hr.weight, 2)} of the fund) · avg cost ${fmt.usdC(hr.avgCost)} · ${fmt.spct(hr.ret)} since ${hr.purchaseDate ? fdate(hr.purchaseDate) : '—'}</span></div>`;
  if (m || s.held) h += `<div class="stock-chart-bar mt">
      <div class="seg sm" id="stkMode" title="Show % change (like the Overview) or the share price">${[['%', '% change'], ['$', 'Price']].map(([v, l]) => `<button data-v="${v}"${v === S.stockMode ? ' class="on"' : ''}>${l}</button>`).join('')}</div>
      <div class="seg sm" id="stkRange">${['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', '10Y'].map((r) => `<button data-v="${r}"${r === S.stockRange ? ' class="on"' : ''}>${r}</button>`).join('')}</div>
      <div class="cmp-box"><div class="cmp-field"><input class="input" id="cmpInput" placeholder="Compare with… (MSFT, T-Mobile)" autocomplete="off" value="${esc(S.cmp || '')}" /><div class="suggest" id="cmpSuggest"></div></div>
        <button class="btn sm" id="cmpSpy" data-bench="${s.assetClass === 'Equity' ? 'SPY' : 'AGG'}" title="Compare with ${s.assetClass === 'Equity' ? 'the S&amp;P 500' : 'the Bloomberg US Aggregate bond index (AGG)'}">vs ${s.assetClass === 'Equity' ? 'S&amp;P' : 'AGG'}</button>${S.cmp ? '<button class="btn sm" id="cmpClear" title="Stop comparing">✕</button>' : ''}</div>
    </div><div class="row" id="stkStats" style="gap:18px;font-size:13px;color:var(--ink-2);margin:6px 0 0"></div>`;
  h += `<div id="chStock" class="chart short mt"></div>`;
  if (st) {
    h += `<div class="range52-wrap" style="margin:14px 0 4px"><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)"><span>52-wk low ${fmt.usdC(st.low52)}</span><span>52-week range (intraday) ${tip(GLOSS.r52)}</span><span>high ${fmt.usdC(st.high52)}</span></div><div class="range52"><i style="left:${(pos52 ?? 0) * 100}%"></i></div></div>`;
  }
  if (s.assetClass === 'Equity') h += `<div class="ips-box" id="ipsBox">${ipsHTML()}</div>`;
  else h += `<div class="ips-box"><div class="ips-head"><b>Investment Policy check</b><span class="ips-sum info">The IPS stock criteria apply to equities</span></div></div>`;
  h += `<h3 class="mt">Risk &amp; return (vs S&amp;P 500 · beta 5 years, others 1 year)</h3><div class="metrics">
    <div id="betaTile" style="display:contents">${betaTileHTML(s)}</div>
    ${metric('Volatility', fmt.pct(st?.vol), st ? `S&P: ${fmt.pct(S.stats.SPY?.vol)}` : '', GLOSS.vol)}
    ${metric('Sharpe ratio', st ? `<span class="${cls(st.sharpe)}">${fmt.x(st.sharpe)}</span>` : '—', st ? `S&P: ${fmt.x(S.stats.SPY?.sharpe)} · rf ${fmt.pct(rf(), 2)}` : '', GLOSS.sharpe)}
    ${metric('Sortino ratio', fmt.x(st?.sortino), '', GLOSS.sortino)}
    ${metric('Max drawdown', st ? `<span class="down">${fmt.pct(st.maxDD)}</span>` : '—', '', GLOSS.maxDD)}
    ${metric('Alpha', st ? `<span class="${cls(st.alpha)}">${fmt.spct(st.alpha)}</span>` : '—', st ? `1-yr, uses 1-yr daily beta ${fmt.x(st.beta)}` : '', GLOSS.alpha)}
    ${metric('Correlation', fmt.x(st?.corr), 'to S&P 500', GLOSS.corr)}
    ${metric('1Y return', st ? `<span class="${cls(st.periods['1Y'])}">${fmt.spct(st.periods['1Y'])}</span>` : '—', st ? `YTD ${fmt.spct(st.periods.YTD)} · 3M ${fmt.spct(st.periods['3M'])}` : '')}
  </div>
  <h3 class="mt">Portfolio fit</h3><div class="metrics">
    ${s.assetClass === 'Equity' ? metric('Our ' + esc(s.sector) + ' weight', fmt.pct(secW), secB != null ? `S&P 500: ${fmt.pct(secB)} (${fmt.pts(secW - secB)})` : '', 'Share of our stocks already in this sector, compared with the S&P 500.')
      : s.assetClass === 'Fixed Income' ? metric('Our fixed-income weight', fmt.pct(calc.fiValue / calc.total), `${fmt.usd(calc.fiValue)} · ${fmt.pct(calc.fiValue / (calc.eqValue + calc.fiValue))} of stocks + bonds`, 'Bond ETFs as a share of the whole fund. Bonds are judged against the Bloomberg US Aggregate (AGG) on the Performance tab, not against S&P sectors.')
        + metric('Bond funds we hold', esc(calc.rows.filter((r) => r.assetClass === 'Fixed Income').map((r) => r.ticker).join(', ') || 'none'), '', 'Current fixed-income positions.')
      : metric('Cash + money market', fmt.pct(calc.cashLike / calc.total), `${fmt.usd(calc.cashLike)} available to deploy`, 'Cash-like holdings. Trade Lab buys are paid from cash only.')}
    ${metric('Correlation to portfolio', S.pstats && st ? fmt.x(corrToPortfolio(s.symbol)) : '—', 'Lower = better diversifier', 'How closely this stock has moved with the SMIF portfolio over the past year.')}
  </div>
  ${valuationHTML(s)}`;
  if (S.hist) {
    const hh = S.hist.tickers[s.symbol], cur = hh?.periods.find((x) => !x.to);
    const peek = !hh ? 'Never owned' : cur ? `Owned since ${fdate(cur.from)} · ${hh.trades.length} transactions` : `Owned ${hh.periods.map((x) => `${x.from.slice(0, 4)}–${x.to.slice(0, 4)}`).join(', ')} · ${hh.trades.length} transactions`;
    h += `<details class="fold mt" data-fold="hist"><summary><span>Our history with ${esc(s.symbol)}</span><small>${esc(peek)}</small></summary>${historyHTML(s.symbol)}</details>`;
  }
  if (p.summary) h += `<details class="fold mt" data-fold="biz"><summary><span>Business summary</span><small>${esc(p.industry || '')}</small></summary><p style="color:var(--ink-2);font-size:13px;line-height:1.6;margin-top:0">${esc(p.summary)}…</p></details>`;
  $('#stockCard').innerHTML = h;
  bindStockChart();
  drawStockChart();
  if (s.assetClass === 'Equity') loadIpsBeta(s.symbol);
}
// ---------- IPS checklist (stock-level rules only) ----------
// Betas for the screener: 5-year weekly (shown on the Beta tile), 5-year monthly (cross-check, and the
// fallback if weekly isn't available), and the IPS's own 2-year weekly adjusted beta — all from one download each.
async function loadIpsBeta(sym) {
  const s = S.stock;
  if (s.ipsBeta !== undefined) return;
  if (!S.api) { s.ipsBeta = null; s.betas = {}; refreshIps(); refreshBeta(); return; }
  S.wk5 = S.wk5 || {}; S.mo5 = S.mo5 || {};
  await Promise.allSettled([
    fetchSeries([sym, 'SPY'].filter((t) => !S.wk5[t]), '5y', '1wk', S.wk5),
    fetchSeries([sym, 'SPY'].filter((t) => !S.mo5[t]), '5y', '1mo', S.mo5),
  ]);
  if (S.stock?.symbol !== sym) return;
  s.ipsBeta = weeklyAdjBeta(S.wk5[sym], S.wk5.SPY, 104);
  s.betas = { w5: regBeta(S.wk5[sym], S.wk5.SPY, 260, 52), m5: regBeta(S.mo5[sym], S.mo5.SPY, 60, 24) };
  refreshIps(); refreshBeta();
}
function betaTileHTML(s) {
  const B = s.betas, y = s.prof?.beta;
  if (!B) return metric('Beta', '<span style="color:var(--muted)">…</span>', 'Loading 5 years of weekly prices', GLOSS.beta + ' Shown here: 5-year weekly beta vs the S&P 500.');
  const ok = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.25;
  const check = [B.m5 ? `5-yr monthly ${fmt.x(B.m5.raw)}` : '', y != null ? `Yahoo ${fmt.x(y)}${B.m5 ? (ok(B.m5.raw, y) ? ' ✓' : ' ≠') : ''}` : ''].filter(Boolean).join(' · ');
  const T = 'Raw beta from weekly (or monthly) returns vs the S&P 500 (SPY), dividends included. Cross-check: our 5-year monthly beta should land close to Yahoo\'s published beta, which is also 5-year monthly — ✓ means within 0.25. The IPS check above uses a different, IPS-defined measure: 2-year weekly, Bloomberg-adjusted.';
  if (B.w5) return metric(`Beta · ${B.w5.n >= 250 ? '5-yr' : (B.w5.n / 52).toFixed(1) + '-yr'} weekly`, fmt.x(B.w5.raw), `${B.w5.n} weeks vs S&amp;P 500${check ? '<br>Check: ' + check : ''}`, T);
  if (B.m5) return metric(`Beta · ${B.m5.n >= 58 ? '5-yr' : (B.m5.n / 12).toFixed(1) + '-yr'} monthly`, fmt.x(B.m5.raw), `${B.m5.n} months vs S&amp;P 500 (weekly unavailable)${y != null ? `<br>Check: Yahoo ${fmt.x(y)}${ok(B.m5.raw, y) ? ' ✓' : ' ≠'}` : ''}`, T);
  if (y != null) return metric('Beta · 5-yr monthly', fmt.x(y), 'Yahoo Finance (our price history unavailable)', T);
  return metric('Beta', '—', 'Not enough price history', T);
}
function refreshBeta() { const el = $('#betaTile'); if (el && S.stock) el.innerHTML = betaTileHTML(S.stock); }
function refreshIps() { const el = $('#ipsBox'); if (el) el.innerHTML = ipsHTML(); }
function ipsHTML() {
  const s = S.stock;
  const row = calc.rows.find((r) => r.ticker === s.symbol);
  const firstBuy = s.held ? (S.hist?.tickers?.[s.symbol]?.periods?.slice(-1)[0]?.from || s.held.purchaseDate) : null;
  const checks = stockChecks({ spx: s.spx, prof: s.prof, capFailed: s.profFailed, m: s.m, held: !!row, firstBuy, beta: s.ipsBeta, weightNow: row?.weight, total: calc.total, price: s.price });
  const fails = checks.filter((c) => c.status === 'fail');
  const elig = checks.filter((c) => c.group === 'Eligibility');
  const passE = elig.filter((c) => c.status === 'pass').length, pend = elig.some((c) => c.status === 'pending');
  const outside = elig.some((c) => c.status === 'warn');
  const sum = fails.length ? `<span class="ips-sum bad">✗ ${fails.length} issue${fails.length > 1 ? 's' : ''}: ${esc(fails.map((f) => f.label).join(', '))}</span>`
    : pend ? `<span class="ips-sum info">${passE} of ${elig.length} eligibility checks pass so far</span>`
    : outside ? `<span class="ips-sum warn">! Eligible — outside the S&amp;P 500</span>` : `<span class="ips-sum ok">✓ Meets all ${elig.length} eligibility rules</span>`;
  const icon = { pass: '<i class="ips-i pass">✓</i>', fail: '<i class="ips-i fail">✗</i>', warn: '<i class="ips-i warn">!</i>', info: '<i class="ips-i info">•</i>', pending: '<i class="ips-i pend">…</i>' };
  const groups = [...new Set(checks.map((c) => c.group))];
  return `<div class="ips-head"><b>Investment Policy check</b>${tip('Only the IPS rules that apply to this one stock. Portfolio-wide rules (portfolio beta 0.9–1.1, sector weights within ±2% per trade, 75% US and 75% large-cap totals) are checked when you add a trade below.')}${sum}</div>
    <div class="ips-grid">${groups.map((g) => `<div class="ips-group"><div class="ips-g">${g}</div>${checks.filter((c) => c.group === g).map((c) => `<div class="ips-row ${c.status}">${icon[c.status]}<div><span class="ips-l">${esc(c.label)}${c.tip ? ' ' + tip(c.tip) : ''}</span><span class="ips-d">${esc(c.detail)}</span></div></div>`).join('')}</div>`).join('')}</div>`;
}
// ---------- stock card: GICS line, price history with time frames, and compare ----------
function gicsLine(s) {
  const g = s.gics || {};
  const t = g.source === 'fund' ? 'GICS sector and industry from the fund\'s workbook.'
    : g.source === 'spx' ? `GICS sector from the fund's S&P 500 constituent list.${g.industry ? '' : g.yahoo ? ` Industry shown is Yahoo's ("${g.yahoo}"), which doesn't line up with GICS for this stock.` : ''}`
    : g.source === 'mapped' ? `Mapped to GICS from Yahoo Finance's industry ("${g.yahoo}"). Yahoo uses its own categories, so double-check on Bloomberg before relying on it.`
    : g.source === 'unmapped' ? `Yahoo lists this as "${g.yahoo}", which doesn't map cleanly to a GICS industry.` : 'No industry data available.';
  const ex = s.m?.exchange ? ` · ${esc(s.m.exchange)}` : '';
  if (!g.sector && !g.industry) return `<div style="color:var(--muted);font-size:12px;margin-top:2px">${esc(s.sector)}${ex}</div>`;
  return `<div class="gics-line"><span class="gics-k">GICS</span><span>${esc(g.sector || s.sector)}</span>${g.industry ? `<span class="gics-sep">›</span><span>${esc(g.industry)}</span>` : g.yahoo ? `<span class="gics-sep">·</span><span style="color:var(--muted)">${esc(g.yahoo)}</span>` : ''}${tip(t)}<span style="color:var(--muted)">${ex}</span></div>`;
}
S.stockRange = store.get('stockRange', '1Y');
S.stockMode = store.get('stockMode', '%');
S.cmp = null;
S.wk = {};
const stkLong = (r) => r === '3Y' || r === '5Y' || r === '10Y';
async function seriesFor(sym, long) {
  if (!long) {
    if (S.market[sym]) return S.market[sym];
    if (!S.api) return null;
    await fetchSeries([sym], '1y', '1d', S.market);
    return S.market[sym] || null;
  }
  if (long === '10Y') {
    const need = rangeStart('10Y');
    if (S.long[sym] && S.long[sym].dates[0] <= need) return S.long[sym];
    S.wk10 = S.wk10 || {};
    if (S.wk10[sym]) return S.wk10[sym];
    if (!S.api) return S.long[sym] || S.wk[sym] || null;
    await fetchSeries([sym], '10y', '1wk', S.wk10);
    return S.wk10[sym] || S.long[sym] || S.wk[sym] || null;
  }
  if (S.long[sym]) return S.long[sym];
  if (S.wk[sym]) return S.wk[sym];
  if (!S.api) return null;
  await fetchSeries([sym], '5y', '1wk', S.wk);
  return S.wk[sym] || null;
}
function bindStockChart() {
  $$('#stkMode button').forEach((b) => b.addEventListener('click', () => {
    S.stockMode = b.dataset.v; store.set('stockMode', S.stockMode);
    $$('#stkMode button').forEach((x) => x.classList.toggle('on', x === b));
    drawStockChart();
  }));
  $$('#stkRange button').forEach((b) => b.addEventListener('click', () => {
    S.stockRange = b.dataset.v; store.set('stockRange', S.stockRange);
    $$('#stkRange button').forEach((x) => x.classList.toggle('on', x === b));
    drawStockChart();
  }));
  const setCmp = (v) => {
    v = String(v || '').trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
    S.cmp = v && v !== S.stock.symbol ? v : null;
    $('#cmpInput').value = S.cmp || '';
    let x = $('#cmpClear');
    if (S.cmp && !x) { $('#cmpSpy').insertAdjacentHTML('afterend', '<button class="btn sm" id="cmpClear" title="Stop comparing">✕</button>'); x = $('#cmpClear'); x.onclick = () => setCmp(''); }
    if (!S.cmp && x) x.remove();
    drawStockChart();
  };
  const inp = $('#cmpInput');
  if (!inp) return;
  attachSearch(inp, $('#cmpSuggest'), setCmp);
  $('#cmpSpy').onclick = () => setCmp($('#cmpSpy').dataset.bench || 'SPY');
  if ($('#cmpClear')) $('#cmpClear').onclick = () => setCmp('');
}
async function drawStockChart() {
  const s = S.stock;
  if (!$('#chStock')) return;
  const r = S.stockRange, long = stkLong(r), sym = s.symbol, cmp = S.cmp;
  if (charts.chStock && !charts.chStock.isDisposed()) charts.chStock.clear();
  const token = (S.stkTok = (S.stkTok || 0) + 1);
  if (!s.m) { emptyChart('chStock', s.held ? 'Price history appears once live data is connected.' : 'No price history available.'); return; }
  if (long || cmp) $('#stkStats').innerHTML = '<span>Loading prices…</span>';
  const lk = r === '10Y' ? '10Y' : long;
  const [m, c] = await Promise.all([seriesFor(sym, lk), cmp ? seriesFor(cmp, lk) : null]);
  if (token !== S.stkTok || S.stock.symbol !== sym) return;
  if (!m) { emptyChart('chStock', `Couldn't load ${long ? r.replace('Y', '-year') : ''} price history for ${sym}.`); $('#stkStats').innerHTML = ''; return; }
  const start = rangeStart(r);
  let i0 = m.dates.findIndex((d) => d >= start); if (i0 < 0) i0 = 0;
  const dates = m.dates.slice(i0);
  const px = (m.rawCloses || m.closes).slice(i0); // price as quoted (split-adjusted)
  const tr = m.closes.slice(i0); // adjusted for dividends → total return
  const short = r === '1M' || r === '3M';
  const xAxis = { type: 'category', data: dates, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => axisDate(v, long ? 'long' : short ? 'short' : 'mid') } };
  const trades = (S.hist?.tickers?.[sym]?.trades || []).filter((t) => (t.type === 'Buy' || t.type === 'Sell') && t.date >= dates[0]);
  const ret = (a) => a[a.length - 1] / a[0] - 1;
  if (cmp) {
    if (!c) { $('#stkStats').innerHTML = `<span class="down">Couldn't find price data for ${esc(cmp)}.</span>`; }
    // align the comparison to our dates (carry the last known close forward)
    let cv = null; const cm = c ? new Map(c.dates.map((d, i) => [d, c.closes[i]])) : new Map();
    const ci = c ? c.dates.findIndex((d) => d >= dates[0]) : -1;
    if (ci > 0) cv = c.closes[ci - 1];
    const cAl = dates.map((d) => { const v = cm.get(d); if (v != null) cv = v; return cv; });
    const f0 = cAl.findIndex((v) => v != null);
    const A = tr.map((v) => +((v / tr[0] - 1) * 100).toFixed(2));
    const B = f0 < 0 ? [] : cAl.map((v, i) => (i < f0 || v == null ? null : +((v / cAl[f0] - 1) * 100).toFixed(2)));
    const rA = ret(tr), rB = f0 >= 0 ? cAl[cAl.length - 1] / cAl[f0] - 1 : null;
    if (c) $('#stkStats').innerHTML = `<span><b style="color:${C.gold}">${esc(sym)}</b> <b class="${cls(rA)}">${fmt.spct(rA)}</b></span><span><b style="color:${C.grayLight}">${esc(cmp)}</b> <b class="${cls(rB)}">${fmt.spct(rB)}</b></span>${rB != null ? `<span>Difference <b class="${cls(rA - rB)}">${fmt.spct(rA - rB)}</b></span>` : ''}<span style="color:var(--muted)">Total return incl. dividends</span>`;
    setChart('chStock', {
      grid: { left: 44, right: 96, top: 22, bottom: 24 },
      legend: { top: 0, right: 0, textStyle: { color: C.ink2 }, icon: 'roundRect', itemWidth: 12, itemHeight: 3 },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.gold, opacity: 0.5 } },
        formatter: (p) => `<b>${fdate(p[0].axisValue)}</b><br>` + p.filter((x) => x.value != null).map((x) => `${x.marker} ${x.seriesName}: ${fmt.spct(x.value / 100)}`).join('<br>') },
      xAxis, yAxis: { type: 'value', scale: true, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => (v > 0 ? '+' : '') + v + '%' } },
      series: [
        { name: sym, type: 'line', data: A, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold }, endLabel: { show: true, color: C.ink, formatter: (p) => `${sym} ${fmt.spct(p.value / 100)}` }, labelLayout: { moveOverlap: 'shiftY' } },
        { name: cmp, type: 'line', data: B, showSymbol: false, connectNulls: true, lineStyle: { width: 2, color: C.grayLight }, itemStyle: { color: C.grayLight }, endLabel: { show: true, color: C.ink2, formatter: (p) => `${cmp} ${fmt.spct(p.value / 100)}` }, labelLayout: { moveOverlap: 'shiftY' } },
      ],
    });
    return;
  }
  const rP = ret(px), rT = ret(tr);
  const lo = Math.min(...px), hi = Math.max(...px);
  $('#stkStats').innerHTML = `<span>Price <b class="${cls(rP)}">${fmt.spct(rP)}</b></span>${Math.abs(rT - rP) > 0.0005 ? `<span>With dividends <b class="${cls(rT)}">${fmt.spct(rT)}</b></span>` : ''}<span title="Lowest and highest closing price in the period shown. The 52-week bar below uses intraday highs and lows, so it can be a little wider.">Closing range ${fmt.usdC(lo)} – ${fmt.usdC(hi)}</span>${long ? '<span style="color:var(--muted)">Weekly prices</span>' : ''}`;
  const avg = s.held?.avgCost;
  if (S.stockMode === '%') return drawStockPct({ sym, dates, px, tr, trades, xAxis });
  setChart('chStock', {
    grid: { left: 50, right: 16, top: 12, bottom: 24 },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.gold, opacity: 0.5 } },
      formatter: (p) => {
        const d = p[0].axisValue, i = dates.indexOf(d), nd = dates[i + 1] || '9999';
        const here = trades.filter((t) => t.date >= d && t.date < nd && dates.findIndex((x) => x >= t.date) === i);
        return `<b>${fdate(d)}</b><br>${p[0].marker} ${fmt.usdC(p[0].value)} <span style="color:${C.muted}">(${fmt.spct(p[0].value / px[0] - 1)} in period)</span>` + here.map((t) => `<br><span style="color:${t.type === 'Buy' ? '#3ccf7f' : '#f0625a'}">We ${t.type === 'Buy' ? 'bought' : 'sold'} ${fmt.n(t.shares, 2)} sh @ ${fmt.usdC(t.price)}</span>`).join('');
      } },
    xAxis, yAxis: { type: 'value', scale: true, ...axisCommon },
    series: [{ name: sym, type: 'line', data: px, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,198,41,0.22)' }, { offset: 1, color: 'rgba(255,198,41,0)' }]) },
      markLine: avg && avg >= lo * 0.6 && avg <= hi * 1.4 ? { silent: true, symbol: 'none', lineStyle: { color: C.grayLight, type: 'dashed' }, label: { color: C.ink2, formatter: `Our avg cost ${fmt.usdC(avg)}`, position: 'insideStartTop' }, data: [{ yAxis: avg }] } : undefined,
      markPoint: trades.length ? { symbolSize: 26, label: { color: '#111', fontWeight: 800, fontSize: 10 }, data: trades.map((t) => {
        const i = dates.findIndex((d) => d >= t.date); if (i < 0) return null;
        return { coord: [dates[i], px[i]], value: t.type === 'Buy' ? 'B' : 'S', symbol: 'pin', symbolRotate: t.type === 'Buy' ? 180 : 0, symbolOffset: [0, t.type === 'Buy' ? 14 : -14], itemStyle: { color: t.type === 'Buy' ? C.up : C.down }, label: { offset: [0, t.type === 'Buy' ? 3 : 0] } };
      }).filter(Boolean) } : undefined }],
  });
}
// % appreciation from the start of the period (total return incl. dividends), like the Overview chart
function drawStockPct({ sym, dates, px, tr, trades, xAxis }) {
  const P = tr.map((v) => +((v / tr[0] - 1) * 100).toFixed(2));
  setChart('chStock', {
    grid: { left: 50, right: 70, top: 12, bottom: 24 },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.gold, opacity: 0.5 } },
      formatter: (p) => {
        const d = p[0].axisValue, i = dates.indexOf(d), nd = dates[i + 1] || '9999';
        const here = trades.filter((t) => t.date >= d && t.date < nd && dates.findIndex((x) => x >= t.date) === i);
        return `<b>${fdate(d)}</b><br>${p[0].marker} <b>${fmt.spct(p[0].value / 100)}</b> since ${fdate(dates[0])}<br><span style="color:${C.muted}">Price ${fmt.usdC(px[i])}</span>` + here.map((t) => `<br><span style="color:${t.type === 'Buy' ? '#3ccf7f' : '#f0625a'}">We ${t.type === 'Buy' ? 'bought' : 'sold'} ${fmt.n(t.shares, 2)} sh @ ${fmt.usdC(t.price)}</span>`).join('');
      } },
    xAxis, yAxis: { type: 'value', scale: true, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => (v > 0 ? '+' : '') + v + '%' } },
    series: [{ name: sym, type: 'line', data: P, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold },
      endLabel: { show: true, color: C.ink, fontWeight: 700, formatter: (p) => fmt.spct(p.value / 100) },
      areaStyle: { origin: 0, color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,198,41,0.20)' }, { offset: 1, color: 'rgba(255,198,41,0)' }]) },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: C.muted, opacity: 0.5 }, label: { show: false }, data: [{ yAxis: 0 }] },
      markPoint: trades.length ? { symbolSize: 26, label: { color: '#111', fontWeight: 800, fontSize: 10 }, data: trades.map((t) => {
        const i = dates.findIndex((d) => d >= t.date); if (i < 0) return null;
        return { coord: [dates[i], P[i]], value: t.type === 'Buy' ? 'B' : 'S', symbol: 'pin', symbolRotate: t.type === 'Buy' ? 180 : 0, symbolOffset: [0, t.type === 'Buy' ? 14 : -14], itemStyle: { color: t.type === 'Buy' ? C.up : C.down }, label: { offset: [0, t.type === 'Buy' ? 3 : 0] } };
      }).filter(Boolean) } : undefined }],
  });
}
function corrToPortfolio(sym) {
  const ps = S.pstats?.series, m = S.market[sym];
  if (!ps || !m) return null;
  const map = new Map(); for (let i = 1; i < m.closes.length; i++) map.set(m.dates[i], m.closes[i] / m.closes[i - 1] - 1);
  const a = [], b = [];
  ps.dates.forEach((d, i) => { if (map.has(d)) { a.push(map.get(d)); b.push(ps.rets[i]); } });
  if (a.length < 20) return null;
  const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(sa * sb);
}

function tradePrice() {
  const s = S.stock;
  if (!s) return null;
  if (s.price != null && !s.manual) return s.price;
  const v = parseFloat($('#manualPx').value);
  return v > 0 ? v : null;
}
function computeTrade() {
  const s = S.stock;
  if (!s) return null;
  const px = tradePrice();
  if (!px) return { error: 'Enter a price' };
  const raw = parseFloat($('#amtInput').value);
  if (!(raw > 0) && !(S.trade.mode === 'weight' && raw === 0)) return { px, shares: 0 };
  // work on the portfolio *after* trades already on the ticket
  const after = applyTrades(S.base, S.trades).port;
  const ac = computePortfolio(after, simMarket());
  const cur = ac.rows.find((r) => r.ticker === s.symbol);
  const curVal = cur ? cur.value : 0;
  let side = S.trade.side, shares;
  const funding = 'cash'; // buys are paid from cash only
  if (S.trade.mode === 'shares') shares = Math.floor(raw);
  else if (S.trade.mode === 'dollars') shares = Math.floor(raw / px);
  else {
    const w = raw / 100;
    if (w >= 1) return { px, error: 'Target weight must be under 100%' };
    let x = side === 'buy' && funding === 'new' ? (w * ac.total - curVal) / (1 - w) : w * ac.total - curVal;
    side = x >= 0 ? 'buy' : 'sell';
    shares = Math.floor(Math.abs(x) / px);
  }
  if (side === 'sell' && cur) shares = Math.min(shares, Math.floor(cur.quantity * 1e6) / 1e6);
  return { px, shares, side, amount: shares * px, funding, curVal, cur, ac };
}
function simMarket() {
  if (!S.live) {
    const m = {};
    S.trades.forEach((t) => { m[t.ticker] = { price: t.price, dayPrevClose: t.price }; });
    if (S.stock && tradePrice() && !S.base.holdings.find((h) => h.ticker === S.stock.symbol)) m[S.stock.symbol] = { price: tradePrice(), dayPrevClose: tradePrice() };
    return m;
  }
  return S.market;
}

function syncTradePanel() {
  const s = S.stock;
  $('#tradeTicker').textContent = s ? s.symbol : '—';
  $('#manualPxWrap').style.display = s && (s.manual || s.price == null) ? '' : 'none';
  if (s && s.manual && !$('#manualSector').options.length) $('#manualSector').innerHTML = SECTORS.map((x) => `<option ${x === s.sector ? 'selected' : ''}>${x}</option>`).join('');
  if (s && s.manual && SECTORS.includes(s.sector)) $('#manualSector').value = s.sector;
  if (s && s.manual && !s.held) s.manual = true;
  $$('#sideToggle button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.trade.side));
  $$('#amtMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.trade.mode));
  $('#amtLabel').textContent = { shares: 'Number of shares', dollars: 'Dollar amount ($)', weight: 'Target weight of total fund (%)' }[S.trade.mode];
  $('#amtInput').step = S.trade.mode === 'shares' ? '1' : S.trade.mode === 'dollars' ? '100' : '0.25';
  const t = computeTrade();
  const calcEl = $('#tradeCalc');
  const btn = $('#addTrade');
  btn.textContent = 'Add to ticket';
  if (!s) { calcEl.innerHTML = '<div><span>Search a stock first</span></div>'; btn.disabled = true; return; }
  if (!t || t.error) { calcEl.innerHTML = `<div><span>${t?.error || ''}</span></div>`; btn.disabled = true; return; }
  if (!t.shares) { calcEl.innerHTML = `<div><span>Price</span><b>${fmt.usdC(t.px)}</b></div><div><span>Enter an amount above</span></div>`; btn.disabled = true; return; }
  const after = applyTrades(S.base, [...S.trades, mkTrade(t)]);
  const ac = computePortfolio(after.port, simMarket());
  const nr = ac.rows.find((r) => r.ticker === s.symbol);
  calcEl.innerHTML = `
    <div><span>Action</span><b class="${t.side === 'buy' ? 'up' : 'down'}">${t.side.toUpperCase()} ${fmt.n(t.shares)} sh</b></div>
    <div><span>Price</span><b>${fmt.usdC(t.px)}</b></div>
    <div><span>Est. ${t.side === 'buy' ? 'cost' : 'proceeds'}</span><b>${fmt.usd(t.amount)}</b></div>
    <div><span>Share of fund</span><b>${fmt.pct(t.amount / t.ac.total, 2)}</b></div>
    <div><span>${s.symbol} weight</span><b>${fmt.pct(t.ac.rows.find((r) => r.ticker === s.symbol)?.weight || 0, 2)} → ${fmt.pct(nr?.weight || 0, 2)}</b></div>
    ${gicsCalcRows(s, t.ac, ac)}
    <div><span>Cash</span><b class="${ac.cash < 0 ? 'down' : ''}">${fmt.usd(t.ac.cash)} → ${fmt.usd(ac.cash)}</b></div>`;
  btn.disabled = false;
  btn.textContent = `Add ${t.side === 'buy' ? 'buy' : 'sell'} of ${fmt.n(t.shares)} ${s.symbol} to ticket`;
}
// GICS sector effect of the trade being typed (on top of anything already on the ticket)
function gicsCalcRows(s, b, a) {
  if (s.assetClass !== 'Equity') {
    const k = s.assetClass === 'Fixed Income' ? 'fiValue' : null;
    return k ? `<div class="calc-sec"><span>Fixed income share of fund</span><b>${fmt.pct(b[k] / b.total, 1)} → ${fmt.pct(a[k] / a.total, 1)}</b></div>` : '';
  }
  const sec = s.sector, bw = S.base.benchmark.sectorWeights[sec];
  const w0 = b.sectors[sec]?.wEq || 0, w1 = a.sectors[sec]?.wEq || 0;
  let h = `<div class="calc-sec"><span>GICS sector</span><b>${esc(sec)}</b></div>
    <div><span>${esc(shortName(sec))} weight ${tip('Share of our stocks (equities only) in this GICS sector — the same basis the IPS sector rules use.')}</span><b>${fmt.pct(w0, 1)} → ${fmt.pct(w1, 1)}</b></div>`;
  if (bw != null) {
    const d0 = w0 - bw, d1 = w1 - bw;
    // the rule covers every sector: buying one stock also dilutes all the others
    const pushed = Object.keys(S.base.benchmark.sectorWeights).filter((x) => {
      const b0 = (b.sectors[x]?.wEq || 0) - S.base.benchmark.sectorWeights[x], b1 = (a.sectors[x]?.wEq || 0) - S.base.benchmark.sectorWeights[x];
      return Math.abs(b1) > IPS.sectorTrade + 1e-9 && Math.abs(b1) > Math.abs(b0) + 1e-9;
    });
    const st = !pushed.length ? ['up', '✓ within IPS'] : ['warn-t', `! ${pushed.map((x) => esc(shortName(x))).join(', ')} past ±2`];
    h += `<div><span>vs S&amp;P 500 (${fmt.pct(bw, 1)})</span><b>${fmt.pts(d0)} → ${fmt.pts(d1)}</b></div>
      <div><span>Sector rule (±2 pts per trade)</span><b class="${st[0]}">${st[1]}</b></div>`;
  }
  return h;
}

// pop-up: everything the ticket would change
function openImpactPopup() {
  if (!S.trades.length) return toast('Add a trade first');
  renderImpact();
  const before = computePortfolio(S.base, S.live ? S.market : {});
  const after = computePortfolio(applyTrades(S.base, S.trades).port, simMarket());
  const bw = S.base.benchmark.sectorWeights;
  const buys = S.trades.filter((t) => t.side === 'buy').reduce((x, t) => x + t.shares * t.price, 0);
  const sells = S.trades.filter((t) => t.side === 'sell').reduce((x, t) => x + t.shares * t.price, 0);
  const touched = new Set(S.trades.map((t) => t.sector));
  const secs = SECTORS.filter((x) => before.sectors[x] || after.sectors[x] || bw[x] != null);
  const rowsH = secs.map((x) => {
    const w0 = before.sectors[x]?.wEq || 0, w1 = after.sectors[x]?.wEq || 0, b = bw[x] ?? 0, d0 = w0 - b, d1 = w1 - b;
    const moved = Math.abs(w1 - w0) > 5e-5;
    const worse = moved && Math.abs(d1) > Math.abs(d0) + 1e-9;
    const flag = Math.abs(d1) > IPS.sectorRebalance ? `<span class="down">${worse ? 'Pushed outside ±3 ⚠' : 'Outside ±3 (rebalance)'}</span>`
      : Math.abs(d1) > IPS.sectorTrade ? (worse ? '<span class="warn-t">Pushed past ±2 ⚠</span>' : '<span style="color:var(--muted)">Already past ±2</span>') : '<span class="up">OK</span>';
    return `<tr class="${moved || touched.has(x) ? 'imp-hit' : 'imp-dim'}"><td>${esc(x)}</td><td class="n">${fmt.pct(w0, 1)}</td><td class="n">${moved ? `<b>${fmt.pct(w1, 1)}</b>` : fmt.pct(w1, 1)}</td><td class="n">${fmt.pct(b, 1)}</td><td class="n">${fmt.pts(d0)} → ${fmt.pts(d1)}</td><td class="n">${flag}</td></tr>`;
  }).join('');
  const b = modal(`<h2>Trade impact</h2>
    <p style="margin-top:-4px">${S.trades.length} trade${S.trades.length > 1 ? 's' : ''} on the ticket: ${S.trades.map((t) => `<b class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '+' : '−'}${fmt.n(t.shares)} ${esc(t.ticker)}</b>`).join(', ')}</p>
    <div class="tr-sum">
      <div><small>Cost of buys</small><b>${fmt.usd(buys)}</b><div class="sub">${fmt.pct(buys / before.total, 2)} of the fund</div></div>
      <div><small>Sale proceeds</small><b>${fmt.usd(sells)}</b><div class="sub">${fmt.pct(sells / before.total, 2)} of the fund</div></div>
      <div><small>Cash</small><b class="${after.cash < 0 ? 'down' : ''}">${fmt.usd(before.cash)} → ${fmt.usd(after.cash)}</b><div class="sub">${after.cash < 0 ? 'Not enough cash — buys are paid from cash only' : `${fmt.pct(after.cash / after.total, 1)} of the fund after`}</div></div>
    </div>
    <h3 class="mt">GICS sector weights <span style="font-weight:400;color:var(--muted);font-size:12px">· share of our stocks</span></h3>
    <div class="table-wrap"><table class="imp-table"><thead><tr><th>Sector</th><th class="n">Now</th><th class="n">After</th><th class="n">S&amp;P 500</th><th class="n">vs S&amp;P (pts)</th><th class="n">IPS ${tip('IPS: no trade may push a sector more than ±2 pts from the S&P 500; rebalance beyond ±3 pts. A buy dilutes every other sector, so sectors you didn\'t trade can move too.')}</th></tr></thead><tbody>${rowsH}</tbody></table></div>
    <h3 class="mt">Everything else that changes</h3>
    <div class="imp-pop">${$('#impact').innerHTML}</div>
    <div class="row mt" style="justify-content:flex-end"><button class="btn" id="impClose">Close</button></div>`);
  b.classList.add('wide');
  $('#impClose', b).onclick = closeModal;
}

function mkTrade(t) {
  const s = S.stock;
  if (s.manual) s.sector = $('#manualSector').value || s.sector;
  return { ticker: s.symbol, name: s.name, sector: s.sector, industry: s.industry, assetClass: s.assetClass, side: t.side, shares: t.shares, price: t.px, funding: t.funding, at: new Date().toISOString() };
}

function renderTicket() {
  const el = $('#ticket');
  if (!S.trades.length) el.innerHTML = '<div class="empty" style="padding:16px">No trades yet.</div>';
  else el.innerHTML = S.trades.map((t, i) => `<div class="ticket-item"><span class="side-badge ${t.side}">${t.side.toUpperCase()}</span>
    <div><b>${t.ticker}</b> · ${fmt.n(t.shares)} sh @ ${fmt.usdC(t.price)}<div style="color:var(--muted);font-size:11px">${t.side === 'buy' ? 'Paid from cash' : 'Proceeds to cash'}</div></div>
    <b class="num">${fmt.usd(t.shares * t.price)}</b><button class="btn sm" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
  $$('[data-rm]', el).forEach((b) => b.addEventListener('click', () => { S.trades.splice(+b.dataset.rm, 1); store.set('ticket', S.trades); renderTicket(); renderImpact(); syncTradePanel(); }));
  renderImpact();
}

function renderImpact() {
  const el = $('#impact');
  const mkt = simMarket();
  const before = computePortfolio(S.base, S.live ? S.market : {});
  const sim = applyTrades(S.base, S.trades);
  const after = computePortfolio(sim.port, mkt);
  const bw = S.base.benchmark.sectorWeights;
  // sector chart
  const secs = SECTORS.filter((s) => before.sectors[s] || after.sectors[s] || bw[s]);
  setChart('chSim', {
    grid: { left: 150, right: 30, top: 28, bottom: 20 },
    legend: { top: 0, right: 0, textStyle: { color: C.ink2 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => fmt.pct(v) },
    xAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    yAxis: { type: 'category', data: [...secs].reverse(), ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2 } },
    series: [
      { name: 'Now', type: 'bar', data: [...secs].reverse().map((s) => before.sectors[s]?.wEq || 0), itemStyle: { color: C.blue, borderRadius: [0, 3, 3, 0] }, barWidth: '24%' },
      { name: 'After trades', type: 'bar', data: [...secs].reverse().map((s) => after.sectors[s]?.wEq || 0), itemStyle: { color: C.gold, borderRadius: [0, 3, 3, 0] }, barWidth: '24%' },
      { name: 'S&P 500', type: 'bar', data: [...secs].reverse().map((s) => bw[s] || 0), itemStyle: { color: C.gray, borderRadius: [0, 3, 3, 0] }, barWidth: '24%' },
    ],
  });
  if (!S.trades.length) { el.innerHTML = '<div class="empty">Add a mock trade to see the before/after.</div>'; return; }
  let pb = null, pa = null;
  if (S.live) { pb = S.pstats; pa = portfolioStats(after, S.market, rf()); }
  const betas = Object.fromEntries(Object.entries(S.stats).map(([k, v]) => [k, v?.beta]));
  const row = (k, b, a, t, better) => {
    const changed = b !== a;
    return `<div class="impact-row"><div class="k">${k}${t ? tip(t) : ''}</div><div class="b num">${b}</div><div class="ar">${changed ? '→' : ''}</div><div class="a num">${a}</div></div>`;
  };
  let h = `<div class="impact-row" style="font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em"><div>Metric</div><div style="text-align:right">Now</div><div></div><div style="text-align:right">After</div></div>`;
  h += row('Total fund value', fmt.usd(before.total), fmt.usd(after.total));
  h += row('Number of positions', before.rows.length, after.rows.length);
  h += row('Cash', `${fmt.usd(before.cash)} (${fmt.pct(before.cash / before.total)})`, `${fmt.usd(after.cash)} (${fmt.pct(after.cash / after.total)})`, 'Buys are paid from cash only; sells add their proceeds to cash. The money market fund (SNOXX) is left as is.');
  h += row('Equity weight', fmt.pct(before.eqValue / before.total), fmt.pct(after.eqValue / after.total), 'Stocks as a share of the whole fund.');
  h += row('Fixed income weight', fmt.pct(before.fiValue / before.total), fmt.pct(after.fiValue / after.total), 'Bond ETFs as a share of the whole fund.');
  const tickers = [...new Set(S.trades.map((t) => t.ticker))];
  tickers.forEach((tk) => {
    const b = before.rows.find((r) => r.ticker === tk), a = after.rows.find((r) => r.ticker === tk);
    h += row(`<b>${tk}</b>&nbsp;weight`, fmt.pct(b?.weight || 0, 2), fmt.pct(a?.weight || 0, 2));
  });
  const secsT = [...new Set(S.trades.map((t) => t.sector).filter((s) => s && bw[s] != null))];
  secsT.forEach((s) => h += row(`${s} (S&amp;P ${fmt.pct(bw[s])})`, fmt.pct(before.sectors[s]?.wEq || 0), fmt.pct(after.sectors[s]?.wEq || 0), 'Share of our stocks in this sector.'));
  if (S.live) {
    h += row('Portfolio beta', fmt.x(weightedBeta(before, betas)), fmt.x(weightedBeta(after, betas)), GLOSS.beta);
    if (pb && pa) {
      h += row('Volatility', fmt.pct(pb.vol), fmt.pct(pa.vol), GLOSS.vol);
      h += row('Sharpe ratio', fmt.x(pb.sharpe), fmt.x(pa.sharpe), GLOSS.sharpe);
      h += row('1Y return (backtest)', fmt.spct(pb.totalRet), fmt.spct(pa.totalRet), 'What each version of the portfolio would have returned over the last year at these weights.');
      h += row('Max drawdown', fmt.pct(pb.maxDD), fmt.pct(pa.maxDD), GLOSS.maxDD);
    }
  } else h += `<div class="warn-box" style="margin-top:10px">Beta, volatility and Sharpe before/after appear once live data is connected.</div>`;
  // guideline checks
  const warns = [...sim.notes];
  // IPS checks on the trade: size limits per stock, S&P inclusion, sector moves of more than ±2 pts, portfolio beta 0.9–1.1
  const spxW = Object.fromEntries((S.base.spxConstituents || []).map((x) => [x.ticker, x.weight]));
  const beforeW = Object.fromEntries(before.rows.map((r) => [r.ticker, r.weight]));
  tickers.forEach((t) => {
    const r = after.rows.find((x) => x.ticker === t);
    if (!r || r.assetClass !== 'Equity') return;
    const L = sizeLimits(spxW[t]);
    const isNew = !beforeW[t];
    if (spxW[t] == null && (isNew || (r.weight > (beforeW[t] || 0)))) warns.push({ level: 'warn', text: `${t} is not an S&P 500 constituent. Under the IPS it may still be purchased at the committee's discretion if it meets the beta (≤ 2), market-cap (> $2B) and developed-exchange criteria — see its Investment Policy check.` });
    if (isNew && r.weight < L.minInit - 1e-9) warns.push({ level: 'warn', text: `${t} would start at ${fmt.pct(r.weight, 2)} of the fund. IPS minimum first purchase is 1% (≈ ${fmt.usd(L.minInit * after.total)}).` });
    if (isNew && r.weight > L.maxInit + 1e-9) warns.push({ level: 'warn', text: `${t} would start at ${fmt.pct(r.weight, 2)}. IPS maximum first purchase for this stock is ${fmt.pct(L.maxInit, 1)} (≈ ${fmt.usd(L.maxInit * after.total)}).` });
    if (L.maxHold != null && r.weight > L.maxHold + 1e-9) warns.push({ level: 'warn', text: `${t} would be ${fmt.pct(r.weight, 2)} of the fund. IPS: a stock under 2% of the S&P 500 can't be more than 5%.` });
    if (L.track && (r.weight < L.track.lo || r.weight > L.track.hi)) warns.push({ level: 'warn', text: `${t} would be ${fmt.pct(r.weight, 2)} vs its ${fmt.pct(L.benchW, 2)} index weight. IPS: keep stocks that are 4%+ of the index within ±2% (${fmt.pct(Math.max(0, L.track.lo), 1)}–${fmt.pct(L.track.hi, 1)}).` });
  });
  secsT.forEach((sec) => {
    const d0 = (before.sectors[sec]?.wEq || 0) - bw[sec], d1 = (after.sectors[sec]?.wEq || 0) - bw[sec];
    if (Math.abs(d1) > IPS.sectorTrade && Math.abs(d1) > Math.abs(d0) + 1e-9) warns.push({ level: 'warn', text: `${sec} would be ${fmt.pts(d1)} vs the S&P 500. IPS: no trade should push a sector more than ±2 pts from the benchmark.` });
  });
  if (S.live) {
    const pbA = weightedBeta(after, betas), pbB = weightedBeta(before, betas);
    if (pbA != null && (pbA < IPS.portBeta[0] || pbA > IPS.portBeta[1]) && Math.abs(pbA - 1) > Math.abs((pbB ?? 1) - 1)) warns.push({ level: 'warn', text: `Portfolio beta would be ${fmt.x(pbA)}. IPS: keep it between 0.9 and 1.1.` });
  }
  h += warns.length ? warns.map((w) => `<div class="warn-box ${w.level === 'bad' ? 'bad' : ''}">⚠ ${esc(w.text)}</div>`).join('') : `<div class="warn-box ok">✓ Meets the IPS position-size, sector (±2 pts per trade) and portfolio beta (0.9–1.1) rules.</div>`;
  el.innerHTML = h;
}

// scenarios
function saveScenario() {
  if (!S.trades.length) return toast('Add a trade first');
  const b = modal(`<h2>Save scenario</h2><p>Saved in this browser so you can come back to it. Use "Excel" to share it with the group.</p>
    <label class="field">Scenario name<input class="input" id="scName" value="${esc(S.trades.map((t) => `${t.side === 'buy' ? '+' : '−'}${t.ticker}`).join(' '))}" /></label>
    <div class="row"><button class="btn primary" id="scOk">Save</button><button class="btn" id="scCancel">Cancel</button></div>`);
  $('#scCancel', b).onclick = closeModal;
  $('#scOk', b).onclick = () => {
    const all = store.get('scenarios', {});
    all[$('#scName', b).value || 'Untitled'] = { trades: S.trades, savedAt: new Date().toISOString(), by: S.settings.name };
    store.set('scenarios', all);
    closeModal();
    toast('Scenario saved');
  };
}
function loadScenario() {
  const all = store.get('scenarios', {});
  const names = Object.keys(all);
  const b = modal(`<h2>Saved scenarios</h2>${names.length ? names.map((n) => `<div class="ticket-item" style="grid-template-columns:1fr auto auto"><div><b>${esc(n)}</b><div style="color:var(--muted);font-size:11px">${all[n].trades.length} trades · ${new Date(all[n].savedAt).toLocaleString()}</div></div><button class="btn sm" data-ld="${esc(n)}">Load</button><button class="btn sm danger" data-del="${esc(n)}">Delete</button></div>`).join('') : '<p>No saved scenarios yet.</p>'}
    <label class="btn" style="justify-content:center">Import from Excel / JSON<input type="file" id="scFile" accept=".xlsx,.json" hidden /></label><button class="btn" id="scClose">Close</button>`);
  $('#scClose', b).onclick = closeModal;
  $$('[data-ld]', b).forEach((x) => x.onclick = () => { S.trades = JSON.parse(JSON.stringify(all[x.dataset.ld].trades)); repriceTicket(); store.set('ticket', S.trades); renderTicket(); syncTradePanel(); closeModal(); toast('Scenario loaded'); });
  $$('[data-del]', b).forEach((x) => x.onclick = () => { delete all[x.dataset.del]; store.set('scenarios', all); closeModal(); loadScenario(); });
  $('#scFile', b).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      let trades;
      if (f.name.endsWith('.json')) trades = JSON.parse(await f.text()).trades;
      else {
        const wb = XLSX.read(await f.arrayBuffer());
        const ws = wb.Sheets['Trades'];
        if (!ws) throw new Error('No "Trades" sheet');
        trades = XLSX.utils.sheet_to_json(ws).map((r) => ({ ticker: String(r.Ticker).toUpperCase(), side: String(r.Side).toLowerCase(), shares: +r.Shares, price: +r.Price, name: r.Name, sector: r.Sector, assetClass: 'Equity', funding: 'cash' }));
      }
      S.trades = trades.filter((t) => t.ticker && t.shares > 0 && t.price > 0);
      store.set('ticket', S.trades); renderTicket(); syncTradePanel(); closeModal(); toast(`Imported ${S.trades.length} trades`);
    } catch (err) { toast('Import failed: ' + err.message, 4000); }
  };
}
function exportScenario() {
  if (!S.trades.length) return toast('Add a trade first');
  const before = computePortfolio(S.base, S.live ? S.market : {});
  const after = computePortfolio(applyTrades(S.base, S.trades).port, simMarket());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.trades.map((t) => ({ Side: t.side.toUpperCase(), Ticker: t.ticker, Name: t.name, Sector: t.sector, Shares: t.shares, Price: t.price, Amount: +(t.shares * t.price).toFixed(2), Funding: t.side === 'buy' ? 'Cash' : 'Proceeds to cash' }))), 'Trades');
  const secs = SECTORS.map((s) => ({ Sector: s, 'Now (equity %)': +((before.sectors[s]?.wEq || 0) * 100).toFixed(2), 'After (equity %)': +((after.sectors[s]?.wEq || 0) * 100).toFixed(2), 'S&P 500 %': +((S.base.benchmark.sectorWeights[s] || 0) * 100).toFixed(2) }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Metric: 'Total value', Now: +before.total.toFixed(2), After: +after.total.toFixed(2) },
    { Metric: 'Positions', Now: before.rows.length, After: after.rows.length },
    { Metric: 'Cash', Now: +before.cash.toFixed(2), After: +after.cash.toFixed(2) },
    { Metric: 'Equity weight %', Now: +(before.eqValue / before.total * 100).toFixed(2), After: +(after.eqValue / after.total * 100).toFixed(2) },
  ]), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(secs), 'Sectors');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(after.rows.map((r) => ({ Ticker: r.ticker, Name: r.name, Sector: r.sector, Shares: +(+r.quantity).toFixed(4), Price: r.price, Value: +r.value.toFixed(2), 'Weight %': +(r.weight * 100).toFixed(3) }))), 'Proposed Holdings');
  XLSX.writeFile(wb, `SMIF_Scenario_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
async function commitScenario() {
  if (!S.trades.length) return toast('Add a trade first');
  confirmPublish(applyTrades(S.base, S.trades).port, `Applied trades: ${S.trades.map((t) => `${t.side} ${t.shares} ${t.ticker}`).join(', ')}`, () => { S.trades = []; store.set('ticket', []); renderTicket(); });
}

// ======================================================================
// Master copy (data room)
// ======================================================================
function cleanPortfolio(p) {
  return {
    meta: { ...(p.meta || {}) },
    cash: +(+p.cash).toFixed(2),
    holdings: p.holdings.map((h) => ({ ticker: h.ticker, name: h.name, assetClass: h.assetClass, sector: h.sector, industry: h.industry, quantity: +h.quantity, avgCost: +h.avgCost, price: h.price, prevClose: h.prevClose, purchaseDate: h.purchaseDate })),
    snapshotReturns: p.snapshotReturns || S.seed.snapshotReturns,
    benchmark: p.benchmark || S.seed.benchmark,
    spxConstituents: p.spxConstituents || S.seed.spxConstituents,
    watchlist: p.watchlist || S.seed.watchlist,
    focusList: p.focusList || S.seed.focusList || [],
  };
}
function confirmPublish(port, note, after) {
  const key = S.settings.key || store.sget('key');
  if (!S.api) return toast('Publishing needs the deployed site (server functions aren\'t reachable here). Use "Use for me only" or download the Excel instead.', 5000);
  const b = modal(`<h2>Publish as the master copy?</h2><p>Everyone who opens the dashboard will see this version. The current master is kept in version history, so it can be restored.</p>
    <label class="field">Your name<input class="input" id="pbName" value="${esc(S.settings.name)}" /></label>
    <label class="field">What changed<input class="input" id="pbNote" value="${esc(note || '')}" /></label>
    <label class="field">Admin passcode<input class="input" id="pbKey" type="password" value="${esc(key)}" /></label>
    <div class="row"><button class="btn primary" id="pbOk">Publish</button><button class="btn" id="pbCancel">Cancel</button></div>`);
  $('#pbCancel', b).onclick = closeModal;
  $('#pbOk', b).onclick = async () => {
    const body = cleanPortfolio(port);
    body.meta.updatedBy = $('#pbName', b).value || 'Admin';
    body.meta.note = $('#pbNote', b).value;
    body.meta.asOf = new Date().toISOString().slice(0, 10);
    const k = $('#pbKey', b).value;
    store.sset('key', k);
    try {
      const r = await getJSON('/api/portfolio', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-key': k }, body: JSON.stringify(body) });
      body.meta = r.meta;
      S.master = body; S.base = body; S.source = 'master';
      store.del('localPortfolio');
      closeModal();
      toast(`Published master v${r.meta.version}`);
      after && after();
      refreshAll();
    } catch (e) { toast('Publish failed: ' + e.message, 5000); }
  };
}

function renderData() {
  const m = S.base.meta || {};
  const rcEl = document.getElementById('reconCard');
  if (rcEl) rcEl.innerHTML = S.hist
    ? `<div class="card-head"><h2>Checked against Schwab transactions</h2><span class="hint">${fmt.n(S.hist.transactions)} transactions · ${fdate(S.hist.from)} → ${fdate(S.hist.to)}${S.hist.publishedAt ? ` · uploaded ${new Date(S.hist.publishedAt).toLocaleDateString()}` : ''}</span></div>${reconHTML(reconcile(S.base, S.hist), S.hist)}
       <div class="hint" style="margin-top:10px;color:var(--muted);font-size:12px">To update: export "Transactions – All" from Schwab as Excel and drop it in the upload box above.</div>`
    : '<div class="empty">No transaction history loaded. Export "Transactions – All" from Schwab and drop it in the upload box above.</div>';
  $('#dataStatus').innerHTML = `<div class="list">
    <div class="list-item"><span>Showing</span><b>${{ master: 'Master copy', seed: 'Original Excel import', local: 'Your local copy' }[S.source]}</b></div>
    <div class="list-item"><span>Version</span><b>${m.version ? 'v' + m.version : '—'}</b></div>
    <div class="list-item"><span>Last updated</span><b>${m.updatedAt ? new Date(m.updatedAt).toLocaleString() : '—'}</b></div>
    <div class="list-item"><span>Updated by</span><b>${esc(m.updatedBy || '—')}</b></div>
    <div class="list-item"><span>Prices</span><b class="${S.live ? 'up' : ''}">${S.live ? 'Live · Yahoo Finance' : 'Workbook snapshot'}</b></div>
    <div class="list-item"><span>Shared master store</span><b>${S.api ? (S.writable ? 'Connected' : 'Read-only (no ADMIN_KEY)') : 'Not deployed'}</b></div>
  </div>${S.source === 'local' ? '<div class="warn-box">You\'re viewing a local copy only you can see. <a href="#" id="backMaster">Switch back to the master</a>.</div>' : ''}`;
  const bm = $('#backMaster');
  if (bm) bm.onclick = (e) => { e.preventDefault(); store.del('localPortfolio'); S.base = S.master || S.seed; S.source = S.master ? 'master' : 'seed'; refreshAll(); };
  if (!S.draft) S.draft = JSON.parse(JSON.stringify(S.base));
  $('#editCash').value = (+S.draft.cash).toFixed(2);
  renderEditTable();
  $('#setName').value = S.settings.name || '';
  $('#setKey').value = store.sget('key');
}
function renderEditTable() {
  const cols = [['ticker', 'Ticker', 'text', 90], ['name', 'Name', 'text', 220], ['assetClass', 'Class', 'sel', 130], ['sector', 'Sector', 'text', 190], ['quantity', 'Shares', 'number', 100], ['avgCost', 'Avg cost', 'number', 110], ['purchaseDate', 'First bought', 'date', 150]];
  const classes = ['Equity', 'Fixed Income', 'Money Market'];
  $('#tblEdit').innerHTML = `<thead><tr>${cols.map((c) => `<th style="cursor:default">${c[1]}</th>`).join('')}<th></th></tr></thead><tbody>${S.draft.holdings.map((h, i) => `<tr>${cols.map(([k, , t, w]) => `<td style="min-width:${w}px">${t === 'sel' ? `<select class="input" data-i="${i}" data-k="${k}">${classes.map((c) => `<option ${h[k] === c ? 'selected' : ''}>${c}</option>`).join('')}</select>` : `<input class="input" data-i="${i}" data-k="${k}" type="${t}" value="${esc(k === 'avgCost' && h[k] != null ? +(+h[k]).toFixed(4) : h[k] ?? '')}" ${t === 'number' ? 'step="any"' : ''}/>`}</td>`).join('')}<td><button class="btn sm danger" data-del="${i}">✕</button></td></tr>`).join('')}</tbody>`;
  $$('#tblEdit [data-k]').forEach((el) => el.addEventListener('change', () => {
    const h = S.draft.holdings[+el.dataset.i];
    let v = el.value;
    if (el.dataset.k === 'quantity' || el.dataset.k === 'avgCost') v = parseFloat(v) || 0;
    if (el.dataset.k === 'ticker') v = v.toUpperCase().trim();
    h[el.dataset.k] = v;
  }));
  $$('#tblEdit [data-del]').forEach((b) => b.addEventListener('click', () => { S.draft.holdings.splice(+b.dataset.del, 1); renderEditTable(); }));
}

// ---- Excel export / import ----
function downloadMaster() {
  const c = computePortfolio(S.base, S.live ? S.market : {});
  const wb = XLSX.utils.book_new();
  const holdings = c.rows.map((r) => ({
    Ticker: r.ticker, Name: r.name, 'Asset Class': r.assetClass, Sector: r.sector, Industry: r.industry,
    Quantity: +r.quantity, 'Avg Cost': +(+r.avgCost).toFixed(4), 'Purchase Date': r.purchaseDate,
    Price: +(+r.price).toFixed(4), 'Market Value': +r.value.toFixed(2), 'Cost Basis': +r.cost.toFixed(2),
    'Unrealized G/L': +r.gl.toFixed(2), '% Return': r.ret != null ? +(r.ret * 100).toFixed(2) : null, 'Weight %': +(r.weight * 100).toFixed(3),
  }));
  const ws = XLSX.utils.json_to_sheet(holdings);
  ws['!cols'] = [8, 34, 13, 24, 30, 10, 10, 13, 10, 13, 12, 13, 9, 9].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Holdings');
  const sum = [
    { Item: 'Fund', Value: S.base.meta?.fund || 'KSU SMIF' },
    { Item: 'Cash', Value: +c.cash.toFixed(2) },
    { Item: 'Total value', Value: +c.total.toFixed(2) },
    { Item: 'Equities', Value: +c.eqValue.toFixed(2) },
    { Item: 'Fixed income', Value: +c.fiValue.toFixed(2) },
    { Item: 'Money market', Value: +c.mmValue.toFixed(2) },
    { Item: 'Unrealized G/L', Value: +c.unrealized.toFixed(2) },
    { Item: 'Prices as of', Value: S.live ? new Date().toISOString() : S.base.meta?.asOf },
    { Item: 'Master version', Value: S.base.meta?.version || '' },
    { Item: 'Last updated by', Value: S.base.meta?.updatedBy || '' },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sum), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sectorData('equity').map((x) => ({ Sector: x.s, 'SMIF % of equities': +(x.smif * 100).toFixed(2), 'S&P 500 %': +(x.spx * 100).toFixed(2), 'Over/Under (pts)': +((x.smif - x.spx) * 100).toFixed(2) }))), 'Sectors');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['How to use this file'],
    ['1. Edit the Holdings tab: Ticker, Name, Asset Class, Sector, Quantity, Avg Cost, Purchase Date. Other columns are recalculated by the site.'],
    ['2. Put uninvested cash on the Summary tab (row "Cash").'],
    ['3. Upload the file on the dashboard\'s Master Copy page. Review the changes, then "Use for me only" or "Publish as master" (passcode).'],
    ['Asset Class must be Equity, Fixed Income or Money Market. Sectors use GICS names (e.g. Information Technology).'],
  ]), 'Instructions');
  XLSX.writeFile(wb, `SMIF_Master_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function parseWorkbook(wb) {
  // A) this site's export
  if (wb.Sheets.Holdings) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets.Holdings, { raw: true });
    const cashRow = wb.Sheets.Summary ? XLSX.utils.sheet_to_json(wb.Sheets.Summary).find((r) => /^cash$/i.test(r.Item)) : null;
    return {
      cash: cashRow ? +cashRow.Value : S.base.cash,
      holdings: rows.filter((r) => r.Ticker).map((r) => ({
        ticker: String(r.Ticker).toUpperCase().trim(), name: r.Name || r.Ticker, assetClass: r['Asset Class'] || 'Equity',
        sector: r.Sector || (r['Asset Class'] !== 'Equity' ? r['Asset Class'] : 'Other'), industry: r.Industry || '', quantity: +r.Quantity || 0, avgCost: +r['Avg Cost'] || 0,
        price: +r.Price || null, prevClose: +r.Price || null, purchaseDate: normDate(r['Purchase Date']),
      })),
    };
  }
  // B) a SMIF-style positions workbook. Columns are found by header name (with common alternatives),
  //    so moving or lightly renaming columns still works.
  return parsePositionsSheet(wb);
}
const NORM = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const COLS = {
  name: ['name', 'description', 'security', 'securityname', 'company'],
  ticker: ['ticker', 'symbol', 'tickersymbol'],
  qty: ['quantity', 'qty', 'shares', 'sharesheld', 'position', 'units'],
  price: ['currentprice', 'price', 'lastprice', 'last', 'marketprice', 'close'],
  prev: ['previousclose', 'prevclose', 'priorclose', 'yesterdaysclose'],
  unitCost: ['purchaseprice', 'avgcost', 'averagecost', 'costpershare', 'unitcost', 'avgprice', 'averageprice'],
  costBasis: ['costbasis', 'totalcost', 'cost'],
  date: ['purchasedate', 'datepurchased', 'dateacquired', 'acquired', 'opendate', 'buydate'],
  value: ['currentvalue', 'marketvalue', 'value', 'mktvalue'],
  assetClass: ['assetclass', 'securitytype', 'class'],
  sector: ['gicssector', 'sector'],
};
const SECTION = [ // subtotal rows in column A close a section (as in the SMIF workbook)
  { re: /^(total\s+)?(equity|equities|stocks?|common stocks?)$/i, next: 'Fixed Income' },
  { re: /^(total\s+)?(fixed income|bonds?|fixed-income)$/i, next: 'Money Market' },
];
function findHeader(a) {
  for (let i = 0; i < Math.min(15, a.length); i++) {
    const h = (a[i] || []).map(NORM);
    const has = (k) => COLS[k].some((n) => h.includes(n));
    if (has('ticker') && has('qty')) return i;
  }
  return -1;
}
function parsePositionsSheet(wb) {
  const names = [...wb.SheetNames].sort((x, y) => (y === 'Portfolio') - (x === 'Portfolio'));
  let ws = null, a = null, hi = -1, sheetName = '';
  for (const n of names) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true });
    const i = findHeader(rows);
    if (i >= 0) { ws = wb.Sheets[n]; a = rows; hi = i; sheetName = n; break; }
  }
  if (!ws) throw new Error('Couldn\'t find a sheet with Ticker and Quantity columns. Expected the SMIF "Portfolio" tab.');
  const hdr = a[hi].map(NORM);
  const col = (k, last = false) => { for (const n of COLS[k]) { const i = last ? hdr.lastIndexOf(n) : hdr.indexOf(n); if (i >= 0) return i; } return -1; };
  const C = { name: col('name'), ticker: col('ticker'), qty: col('qty'), price: col('price'), prev: col('prev'), unitCost: col('unitCost'), costBasis: col('costBasis'), date: col('date'), value: col('value'), assetClass: col('assetClass'), sector: col('sector') };
  // SMIF workbook: two "GICS Industry" columns — first is the sector, second the industry
  const g1 = hdr.indexOf('gicsindustry'), g2 = hdr.lastIndexOf('gicsindustry');
  if (C.sector < 0 && g1 >= 0) C.sector = g1;
  C.industry = g2 > g1 ? g2 : g1 >= 0 && g1 !== C.sector ? g1 : hdr.indexOf('industry');
  if (C.name < 0) C.name = 0;
  const warnings = [];
  const found = [`Sheet "${sheetName}"`];
  if (C.price < 0) warnings.push('No price column found — values use live prices or cost.');
  if (C.unitCost < 0 && C.costBasis < 0) warnings.push('No purchase price / cost basis column found — cost basis kept from the current master where possible.');
  const prevBy = Object.fromEntries((S.base?.holdings || []).map((h) => [h.ticker, h]));
  const num = (v) => (v === '' || v == null || !isFinite(+v) ? null : +v);
  let section = 'Equity', cash = null, sectionsSeen = 0;
  const subtotals = {};
  const holdings = [];
  const classFix = [];
  for (const r of a.slice(hi + 1)) {
    const label = String(r[C.name] ?? '').replace(/\s+/g, ' ').trim();
    const t = typeof r[C.ticker] === 'string' ? r[C.ticker].trim().toUpperCase() : '';
    if (!t) {
      const sec = SECTION.find((x) => x.re.test(label));
      if (sec) { subtotals[section] = num(r[C.value]); section = sec.next; sectionsSeen++; continue; }
      if (/^(total\s+)?(cash|cash\s*(&|and)\s*equivalents|cash balance)$/i.test(label) && cash == null) {
        cash = num(r[C.value]) ?? r.map(num).find((v) => v != null) ?? 0;
        continue;
      }
      continue;
    }
    const q = num(r[C.qty]);
    if (!/^[A-Z0-9.\-^ ]{1,12}$/.test(t) || q == null) continue;
    let ac = C.assetClass >= 0 && r[C.assetClass] ? String(r[C.assetClass]).trim() : section;
    if (/equit|stock/i.test(ac)) ac = 'Equity'; else if (/fixed|bond/i.test(ac)) ac = 'Fixed Income'; else if (/money|mmf|cash/i.test(ac)) ac = 'Money Market';
    const old = prevBy[t];
    if (old && old.assetClass && old.assetClass !== ac) { classFix.push(`${t} (${ac} → kept as ${old.assetClass})`); ac = old.assetClass; }
    const price = num(r[C.price]);
    let cost = C.unitCost >= 0 ? num(r[C.unitCost]) : null;
    if (cost == null && C.costBasis >= 0 && num(r[C.costBasis]) != null && q) cost = num(r[C.costBasis]) / q;
    if (ac === 'Money Market') cost = 1;
    if (cost == null) cost = old?.avgCost ?? 0;
    holdings.push({
      ticker: t, name: label || t, assetClass: ac,
      sector: ac === 'Equity' ? (C.sector >= 0 && r[C.sector] ? String(r[C.sector]).trim() : old?.sector || 'Other') : ac,
      industry: ac === 'Equity' ? (C.industry >= 0 && r[C.industry] ? String(r[C.industry]).trim() : old?.industry || '') : '',
      quantity: q, avgCost: cost, price, prevClose: num(r[C.prev]) ?? price,
      purchaseDate: C.date >= 0 ? normDate(r[C.date]) : old?.purchaseDate ?? null,
      _value: num(r[C.value]),
    });
  }
  if (cash == null) { warnings.push('No "Cash" row found — cash kept from the current master.'); cash = S.base?.cash ?? 0; }
  if (classFix.length) warnings.push(`Asset class kept from the current master for: ${classFix.join(', ')}.`);
  if (!sectionsSeen && C.assetClass < 0) warnings.push('No "Equity" / "Fixed Income" subtotal rows found — new tickers are treated as equities.');
  // totals check against the workbook's own numbers
  const checks = [];
  const val = (h) => h._value ?? (h.price != null ? h.quantity * h.price : null);
  for (const [sec, sub] of Object.entries(subtotals)) {
    if (sub == null) continue;
    const mine = holdings.filter((h) => h.assetClass === sec).reduce((x, h) => x + (val(h) || 0), 0);
    checks.push({ ok: Math.abs(mine - sub) < Math.max(1, sub * 0.0005), text: `${sec}: ${fmt.usdC(mine)} read vs ${fmt.usdC(sub)} subtotal in the workbook` });
  }
  const counts = ['Equity', 'Fixed Income', 'Money Market'].map((k) => `${holdings.filter((h) => h.assetClass === k).length} ${k === 'Equity' ? 'equities' : k.toLowerCase()}`);
  found.push(counts.join(' · '));
  if (!holdings.some((h) => h.assetClass === 'Equity')) warnings.push('No equities found — check the file before publishing.');
  const total = holdings.reduce((x, h) => x + (val(h) || 0), 0) + cash;
  holdings.forEach((h) => delete h._value);
  return { cash, holdings, warnings, checks, found, total };
}
function normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10); // Excel serial
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toISOString().slice(0, 10);
}
// ---------- transaction history upload + reconciliation ----------
function reconcile(base, hist) {
  const out = { shares: [], dates: [], notInHistory: [], notInPortfolio: [], checked: 0 };
  base.holdings.forEach((p) => {
    const h = hist.tickers[p.ticker];
    if (!h) { out.notInHistory.push(p.ticker); return; }
    out.checked++;
    if (Math.abs(h.qty - +p.quantity) > 0.01) out.shares.push({ t: p.ticker, port: +p.quantity, hist: h.qty });
    const since = h.periods.find((x) => !x.to)?.from;
    if (p.purchaseDate && since && since !== p.purchaseDate && p.ticker !== 'SNOXX') out.dates.push({ t: p.ticker, port: p.purchaseDate, hist: since });
  });
  Object.values(hist.tickers).forEach((h) => { if (h.qty >= 0.05 && !base.holdings.find((p) => p.ticker === h.ticker)) out.notInPortfolio.push(h.ticker); });
  out.cashPort = +base.cash; out.cashHist = hist.cash; out.cashDiff = +(hist.cash - base.cash).toFixed(2);
  return out;
}
function reconHTML(rc, hist) {
  const line = (ok, txt) => `<div class="${ok ? 'ok' : 'warn'}"><span>${txt}</span></div>`;
  return `<div class="recon">
    ${line(!rc.shares.length && !rc.notInHistory.length, rc.shares.length || rc.notInHistory.length ? `Share counts: ${rc.checked - rc.shares.length} of ${rc.checked + rc.notInHistory.length} match. ${rc.shares.map((x) => `${x.t} portfolio ${fmt.n(x.port, 2)} vs history ${fmt.n(x.hist, 2)}`).join(' · ')}${rc.notInHistory.length ? ` Not in history: ${rc.notInHistory.join(', ')}.` : ''}` : `Share counts: all ${rc.checked} holdings match the transaction history exactly.`)}
    ${line(!rc.notInPortfolio.length, rc.notInPortfolio.length ? `The history says we still own ${rc.notInPortfolio.join(', ')}, which the portfolio doesn't list.` : 'No positions are missing from the portfolio.')}
    ${line(!rc.dates.length, rc.dates.length ? `First-bought dates differ: ${rc.dates.map((x) => `${x.t} (${x.port} vs ${x.hist})`).join(', ')}` : 'First-bought dates all match.')}
    ${line(Math.abs(rc.cashDiff) < 1, Math.abs(rc.cashDiff) < 1 ? `Cash matches: ${fmt.usdC(rc.cashPort)}.` : `Cash: portfolio shows ${fmt.usdC(rc.cashPort)}, transaction history adds up to ${fmt.usdC(rc.cashHist)} (${rc.cashDiff > 0 ? '+' : ''}${fmt.usdC(rc.cashDiff)}). Check against the Schwab balance.`)}
    <div class="ok"><span>Cost basis uses Schwab's own figures (tax-lot accounting), so it isn't recalculated from trades.</span></div>
  </div>`;
}
function handleTxHistory(aoa, fname) {
  const hist = buildHistory(rowsFromSheet(aoa), fname);
  if (!hist.transactions) return toast('No transactions found in that file', 4000);
  S.pendingHist = hist;
  const rc = reconcile(S.base, hist);
  const el = $('#uploadPreview');
  el.style.display = '';
  el.innerHTML = `<div class="card-head"><h2>Transaction history: ${esc(fname)}</h2><span class="hint">${fmt.n(hist.transactions)} transactions · ${fdate(hist.from)} → ${fdate(hist.to)}</span></div>
    ${reconHTML(rc, hist)}
    ${Math.abs(rc.cashDiff) >= 1 ? `<label class="row mt" style="font-size:13px;color:var(--ink-2)"><input type="checkbox" id="txCash" checked /> Also set the master's cash to ${fmt.usdC(hist.cash)} (from the transaction history)</label>` : ''}
    <div class="row mt"><button class="btn" id="txLocal">Use for me only</button><button class="btn primary" id="txPublish">Publish history for everyone</button><button class="btn" id="txCancel">Cancel</button></div>`;
  $('#txCancel').onclick = () => { el.style.display = 'none'; S.pendingHist = null; };
  $('#txLocal').onclick = () => { S.hist = hist; store.set('localHist', hist); el.style.display = 'none'; toast('History loaded for you only'); refreshAll(); };
  $('#txPublish').onclick = () => publishHistory(hist, $('#txCash')?.checked);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function publishHistory(hist, setCash) {
  if (!S.api) return toast('Publishing needs the deployed site.', 4000);
  const k = store.sget('key') || prompt('Admin passcode');
  if (!k) return;
  try {
    hist.publishedBy = S.settings.name || 'Admin';
    await getJSON('/api/portfolio?doc=history', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-key': k }, body: JSON.stringify(hist) }, 30000);
    store.sset('key', k);
    S.hist = hist; store.del('localHist');
    $('#uploadPreview').style.display = 'none';
    toast('Transaction history published');
    if (setCash) confirmPublish({ ...S.base, cash: hist.cash }, `Cash set to ${fmt.usdC(hist.cash)} from transaction history`);
    refreshAll();
  } catch (e) { toast('Publish failed: ' + e.message, 5000); }
}

// ---------- the current master in the upload-template layout (edit and upload it back) ----------
function downloadPositions() {
  const p = S.base;
  const H = ['Name', 'Ticker', 'Quantity', 'Previous Close', 'Current Price', 'Purchase Price', 'Cost Basis', 'Current Value', 'GICS Sector', 'GICS Industry', 'Purchase Date'];
  const rows = [H];
  const px = (h) => +(h.price ?? h.prevClose ?? h.avgCost ?? 0);
  const line = (h) => {
    const r = rows.length + 1, mm = h.assetClass === 'Money Market';
    const q = +h.quantity, cur = mm ? 1 : px(h), cost = mm ? 1 : +(+h.avgCost).toFixed(4);
    rows.push([h.name, h.ticker, q, mm ? 1 : +(h.prevClose ?? cur), cur, cost,
      { t: 'n', f: `C${r}*F${r}`, v: q * cost }, { t: 'n', f: `C${r}*E${r}`, v: q * cur }, h.assetClass === 'Equity' ? h.sector || '' : '', h.assetClass === 'Equity' ? h.industry || '' : '', h.purchaseDate || '']);
  };
  const block = (ac, label) => {
    const a = rows.length + 1;
    p.holdings.filter((h) => h.assetClass === ac).sort((x, y) => x.ticker.localeCompare(y.ticker)).forEach(line);
    const b = rows.length;
    const tot = rows.slice(a - 1, b).reduce((t, r) => t + r[7].v, 0);
    rows.push([label, '', '', '', '', '', '', b >= a ? { t: 'n', f: `SUM(H${a}:H${b})`, v: tot } : 0]);
    return rows.length;
  };
  const eqR = block('Equity', 'Equity'), fiR = block('Fixed Income', 'Fixed Income');
  const mmA = rows.length + 1;
  p.holdings.filter((h) => h.assetClass !== 'Equity' && h.assetClass !== 'Fixed Income').forEach(line);
  const mmB = rows.length;
  rows.push(['Cash', '', '', '', '', '', '', +(+p.cash || 0).toFixed(2)]);
  const cashR = rows.length;
  const val = (i) => { const c = rows[i - 1][7]; return typeof c === 'object' ? c.v : +c || 0; };
  let grand = val(eqR) + val(fiR) + val(cashR); for (let i = mmA; i <= mmB; i++) grand += val(i);
  rows.push(['', '', '', '', '', '', 'Total', { t: 'n', f: `H${eqR}+H${fiR}${mmB >= mmA ? `+SUM(H${mmA}:H${mmB})` : ''}+H${cashR}`, v: grand }]);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [34, 10, 11, 14, 14, 15, 14, 15, 26, 40, 14].map((wch) => ({ wch }));
  const ins = XLSX.utils.aoa_to_sheet([
    ['SMIF positions — ' + (p.meta?.asOf || new Date().toISOString().slice(0, 10))],
    [''],
    ['This is the current master copy in the upload layout. To record trades:'],
    ['1. On the Portfolio tab, change the share counts (Quantity) and Purchase Price for anything bought or sold.'],
    ['2. New stock: insert a row above the "Equity" row. New bond ETF: above "Fixed Income". Money-market fund: below "Fixed Income".'],
    ['3. Sold out completely: delete the row (or set Quantity to 0).'],
    ['4. Update the Cash row (Current Value column) to the uninvested cash from Schwab.'],
    ['5. Save and drop it on Master Copy → Upload a workbook. A pop-up lists every change before anything is published.'],
    [''],
    ['Required columns: Ticker, Quantity. Keep the "Equity" and "Fixed Income" subtotal rows and the "Cash" row — they tell the site which section each row is in.'],
  ]);
  ins['!cols'] = [{ wch: 120 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Portfolio');
  XLSX.utils.book_append_sheet(wb, ins, 'Instructions');
  XLSX.writeFile(wb, `SMIF_Positions_${p.meta?.asOf || 'current'}.xlsx`);
}
async function handleFile(f) {
  try {
    let parsed;
    if (f.name.toLowerCase().endsWith('.json')) {
      const j = JSON.parse(await f.text());
      parsed = { cash: j.cash, holdings: j.holdings, meta: j.meta };
    } else {
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
      // a Schwab transaction export can be on any tab, with a title line or two above the headers
      for (const n of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true });
        const hi = aoa.slice(0, 6).findIndex((r) => looksLikeTransactions(r || []));
        if (hi >= 0) return handleTxHistory(aoa.slice(hi), f.name);
      }
      parsed = parseWorkbook(XLSX.read(await f.arrayBuffer(), { cellDates: false }));
    }
    if (!parsed.holdings?.length) throw new Error('No holdings found');
    const next = cleanPortfolio({ ...S.base, ...parsed, meta: { ...S.base.meta, asOf: new Date().toISOString().slice(0, 10), source: f.name } });
    S.pendingUpload = next;
    openTradeReview(next, f.name, parsed);
  } catch (e) {
    toast('Could not read that file: ' + e.message, 5000);
  }
}
// ---------- review an uploaded positions file as a list of trades ----------
function diffPositions(oldP, newP) {
  const O = Object.fromEntries(oldP.holdings.map((h) => [h.ticker, h]));
  const N = Object.fromEntries(newP.holdings.map((h) => [h.ticker, h]));
  // one price per ticker for both sides, so weight changes reflect trades only (not price moves)
  const px = {};
  for (const t of new Set([...Object.keys(O), ...Object.keys(N)])) {
    const p = N[t]?.price ?? (S.market[t]?.price) ?? O[t]?.price ?? N[t]?.avgCost ?? O[t]?.avgCost ?? 0;
    px[t] = { price: +p, prevClose: +p };
  }
  const before = computePortfolio(oldP, px), after = computePortfolio(newP, px);
  const wB = Object.fromEntries(before.rows.map((r) => [r.ticker, r.weight]));
  const wA = Object.fromEntries(after.rows.map((r) => [r.ticker, r.weight]));
  const rows = [], basis = [];
  for (const t of new Set([...Object.keys(O), ...Object.keys(N)])) {
    const o = +(O[t]?.quantity || 0), n = +(N[t]?.quantity || 0), d = n - o;
    if (Math.abs(d) < 1e-6) {
      if (O[t] && N[t] && Math.abs((+O[t].avgCost || 0) - (+N[t].avgCost || 0)) > 0.005) basis.push({ t, from: +O[t].avgCost, to: +N[t].avgCost });
      continue;
    }
    const action = !o ? 'New position' : !n ? 'Sold out' : d > 0 ? 'Added' : 'Trimmed';
    rows.push({ t, name: (N[t] || O[t]).name, ac: (N[t] || O[t]).assetClass, action, o, n, d, price: px[t].price, value: d * px[t].price, wB: wB[t] || 0, wA: wA[t] || 0 });
  }
  const order = { 'New position': 0, Added: 1, Trimmed: 2, 'Sold out': 3 };
  const acOrder = { Equity: 0, 'Fixed Income': 1, 'Money Market': 2 };
  rows.sort((x, y) => (acOrder[x.ac] ?? 3) - (acOrder[y.ac] ?? 3) || order[x.action] - order[y.action] || Math.abs(y.value) - Math.abs(x.value));
  const unchanged = newP.holdings.filter((h) => O[h.ticker] && Math.abs(+O[h.ticker].quantity - +h.quantity) < 1e-6).length;
  return { rows, basis, unchanged, before, after, implied: -rows.reduce((x, r) => x + r.value, 0), cashFrom: +oldP.cash || 0, cashTo: +newP.cash || 0 };
}
function schwabMatches(t, since) {
  const tr = S.hist?.tickers?.[t]?.trades || [];
  return tr.filter((x) => (x.type === 'Buy' || x.type === 'Sell') && (!since || x.date > since));
}
function openTradeReview(next, fname, parsed = {}) {
  const D = diffPositions(S.base, next);
  const since = S.base.meta?.asOf;
  const sh = (v) => fmt.n(v, Math.abs(v % 1) > 1e-6 ? 2 : 0);
  const pct = (v) => (v * 100).toFixed(2) + '%';
  const ACT = { 'New position': 'buy', Added: 'buy', Trimmed: 'sell', 'Sold out': 'sell' };
  const rowHTML = (r) => {
    const m = schwabMatches(r.t, since);
    const src = m.length ? `<div class="tr-src">Schwab: ${m.map((x) => `${x.type === 'Buy' ? 'bought' : 'sold'} ${sh(x.shares)} @ ${fmt.usdC(x.price)} on ${fdate(x.date)}`).join('; ')}</div>` : '';
    return `<tr><td><span class="tk">${esc(r.t)}</span><span class="nm">${esc(r.name)}</span>${src}</td>
      <td><span class="ttype ${ACT[r.action]}">${r.action}</span></td>
      <td class="n" data-l="Shares">${sh(r.o)} <span class="arrow">→</span> <b>${sh(r.n)}</b><div class="sub ${r.d > 0 ? 'up' : 'down'}">${r.d > 0 ? '+' : ''}${sh(r.d)} sh</div></td>
      <td class="n" data-l="Trade value">${r.value > 0 ? '' : '−'}${fmt.usd(Math.abs(r.value))}<div class="sub">@ ${fmt.usdC(r.price)}</div></td>
      <td class="n" data-l="Weight">${pct(r.wB)} <span class="arrow">→</span> <b>${pct(r.wA)}</b></td></tr>`;
  };
  const buys = D.rows.filter((r) => r.d > 0), sells = D.rows.filter((r) => r.d < 0);
  const summary = D.rows.length
    ? `${buys.length ? `${buys.length} buy${buys.length > 1 ? 's' : ''} (${fmt.usd(buys.reduce((x, r) => x + r.value, 0))})` : ''}${buys.length && sells.length ? ' · ' : ''}${sells.length ? `${sells.length} sell${sells.length > 1 ? 's' : ''} (${fmt.usd(-sells.reduce((x, r) => x + r.value, 0))})` : ''}`
    : 'No share changes';
  const cashGap = D.cashTo - D.cashFrom - D.implied;
  const checks = [
    ...(parsed.checks || []).map((c) => ({ ok: c.ok, text: c.text })),
    D.rows.length ? { ok: Math.abs(cashGap) < Math.max(50, Math.abs(D.implied) * 0.02), text: `Cash ${fmt.usdC(D.cashFrom)} → ${fmt.usdC(D.cashTo)} (${D.cashTo - D.cashFrom >= 0 ? '+' : '−'}${fmt.usd(Math.abs(D.cashTo - D.cashFrom))}). The trades above imply ${D.implied >= 0 ? '+' : '−'}${fmt.usd(Math.abs(D.implied))}${Math.abs(cashGap) < 1 ? '' : Math.abs(cashGap) < Math.max(50, Math.abs(D.implied) * 0.02) ? `; the small ${fmt.usd(Math.abs(cashGap))} difference is normal (dividends, fees, fill prices)` : `, so ${fmt.usd(Math.abs(cashGap))} is unexplained. Double-check the Cash row in the file`}.` }
      : { ok: Math.abs(D.cashTo - D.cashFrom) < 0.01, text: Math.abs(D.cashTo - D.cashFrom) < 0.01 ? `Cash unchanged at ${fmt.usdC(D.cashTo)}.` : `Cash ${fmt.usdC(D.cashFrom)} → ${fmt.usdC(D.cashTo)} with no trades. Fine if it's dividends or a deposit; otherwise check the Cash row against the Schwab balance.` },
  ];
  const warn = [...(parsed.warnings || [])];
  if (D.cashTo < 0) warn.push('Cash is negative in the uploaded file.');
  const goneN = D.rows.filter((r) => r.action === 'Sold out').length;
  if (D.before.rows.length >= 6 && goneN >= D.before.rows.length / 2) warn.unshift(`This file would sell out ${goneN} of ${D.before.rows.length} holdings. If you didn't mean that, it's probably the wrong file (e.g. the blank template with example rows) — press Cancel.`);
  const tickers = new Set(next.holdings.map((h) => h.ticker));
  if (['AAPL', 'JPM', 'XOM', 'LQD', 'SNOXX'].every((t) => tickers.has(t)) && next.holdings.length === 5 && Math.abs(+next.cash - 4461.46) < 0.01) warn.unshift('These look like the template\'s example rows. Replace them with the fund\'s real holdings before publishing.');
  const b = modal(`<div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap"><div style="min-width:0"><h2>Review proposed trades</h2>
      <div class="hint" style="color:var(--muted);font-size:12px;margin-top:4px">${esc(fname)} vs the current master${since ? ` (as of ${fdate(since)})` : ''} · ${esc((parsed.found || []).join(' · '))}</div></div><button class="btn sm" id="trClose">✕</button></div>
    <div class="tr-sum">
      <div><small>Trades found</small><b>${summary}</b></div>
      <div><small>Total value</small><b>${fmt.usd(D.before.total)} <span class="arrow">→</span> ${fmt.usd(D.after.total)}</b></div>
      <div><small>Positions</small><b>${D.before.rows.length} <span class="arrow">→</span> ${D.after.rows.length}</b></div>
    </div>
    ${D.rows.length ? `<div class="table-wrap"><table class="tr-table"><thead><tr><th style="cursor:default">Holding</th><th style="cursor:default">Trade</th><th class="n" style="cursor:default">Shares (old → new)</th><th class="n" style="cursor:default">Trade value ${tip('Change in shares × the price in the uploaded file. Weights use that same price for both old and new, so they show the effect of the trades only, not price moves.')}</th><th class="n" style="cursor:default">Weight (old → new)</th></tr></thead><tbody>${D.rows.map((r, i) => (i === 0 || D.rows[i - 1].ac !== r.ac ? `<tr class="tr-group"><td colspan="5">${acTag(r.ac)}<span>${D.rows.filter((x) => x.ac === r.ac).length} change${D.rows.filter((x) => x.ac === r.ac).length > 1 ? 's' : ''}</span></td></tr>` : '') + rowHTML(r)).join('')}</tbody></table></div>
      <div class="hint" style="color:var(--muted);font-size:12px">${D.unchanged} other position${D.unchanged === 1 ? '' : 's'} unchanged.</div>`
      : `<div class="empty" style="padding:14px">No trades — share counts are the same as the current master.</div>`}
    ${D.basis.length ? `<details class="fold"><summary><span>Cost basis updated without a trade (${D.basis.length})</span><small>Usually Schwab lot adjustments</small></summary><div style="font-size:13px;color:var(--ink-2)">${D.basis.map((x) => `<div class="list-item"><b>${esc(x.t)}</b><span>${fmt.usdC(x.from)} → ${fmt.usdC(x.to)} per share</span></div>`).join('')}</div></details>` : ''}
    <div class="recon">${checks.map((c) => `<div class="${c.ok ? 'ok' : 'warn'}"><span>${esc(c.text)}</span></div>`).join('')}${warn.map((w) => `<div class="warn"><span>${esc(w)}</span></div>`).join('')}</div>
    <div class="row"><button class="btn primary" id="trPublish">Looks right — publish</button><button class="btn" id="trLocal">Use for me only</button><button class="btn" id="trCancel">Cancel</button></div>`);
  $('#modalBody').classList.add('wide');
  const note = D.rows.length ? `Uploaded ${fname}: ${D.rows.map((r) => `${r.d > 0 ? 'bought' : 'sold'} ${sh(Math.abs(r.d))} ${r.t}`).join(', ')}` : `Uploaded ${fname}`;
  const cancel = () => { closeModal(); S.pendingUpload = null; };
  $('#trClose', b).onclick = cancel; $('#trCancel', b).onclick = cancel;
  $('#trLocal', b).onclick = () => { closeModal(); useLocal(next); };
  $('#trPublish', b).onclick = () => confirmPublish(next, note.slice(0, 300));
}
function useLocal(p) {
  const c = cleanPortfolio(p);
  c.meta.updatedBy = (S.settings.name || 'Me') + ' (local)';
  c.meta.updatedAt = new Date().toISOString();
  store.set('localPortfolio', c);
  S.base = c; S.source = 'local';
  $('#uploadPreview').style.display = 'none';
  toast('Loaded as your local copy — only you see it');
  refreshAll(true);
}
async function loadHistory() {
  if (!S.api) return toast('Version history needs the deployed site.');
  try {
    const r = await getJSON('/api/portfolio?history=1');
    $('#history').innerHTML = r.versions.length ? r.versions.map((v) => `<div class="ticket-item" style="grid-template-columns:1fr auto auto"><div><b>v${v.version || '?'}</b> · ${esc(v.updatedBy || '')}<div style="color:var(--muted);font-size:11px">${new Date(v.updatedAt).toLocaleString()} · ${esc(v.note || '')}</div></div><button class="btn sm" data-view="${esc(v.key)}">View</button><button class="btn sm" data-restore="${esc(v.key)}">Restore</button></div>`).join('') : '<div class="empty" style="padding:16px">Nothing published yet.</div>';
    $$('[data-view]', $('#history')).forEach((b) => b.onclick = async () => { const j = await getJSON('/api/portfolio?version=' + encodeURIComponent(b.dataset.view)); useLocal(j.master); });
    $$('[data-restore]', $('#history')).forEach((b) => b.onclick = async () => { const j = await getJSON('/api/portfolio?version=' + encodeURIComponent(b.dataset.restore)); confirmPublish(j.master, `Restored ${b.dataset.restore.slice(8, 24)}`); });
  } catch (e) { toast('Could not load history: ' + e.message); }
}

// ======================================================================
// Routing & wiring
// ======================================================================
const renderers = { overview: renderOverview, returns: renderReturns, allocation: renderAllocation, performance: renderPerformance, risk: renderRisk, holdings: renderHoldings, screener: () => { renderTicket(); syncTradePanel(); }, data: renderData };
function show(view) {
  if (!renderers[view]) view = 'overview';
  if ($('#modal').classList.contains('open')) closeModal();
  hideTip?.();
  S.view = view;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  try { renderers[view](); } catch (e) { console.error(e); toast('Render error: ' + e.message, 5000); }
  fillAcStrips();
  requestAnimationFrame(() => Object.values(charts).forEach((c) => c && !c.isDisposed() && c.resize()));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function refreshAll(resetDraft) {
  recalc();
  if (resetDraft) S.draft = null;
  renderStatus();
  renderTape();
  renderers[S.view]();
  fillAcStrips();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
$('#themeBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('smif.theme', t); } catch { /* private mode */ }
  applyTheme(t);
  Object.values(charts).forEach((c) => { try { c.dispose(); } catch { /* ignore */ } });
  for (const k in charts) delete charts[k];
  refreshAll();
  if (S.view === 'screener' && S.stock) renderStockCard();
});
applyTheme(document.documentElement.dataset.theme);
$$('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.go); }));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
const seg = (id, key, fn) => $$(`#${id} button`).forEach((b) => b.addEventListener('click', () => { S[key] = b.dataset.v; $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b)); fn(); }));
seg('tmColor', 'tmColor', renderAllocation);
seg('perfRange', 'perfRange', () => {
  if (S.perfRange === 'Custom' && !S.perfFrom && S.perfWin && S.perfBt) { S.perfFrom = S.perfBt.bt.dates[S.perfWin.s]; S.perfTo = S.perfBt.bt.dates[S.perfWin.e]; }
  if (S.perfRange !== 'Custom') store.set('perfRange', S.perfRange);
  renderPerfChart();
});
seg('perfView', 'perfView', () => { store.set('perfView', S.perfView); if (S.perfBt) drawPerf(true); });
const perfDateChange = () => {
  const f = $('#perfFrom').value, t = $('#perfTo').value;
  if (!f) return;
  const min = new Date(Date.now() - 10 * 365.25 * 864e5).toISOString().slice(0, 10);
  S.perfFrom = f < min ? min : f; S.perfTo = t && t > S.perfFrom ? t : null;
  S.perfRange = 'Custom'; $$('#perfRange button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'Custom'));
  renderPerfChart();
};
$('#perfFrom').addEventListener('change', perfDateChange);
$('#perfTo').addEventListener('change', perfDateChange);
$('#perfReset').addEventListener('click', () => {
  if (S.perfRange === 'Custom') { S.perfRange = store.get('perfRange', '1Y'); S.perfFrom = S.perfTo = null; }
  renderPerfChart();
});
$('#tradeToggle').addEventListener('change', (e) => { S.showTrades = e.target.checked; store.set('showTrades', S.showTrades); renderPerfChart(); });
seg('secBasis', 'secBasis', () => renderSectorBars('chSector', S.secBasis));
seg('perfClass', 'perfClass', renderPerformance);
seg('perfMode', 'perfMode', renderPerformance);
$('#hSearch').addEventListener('input', renderHoldings);
$('#fhSearch').addEventListener('input', renderHistoryLists);
$('#tlType').addEventListener('change', () => { tlShown = 40; renderHistoryLists(); });
$('#tlSearch').addEventListener('input', () => { tlShown = 40; renderHistoryLists(); });
$('#tlMore').addEventListener('click', () => { tlShown += 60; renderHistoryLists(); });
$('#hSector').addEventListener('change', renderHoldings);
$('#hClass').addEventListener('change', renderHoldings);
$('#hExport').addEventListener('click', downloadMaster);
$('#rfInput').addEventListener('change', (e) => { const v = parseFloat(e.target.value); S.rf = isFinite(v) ? Math.min(20, Math.max(0, v)) / 100 : null; if (S.rf != null) e.target.value = (S.rf * 100).toFixed(2); store.set('rf', S.rf); computeStats(); renderRisk(); });
$('#refreshBtn').addEventListener('click', async () => { toast('Refreshing prices…'); await loadMarket(); refreshAll(); toast(S.live ? 'Prices updated' : 'Live data unavailable — showing snapshot'); });

// screener wiring
attachSearch($('#scrInput'), $('#scrSuggest'), analyze);
$('#scrGo').addEventListener('click', async () => analyze(await resolveSymbol($('#scrInput').value)));
$$('#sideToggle button').forEach((b) => b.addEventListener('click', () => { S.trade.side = b.dataset.v; syncTradePanel(); }));
$$('#amtMode button').forEach((b) => b.addEventListener('click', () => { S.trade.mode = b.dataset.v; $('#amtInput').value = ''; syncTradePanel(); }));
['amtInput', 'manualPx'].forEach((id) => $('#' + id).addEventListener('input', syncTradePanel));
$('#addTrade').addEventListener('click', () => {
  const t = computeTrade();
  if (!t || !t.shares) return;
  if (S.stock.manual && !S.stock.price) S.stock.price = t.px;
  S.trades.push(mkTrade(t));
  store.set('ticket', S.trades);
  $('#amtInput').value = '';
  renderTicket(); syncTradePanel();
  openImpactPopup();
});
$('#reviewImpact').addEventListener('click', openImpactPopup);
$('#clearTicket').addEventListener('click', () => { S.trades = []; store.set('ticket', []); renderTicket(); syncTradePanel(); });
$('#saveScenario').addEventListener('click', saveScenario);
$('#loadScenario').addEventListener('click', loadScenario);
$('#exportScenario').addEventListener('click', exportScenario);
$('#commitScenario').addEventListener('click', commitScenario);

// data room wiring
$('#dlMaster').addEventListener('click', downloadMaster);
$('#dlPositions').addEventListener('click', downloadPositions);
$('#dlPositions2').addEventListener('click', downloadPositions);
$('#dlJson').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(cleanPortfolio(S.base), null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `SMIF_Master_${new Date().toISOString().slice(0, 10)}.json`; a.click();
});
const drop = $('#drop');
$('#fileIn').addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));
$('#addRow').addEventListener('click', () => { S.draft.holdings.unshift({ ticker: '', name: '', assetClass: 'Equity', sector: '', industry: '', quantity: 0, avgCost: 0, purchaseDate: new Date().toISOString().slice(0, 10) }); renderEditTable(); });
$('#revertEdits').addEventListener('click', () => { S.draft = null; renderData(); toast('Edits reverted'); });
$('#editCash').addEventListener('change', (e) => { S.draft.cash = parseFloat(e.target.value) || 0; });
const draftValid = () => {
  const hs = S.draft.holdings;
  if (hs.some((h) => !h.ticker)) { toast('Every row needs a ticker'); return false; }
  const neg = hs.find((h) => !(+h.quantity >= 0) || !((+h.avgCost || 0) >= 0));
  if (neg) { toast(`${neg.ticker}: shares and cost can't be negative`); return false; }
  const seen = new Set(), dup = hs.find((h) => (seen.has(h.ticker) ? true : (seen.add(h.ticker), false)));
  if (dup) { toast(`${dup.ticker} is listed twice — combine the rows first`); return false; }
  if (!(+S.draft.cash >= 0)) { toast("Cash can't be negative"); return false; }
  return true;
};
$('#useLocal').addEventListener('click', () => draftValid() && useLocal(S.draft));
$('#publishEdits').addEventListener('click', () => draftValid() && confirmPublish(S.draft, 'Edited holdings', () => { S.draft = null; }));
$('#loadHistory').addEventListener('click', loadHistory);
const saveSettings = () => { S.settings.name = $('#setName').value; store.set('settings', { name: S.settings.name }); };
$('#setName').addEventListener('change', saveSettings);
$('#setKey').addEventListener('change', (e) => store.sset('key', e.target.value));
$('#checkKey').addEventListener('click', async () => {
  if (!S.api) return toast('Needs the deployed site.');
  try { const r = await getJSON('/api/portfolio?check=1', { method: 'POST', headers: { 'x-admin-key': $('#setKey').value } }); toast(!r.configured ? 'No ADMIN_KEY set on the server yet' : r.ok ? '✓ Passcode works' : '✕ Wrong passcode'); }
  catch (e) { toast('Check failed: ' + e.message); }
});
$('#resetLocal').addEventListener('click', () => { store.del('localPortfolio'); S.base = S.master || S.seed; S.source = S.master ? 'master' : 'seed'; refreshAll(true); toast('Local copy cleared'); });

// cursor spotlight + gentle 3D tilt on cards (mouse/trackpad only)
if (window.matchMedia('(hover: hover) and (pointer: fine)').matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    card.style.setProperty('--mx', x + 'px');
    card.style.setProperty('--my', y + 'px');
    if (card.classList.contains('tile') || card.classList.contains('tilt')) {
      const rx = ((y / r.height) - 0.5) * -5, ry = ((x / r.width) - 0.5) * 5;
      card.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-2px)`;
    }
  }, { passive: true });
  document.addEventListener('pointerout', (e) => {
    const card = e.target.closest?.('.card.tile, .card.tilt');
    if (card && !card.contains(e.relatedTarget)) card.style.transform = '';
  });
}
let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  clearTimeout(window._rz);
  window._rz = setTimeout(() => {
    // Phones fire 'resize' when the URL bar hides during scroll — ignore height-only changes.
    if (!calc || Math.abs(window.innerWidth - lastW) < 2) return;
    const crossed = (lastW <= 760) !== (window.innerWidth <= 760);
    lastW = window.innerWidth;
    if (crossed && ['overview', 'allocation', 'performance', 'risk'].includes(S.view)) renderers[S.view]();
  }, 250);
});

async function checkMaster() {
  try {
    const r = await getJSON('/api/portfolio', {}, 8000);
    const v = r.master?.meta?.version || 0, cur = S.master?.meta?.version || 0;
    if (r.master && v !== cur) {
      S.master = r.master;
      if (S.source !== 'local') {
        S.base = r.master; S.source = 'master';
        ['benchmark', 'spxConstituents', 'snapshotReturns', 'watchlist', 'focusList'].forEach((k) => { if (!S.base[k]) S.base[k] = S.seed[k]; });
        refreshAll(true);
        toast(`Master copy updated to v${v} by ${r.master.meta.updatedBy || 'an officer'}`, 4000);
      }
    }
  } catch { /* offline: keep what we have */ }
}
// Mock trades should use today's price, not the price on the day they were added.
function repriceTicket() {
  if (!S.live || !S.trades.length) return;
  let n = 0;
  S.trades.forEach((t) => { const m = S.market[t.ticker]; if (m && isFinite(m.price) && Math.abs(m.price - t.price) > 1e-6) { t.price = m.price; n++; } });
  if (n) { store.set('ticket', S.trades); if (S.view === 'screener') { renderTicket(); syncTradePanel(); } }
}

// ---- ⓘ explanations: one floating box, positioned to stay fully on screen ----
const tipPop = document.createElement('div');
tipPop.className = 'tip-pop'; tipPop.setAttribute('role', 'tooltip');
tipPop.innerHTML = '<span class="t"></span><button class="x" aria-label="Close">✕</button>';
document.body.appendChild(tipPop);
let tipFor = null;
function showTip(el) {
  if (tipFor && tipFor !== el) tipFor.classList.remove('on');
  tipFor = el; el.classList.add('on');
  tipPop.querySelector('.t').textContent = el.dataset.tip;
  tipPop.classList.add('show');
  const r = el.getBoundingClientRect(), pw = tipPop.offsetWidth, ph = tipPop.offsetHeight, pad = 12;
  let left = Math.min(Math.max(pad, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - pad);
  let top = r.top - ph - 10;
  if (top < pad + 60) top = r.bottom + 10; // not enough room above (sticky header) → show below
  if (top + ph > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - ph - pad);
  tipPop.style.left = left + 'px'; tipPop.style.top = top + 'px';
}
function hideTip() { tipPop.classList.remove('show'); if (tipFor) tipFor.classList.remove('on'); tipFor = null; }
document.addEventListener('click', (e) => {
  const t = e.target.closest('.tip');
  if (t) { e.preventDefault(); e.stopPropagation(); tipFor === t ? hideTip() : showTip(t); return; }
  if (e.target.closest('.tip-pop .x') || !e.target.closest('.tip-pop')) hideTip();
}, true);
if (window.matchMedia('(hover: hover)').matches) {
  document.addEventListener('mouseover', (e) => { const t = e.target.closest?.('.tip'); if (t && t !== tipFor) showTip(t); });
  document.addEventListener('mouseout', (e) => { const t = e.target.closest?.('.tip'); if (t && !t.contains(e.relatedTarget)) hideTip(); });
}
// iPhones don't send a click when you tap empty space, so close on any touch outside the box too
document.addEventListener('touchstart', (e) => { if (tipFor && !e.target.closest('.tip, .tip-pop')) hideTip(); }, { passive: true, capture: true });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideTip(); if ($('#modal')?.classList.contains('open') && !SC.open) closeModal(); } if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('tip')) { e.preventDefault(); showTip(e.target); } });
window.addEventListener('scroll', () => { hideTip(); $('#toTop').classList.toggle('show', window.scrollY > 600); }, { passive: true });
$('#toTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
document.addEventListener('scroll', (e) => { if (e.target !== document && tipFor && e.target.contains?.(tipFor)) hideTip(); }, { capture: true, passive: true });

// ======================================================================
// Boot
// ======================================================================
(async function boot() {
  try {
    await loadPortfolio();
  } catch (e) {
    $('#splash').classList.add('done');
    document.querySelector('main').innerHTML = `<div class="card"><div class="empty"><b>Couldn't load the portfolio</b>${esc(e.message)}</div></div>`;
    return;
  }
  S.trades = store.get('ticket', []);
  calc = computePortfolio(S.base, {});
  renderStatus();
  $('#scrChips').innerHTML = [...(S.base.watchlist || []), ...(S.base.focusList || [])].map((t) => `<button class="chip" data-t="${t}">${t}</button>`).join('') || '<span style="color:var(--muted);font-size:12px">—</span>';
  $$('#scrChips .chip').forEach((c) => c.addEventListener('click', () => analyze(c.dataset.t)));
  // Charts measure their labels when they're drawn. If that happens before the Montserrat web font arrives,
  // the labels are sized for the fallback font and get clipped (e.g. "ommunication Services"). So wait for it.
  const fontsOk = () => document.fonts?.check?.('600 12px Montserrat');
  try { await Promise.race([Promise.all(['400 11px Montserrat', '500 12px Montserrat', '600 12px Montserrat', '700 12px Montserrat'].map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 2500))]); } catch { /* old browser */ }
  if (!fontsOk() && document.fonts) {
    // font came late (slow network): redraw once it lands, under a new font name so cached label widths aren't reused
    const late = () => { if (!fontsOk()) return; document.fonts.removeEventListener?.('loadingdone', late); baseText.fontFamily = 'Montserrat, sans-serif'; refreshAll(); };
    document.fonts.addEventListener?.('loadingdone', late);
  }
  show(location.hash.slice(1) || 'overview');
  renderTape();
  setTimeout(() => $('#splash').classList.add('done'), 350);
  await loadMarket();
  refreshAll();
  repriceTicket();
  setInterval(async () => {
    if (document.hidden || !S.api) return;
    await checkMaster();
    await loadMarket();
    repriceTicket();
    refreshAll();
  }, 15 * 60 * 1000); // every 15 min (Netlify credits); CDN cache is 5 min
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.api) checkMaster(); });
})();

// ======================================================================
// Scrappy AI — portfolio assistant (answers are generated on the server from the fund data we send)
// ======================================================================
const SC = { open: false, msgs: store.get('scrappyChat', []).map((m) => ({ ...m, typing: false })), busy: false };
const STOP = new Set('a an the and or but if is are was were be been being do does did have has had having we our us i me my you your it its this that these those of on in to for from with about at by as into over under than then there here what which who whom whose when where why how any all some more most much many can could should would will shall may might must not no yes buy sell sold bought own owned owning hold held holding stock stocks share shares position positions portfolio fund smif good bad think like right now today currently current price prices trade trades trading add trim sector sectors weight weights compare versus vs ever before previously still also just really please tell show give analysis analyze long short term year years month months company companies inc corp invest investing investment worth time again would'.split(' '));
const NAME_STOP = new Set('the american first general united international national global new bank capital financial group holdings company corporation corp inc ltd plc co class trust energy home digital royal southern western eastern northern public service health technologies systems industries'.split(' '));
function normName(n) { return String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(inc|corp|corporation|company|co|holdings|holding|group|plc|ltd|limited|class [abc]|the|n\.?v|s\.?a|l\.?p|com)\b\.?/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function scrappyIndex() {
  if (SC.index) return SC.index;
  const m = new Map();
  const put = (t, name, src) => { if (!t || t === 'SNOXX' || CASH_LIKE.has(t)) return; const e = m.get(t) || { t, name: '' }; if (!e.name && name) e.name = name; e[src] = true; m.set(t, e); };
  (S.base.spxConstituents || []).forEach((x) => put(x.ticker, x.name, 'spx'));
  Object.values(S.hist?.tickers || {}).forEach((x) => put(x.ticker, x.name, 'hist'));
  S.base.holdings.forEach((h) => put(h.ticker, h.name, 'held'));
  const list = [...m.values()].map((e) => ({ ...e, nn: normName(e.name), first: normName(e.name).split(' ')[0] || '' }));
  SC.index = { map: m, list };
  return SC.index;
}
async function scrappyEntities(q) {
  const { map, list } = scrappyIndex();
  const found = [];
  const add = (t) => { if (t && !found.includes(t) && found.length < 3) found.push(t); };
  // $TSLA or bare upper-case tickers we know
  (q.match(/\$[A-Za-z.]{1,6}\b/g) || []).forEach((x) => add(x.slice(1).toUpperCase()));
  (q.match(/\b[A-Z][A-Z.]{0,5}\b/g) || []).forEach((x) => { if (map.has(x) && !['A', 'I', 'IT', 'ON', 'ALL', 'ARE', 'NOW', 'BIG', 'KEY', 'SO', 'O'].includes(x)) add(x); });
  // nicknames that aren't in the official names
  const ALIAS = { google: 'GOOGL', youtube: 'GOOGL', facebook: 'META', instagram: 'META', whatsapp: 'META', chase: 'JPM', coke: 'KO', 'coca cola': 'KO', 'coca-cola': 'KO', pepsi: 'PEP', 'j&j': 'JNJ', 'johnson and johnson': 'JNJ', 'p&g': 'PG', 'procter': 'PG', 'berkshire': 'BRK.B', 'big blue': 'IBM', 'mickey': 'DIS', disney: 'DIS', 'wells fargo': 'WFC', 'goldman': 'GS', 'morgan stanley': 'MS', 'bofa': 'BAC', 'bank of america': 'BAC', 'exxon': 'XOM', 'chevron': 'CVX', 'lilly': 'LLY', 'eli lilly': 'LLY', 'nvidia': 'NVDA', 'microsoft': 'MSFT', 'amazon': 'AMZN', 'tesla': 'TSLA', 'netflix': 'NFLX', 'the s&p': 'SPY', 's&p 500': 'SPY' };
  const qlow = ' ' + q.toLowerCase().replace(/[^a-z0-9&\- ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  Object.entries(ALIAS).forEach(([k, t]) => { if (qlow.includes(' ' + k + ' ')) add(t); });
  // company names ("apple", "home depot", "starbucks")
  const ql = ' ' + normName(q) + ' ';
  const hits = list.filter((e) => e.nn && (ql.includes(' ' + e.nn + ' ') || (e.first.length >= 4 && !NAME_STOP.has(e.first) && ql.includes(' ' + e.first + ' '))));
  hits.sort((a, b) => (b.held ? 4 : 0) + (b.hist ? 2 : 0) + b.nn.length / 100 - ((a.held ? 4 : 0) + (a.hist ? 2 : 0) + a.nn.length / 100)).forEach((e) => add(e.t));
  // last resort: ask Yahoo's search about the leftover words
  if (!found.length && S.api) {
    const words = normName(q).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)).slice(0, 2);
    for (const w of words) {
      try {
        const r = await getJSON(`/api/profile?q=${encodeURIComponent(w)}`, {}, 6000);
        const top = (r.results || []).find((x) => normName(x.name).includes(w) || x.symbol.toLowerCase() === w);
        if (top) add(top.symbol.toUpperCase());
      } catch { /* ignore */ }
    }
  }
  return found;
}
async function scrappyStockFacts(t) {
  let m = S.market[t], prof = null;
  if (S.api) {
    const [mr, pr] = await Promise.allSettled([
      m ? null : getJSON(`/api/market?symbols=${encodeURIComponent(t)}&range=1y`, {}, 15000),
      getJSON(`/api/profile?symbol=${encodeURIComponent(t)}`, {}, 12000),
    ]);
    if (mr.status === 'fulfilled' && mr.value) mr.value.data.forEach((d) => { if (d && !d.error && d.closes?.length) S.market[d.symbol.toUpperCase()] = d; });
    if (pr.status === 'fulfilled') prof = pr.value;
    m = S.market[t];
    if (m && S.market.SPY && !S.stats[t]) S.stats[t] = symbolStats(m, S.market.SPY, rf());
  }
  const held = S.base.holdings.find((h) => h.ticker === t);
  const row = calc.rows.find((r) => r.ticker === t);
  const st = S.stats[t], p = prof || {};
  const spx = (S.base.spxConstituents || []).find((x) => x.ticker === t);
  const g = gicsFor(held, prof, held?.sector || (p.sector ? toGics(p.sector) : spx?.sector), spx?.sector, t);
  const L = [`## ${t} — ${p.name || held?.name || spx?.name || m?.name || t}`];
  L.push(`GICS: ${g.sector || '?'} / ${g.industry || p.industry || '?'}${g.source === 'mapped' ? ' (mapped from Yahoo)' : ''}. ${spx ? `In S&P 500 at ${fmt.pct(spx.weight, 2)} weight.` : 'Not in the S&P 500 list.'}`);
  const price = m?.price ?? held?.price;
  if (price != null) L.push(`Price ${fmt.usdC(price)}${m ? ' (live, delayed)' : ' (workbook)'}.`);
  if (row) L.push(`WE HOLD IT: ${fmt.n(row.quantity, 2)} sh, value ${fmt.usd(row.value)}, ${fmt.pct(row.weight, 2)} of fund, avg cost ${fmt.usdC(row.avgCost)}, gain ${fmt.spct(row.ret)}, first bought ${row.purchaseDate || '?'}.`);
  const hh = S.hist?.tickers?.[t];
  if (hh) {
    const tr = hh.trades.filter((x) => x.type === 'Buy' || x.type === 'Sell');
    L.push(`Trade history: owned ${hh.periods.map((x) => `${x.from} to ${x.to || 'now'}`).join('; ')}. ${tr.length} buys/sells. Bought $${Math.round(hh.bought)}, sold $${Math.round(hh.sold)}, realized gain $${Math.round(hh.realized)}, dividends $${Math.round(hh.dividends)}.`);
    L.push('Trades: ' + tr.slice(-12).map((x) => `${x.date} ${x.type} ${fmt.n(x.shares, 2)} @ ${fmt.usdC(x.price)}`).join('; '));
  } else if (S.hist) L.push('Trade history: NEVER OWNED in the Schwab record.');
  if (st) L.push(`1Y stats vs S&P: beta ${fmt.x(st.beta)}, volatility ${fmt.pct(st.vol)}, Sharpe ${fmt.x(st.sharpe)}, max drawdown ${fmt.pct(st.maxDD)}, alpha ${fmt.spct(st.alpha)}, correlation ${fmt.x(st.corr)}, 1Y return ${fmt.spct(st.periods?.['1Y'])}, YTD ${fmt.spct(st.periods?.YTD)}, 52w range ${fmt.usdC(st.low52)}–${fmt.usdC(st.high52)}.`);
  if (S.pstats && st) { const c = corrToPortfolio(t); if (c != null) L.push(`Correlation to SMIF portfolio (1Y daily): ${fmt.x(c)}.`); }
  const f = [];
  const put = (k, v) => { if (v != null && v !== '—') f.push(`${k} ${v}`); };
  put('Mkt cap', p.marketCap ? fmt.big(p.marketCap) : null); put('P/E', p.trailingPE != null ? fmt.x(p.trailingPE, 1) : null); put('Fwd P/E', p.forwardPE != null ? fmt.x(p.forwardPE, 1) : null);
  put('PEG', p.pegRatio != null ? fmt.x(p.pegRatio) : null); put('EV/EBITDA', p.evToEbitda != null ? fmt.x(p.evToEbitda, 1) : null); put('P/B', p.priceToBook != null ? fmt.x(p.priceToBook) : null);
  put('Div yield', p.dividendYield != null ? fmt.pct(p.dividendYield, 2) : null); put('Payout', p.payoutRatio != null ? fmt.pct(p.payoutRatio, 0) : null); put('ROE', p.roe != null ? fmt.pct(p.roe) : null);
  put('Net margin', p.profitMargin != null ? fmt.pct(p.profitMargin) : null); put('Op margin', p.operatingMargin != null ? fmt.pct(p.operatingMargin) : null);
  put('Rev growth YoY', p.revenueGrowth != null ? fmt.spct(p.revenueGrowth) : null); put('Debt/Equity', p.debtToEquity != null ? (p.debtToEquity / 100).toFixed(2) + 'x' : null);
  put('Analyst target', p.targetMeanPrice != null ? `${fmt.usdC(p.targetMeanPrice)} (${p.analystCount || 0} analysts${price ? `, ${fmt.spct(p.targetMeanPrice / price - 1)} vs price` : ''})` : null);
  put('Yahoo beta (5y)', p.beta != null ? fmt.x(p.beta) : null);
  if (f.length) L.push('Fundamentals (Yahoo): ' + f.join(', ') + '.');
  if (p.summary) L.push('Business: ' + String(p.summary).slice(0, 500));
  if (g.sector) {
    const sw = sectorWeightsIf(g.sector, 0);
    const peers = calc.rows.filter((r) => r.sector === g.sector && r.assetClass === 'Equity').map((r) => `${r.ticker} ${fmt.pct(r.weight, 1)}`).join(', ') || 'none';
    L.push(`Fit (already worked out — repeat these words, don't recompute): ${g.sector} is ${relWords(sw.now, sw.bench)}. Our holdings in ${g.sector}: ${peers}.`);
    if (price) {
      const amt = 0.02 * calc.total, sh = Math.floor(amt / price), cost = sh * price;
      const after = sectorWeightsIf(g.sector, cost);
      const curW = row ? row.weight : 0, newW = (curW * calc.total + cost) / calc.total;
      L.push(`What-if: buying ${sh} more shares (≈${fmt.usd(cost)}, a 2% starter position) would take ${t} to ${fmt.pct(newW, 1)} of the fund and ${g.sector} to ${fmt.pct(after.now)} of equities, ${relWords(after.now, after.bench)}. Cash is ${fmt.usd(calc.cash)}, so ${cost > calc.cash ? `about ${fmt.usd(cost - calc.cash)} would have to come from a sell` : 'cash covers it'}.`);
    }
  }
  return L.join('\n');
}
// "37.4% vs 39.2%" → plain words, so the AI never has to compare numbers itself
function relWords(ours, bench) {
  if (bench == null) return `${fmt.pct(ours)} of our equities (no S&P weight available)`;
  const d = ours - bench, pts = Math.abs(d * 100).toFixed(1);
  const band = Math.abs(d) <= 0.02 ? 'inside the IPS ±2 pt trade limit' : Math.abs(d) <= 0.03 ? 'past the ±2 pt trade limit but inside the ±3 pt rebalance trigger' : 'OUTSIDE the ±3 pt IPS rebalance trigger (rebalance needed)';
  if (Math.abs(d) < 0.005) return `in line with the S&P 500 (ours ${fmt.pct(ours)} vs S&P ${fmt.pct(bench)}), ${band}`;
  return `${d < 0 ? 'UNDERWEIGHT' : 'OVERWEIGHT'} by ${pts} pts vs the S&P 500 (ours ${fmt.pct(ours)} is ${d < 0 ? 'BELOW' : 'ABOVE'} the S&P's ${fmt.pct(bench)}), ${band}`;
}
function sectorWeightsIf(sector, addValue) {
  const eq = calc.rows.filter((r) => r.assetClass === 'Equity');
  const eqV = eq.reduce((a, r) => a + r.value, 0) + addValue;
  const secV = eq.filter((r) => r.sector === sector).reduce((a, r) => a + r.value, 0) + addValue;
  return { now: eqV ? secV / eqV : 0, bench: S.base.benchmark.sectorWeights[sector] };
}
async function scrappyContext(q) {
  const c = calc, bw = S.base.benchmark.sectorWeights;
  const L = [];
  L.push(`# SMIF fund snapshot (holdings as of ${S.base.meta?.asOf || '?'}; prices ${S.live ? 'live, delayed' : 'from the workbook'})`);
  L.push(`Total value ${fmt.usd(c.total)}. Cash ${fmt.usd(c.cash)} (${fmt.pct(c.cash / c.total, 2)}) — buys are paid from this cash only. Equities ${fmt.usd(c.eqValue)} (${fmt.pct(c.eqValue / c.total)}), fixed income ${fmt.usd(c.fiValue)}, money market ${fmt.usd(c.mmValue)}. ${c.rows.length} positions. IPS limits: 1% minimum first purchase; stocks under 2% of the S&P 500 max 3% first purchase and 5% total; trades may not push a sector past ±2 pts, rebalance beyond ±3 pts; portfolio beta 0.9–1.1.`);
  if (S.pstats) {
    const betas = Object.fromEntries(Object.entries(S.stats).map(([k, v]) => [k, v?.beta]));
    L.push(`Portfolio risk (1Y daily, current holdings): beta ${fmt.x(weightedBeta(c, betas))}, volatility ${fmt.pct(S.pstats.vol)}, Sharpe ${fmt.x(S.pstats.sharpe)}, max drawdown ${fmt.pct(S.pstats.maxDD)}, 1Y return at current weights ${fmt.spct(S.pstats.totalRet)}; S&P 500 1Y ${fmt.spct(S.pstats.benchStats?.totalRet)}, S&P vol ${fmt.pct(S.pstats.benchStats?.vol)}.`);
  }
  if (S.perfBt?.bt) { const b = S.perfBt.bt, w = perfWindowStats(b, 0, b.dates.length - 1); L.push(`Actual fund performance shown on the overview chart (${b.dates[0]} to ${b.dates[b.dates.length - 1]}, time-weighted, from Schwab transactions): SMIF ${fmt.spct(w.sm)} vs S&P 500 ${fmt.spct(w.sp)}${w.smA != null ? `, annualized ${fmt.spct(w.smA)} vs ${fmt.spct(w.spA)}` : ''}.`); }
  if (RV.loaded && RV.ss) {
    const yr = (w) => calendarYears(w).slice(-6).map((y) => `${y.year}${y.partial ? '*' : ''}: ${fmt.spct(y.fund)} vs ${fmt.spct(y.bench)}`).join('; ');
    L.push(`Calendar-year returns (* = partial year), from the Performance tab — total fund vs SPY: ${yr(RV.total || [])}. Stocks vs SPY: ${yr(viewWeeks(RV.ss, 'eq'))}. Fixed income vs AGG (first bond ETFs bought ${RV.ss.fiStart || 'n/a'}): ${yr(viewWeeks(RV.ss, 'fi')) || 'no history'}.`);
  }
  L.push('\n# Holdings (ticker | name | GICS sector / industry | shares | price | value | % of fund | avg cost | gain since purchase | first bought | 1Y beta)');
  [...c.rows].sort((a, b) => b.value - a.value).forEach((r) => L.push(`${r.ticker} | ${r.name} | ${r.assetClass === 'Equity' ? `${r.sector} / ${fullIndustry(r.industry)}` : r.assetClass} | ${fmt.n(r.quantity, 2)} | ${fmt.usdC(r.price)} | ${fmt.usd(r.value)} | ${fmt.pct(r.weight, 2)} | ${fmt.usdC(r.avgCost)} | ${fmt.spct(r.ret)} | ${r.purchaseDate || '?'} | ${S.stats[r.ticker]?.beta != null ? fmt.x(S.stats[r.ticker].beta) : '?'}`));
  L.push('\n# Sector weights in our stocks vs the S&P 500 (already compared for you — use these words)');
  Object.keys(bw).sort((a, b) => ((c.sectors[a]?.wEq || 0) - bw[a]) - ((c.sectors[b]?.wEq || 0) - bw[b])).forEach((s) => L.push(`${s}: ${relWords(c.sectors[s]?.wEq || 0, bw[s])}`));
  if (S.hist) {
    const former = Object.values(S.hist.tickers).filter((t) => t.ticker !== 'SNOXX' && !t.periods.some((p) => !p.to));
    L.push(`\n# Former holdings (sold out) — ticker name: periods owned; realized gain`);
    former.sort((a, b) => (b.periods.at(-1)?.to || '').localeCompare(a.periods.at(-1)?.to || '')).forEach((t) => L.push(`${t.ticker} ${t.name || ''}: ${t.periods.map((p) => `${p.from.slice(0, 7)}→${p.to.slice(0, 7)}`).join(', ')}; realized $${Math.round(t.realized)}`));
    const recent = Object.values(S.hist.tickers).flatMap((t) => t.trades.filter((x) => x.type === 'Buy' || x.type === 'Sell').map((x) => ({ ...x, t: t.ticker }))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15);
    L.push('\n# 15 most recent trades');
    recent.forEach((x) => L.push(`${x.date} ${x.type} ${fmt.n(x.shares, 2)} ${x.t} @ ${fmt.usdC(x.price)}`));
    L.push(`Schwab record covers ${S.hist.from || '?'} to ${S.hist.to || '?'}.`);
  }
  const ents = await scrappyEntities(q);
  if (ents.length) {
    L.push('\n# Details for tickers in this question');
    for (const t of ents) L.push(await scrappyStockFacts(t));
  }
  return { text: L.join('\n'), ents };
}
function scrappyMd(t) {
  // tiny, safe markdown: escape first, then **bold**, bullets, line breaks
  const lines = esc(t).split('\n');
  let html = '', inList = false;
  for (let ln of lines) {
    ln = ln.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S.+?)\*(?=\s|$)/g, '$1<i>$2</i>').replace(/^#{1,4}\s*(.+)$/, '<b>$1</b>');
    const li = ln.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    // a line that is just a formula ("P/E = price ÷ EPS") gets a neat formula box
    const formula = /^[^.!?]{3,90}=[^.!?]{1,90}$/.test(ln.trim()) && /[÷×=]/.test(ln) && !/^<b>/.test(ln.trim());
    html += ln.trim() ? (formula ? `<p class="sc-formula">${ln.trim()}</p>` : `<p>${ln}</p>`) : '';
  }
  return html + (inList ? '</ul>' : '');
}
function scrappyRender() {
  const box = $('#scBody');
  if (!box) return;
  if (!SC.msgs.length) {
    box.innerHTML = `<div class="sc-hello"><img src="img/owl.svg" alt="" /><b>Hi, I'm Scrappy.</b><span>Ask me about SMIF's holdings, history, risk, or whether a stock fits the fund.</span>
      <div class="sc-chips">${['Have we ever owned Apple?', 'Is Starbucks a good buy for us right now?', 'Which sectors are we most underweight vs the S&P?', 'What are our riskiest positions?', 'What did we sell most recently?'].map((x) => `<button class="sc-chip">${x}</button>`).join('')}</div></div>`;
    $$('.sc-chip', box).forEach((b) => b.addEventListener('click', () => scrappyAsk(b.textContent)));
    return;
  }
  box.innerHTML = SC.msgs.map((m, i) => m.role === 'user' ? `<div class="sc-msg me">${esc(m.content)}</div>`
    : m.typing ? `<div class="sc-msg bot" data-typing="${i}"></div>`
    : `<div class="sc-msg bot${m.error ? ' err' : ''}">${m.error ? esc(m.content) : scrappyMd(m.content)}${m.meta ? `<div class="sc-meta">${esc(m.meta)}</div>` : ''}</div>`).join('')
    + (SC.busy ? `<div class="sc-msg bot sc-typing"><span></span><span></span><span></span><em>${esc(SC.busyText || 'Thinking…')}</em></div>` : '');
  box.scrollTop = box.scrollHeight;
  const tEl = $('[data-typing]', box);
  if (tEl) scrappyType(SC.msgs[+tEl.dataset.typing], tEl);
}
// type the answer out a few characters at a time (click the bubble to show it all at once)
function scrappyType(m, el) {
  const box = $('#scBody');
  const full = m.content, step = Math.max(2, Math.round(full.length / 220)); // ~3–4 s for a long answer
  let n = m.shown || 0, done = false;
  const finish = () => {
    if (done) return; done = true;
    m.typing = false; m.shown = 0;
    el.removeAttribute('data-typing');
    el.innerHTML = scrappyMd(full) + (m.meta ? `<div class="sc-meta">${esc(m.meta)}</div>` : '');
    store.set('scrappyChat', SC.msgs);
    if (box) box.scrollTop = box.scrollHeight;
  };
  el.onclick = finish;
  const stick = () => box && box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const tick = () => {
    if (done || !el.isConnected) return;
    n = Math.min(full.length, n + step); m.shown = n;
    const follow = stick();
    let part = full.slice(0, n);
    if ((part.match(/\*\*/g) || []).length % 2) part += '**'; // don't flash half-open bold markers
    el.innerHTML = scrappyMd(part) + '<span class="sc-caret"></span>';
    if (follow) box.scrollTop = box.scrollHeight;
    if (n >= full.length) finish(); else setTimeout(tick, 16);
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish(); else tick();
}
async function scrappyAsk(q) {
  q = String(q || '').trim();
  if (!q || SC.busy) return;
  if (!S.api) { SC.msgs.push({ role: 'user', content: q }, { role: 'assistant', content: 'Scrappy needs the live site (the server functions) to answer. Open the deployed dashboard to chat.', error: true }); scrappyRender(); return; }
  SC.msgs.forEach((m) => { m.typing = false; });
  const history = SC.msgs.filter((m) => !m.error).slice(-6).map(({ role, content }) => ({ role, content }));
  SC.msgs.push({ role: 'user', content: q });
  SC.busy = true; SC.busyText = 'Pulling fund data…';
  $('#scInput').value = ''; scrappyRender();
  try {
    const ctx = await scrappyContext(q);
    SC.busyText = ctx.ents.length ? `Analyzing ${ctx.ents.join(', ')}…` : 'Thinking…'; scrappyRender();
    const r = await getJSON('/api/scrappy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, history, context: ctx.text }) }, 60000);
    SC.msgs.push({ role: 'assistant', content: r.answer || '(no answer)', typing: true, meta: [r.model === 'guardrail' ? '' : r.model, ctx.ents.length && !r.blocked ? 'looked up ' + ctx.ents.join(', ') : ''].filter(Boolean).join(' · ') });
  } catch (e) {
    SC.msgs.push({ role: 'assistant', content: e.name === 'AbortError' ? 'That took too long — try again or ask a shorter question.' : String(e.message || e), error: true });
  }
  SC.busy = false;
  SC.msgs = SC.msgs.slice(-30);
  store.set('scrappyChat', SC.msgs);
  scrappyRender();
}
(function scrappyMount() {
  const fab = document.createElement('button');
  fab.id = 'scFab'; fab.className = 'sc-fab'; fab.title = 'Ask Scrappy AI';
  fab.innerHTML = '<img src="img/owl.svg" alt="" /><span>Ask Scrappy</span>';
  const panel = document.createElement('div');
  panel.id = 'scPanel'; panel.className = 'sc-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Scrappy AI');
  panel.innerHTML = `<div class="sc-head"><img src="img/owl.svg" alt="" /><div><b>Scrappy AI</b><small>SMIF portfolio assistant</small></div>
      <button class="btn sm" id="scClear" title="Start a new chat">New chat</button><button class="btn sm" id="scClose" title="Close">✕</button></div>
    <div class="sc-body" id="scBody"></div>
    <form class="sc-foot" id="scForm"><textarea id="scInput" rows="1" maxlength="800" placeholder="Ask about our holdings, history, or a stock…"></textarea><button class="btn primary" id="scSend" type="submit">Send</button></form>
    <div class="sc-note">Uses SMIF fund data + Yahoo Finance. AI can make mistakes — verify numbers before you present. Not investment advice.</div>`;
  document.body.append(fab, panel);
  const open = (v) => { SC.open = v; panel.classList.toggle('open', v); fab.classList.toggle('hide', v); document.body.classList.toggle('sc-lock', v && innerWidth < 640); if (v) { scrappyRender(); setTimeout(() => $('#scInput').focus(), 50); } };
  fab.addEventListener('click', () => open(true));
  $('#scClose').addEventListener('click', () => open(false));
  $('#scClear').addEventListener('click', () => { SC.msgs = []; store.set('scrappyChat', []); scrappyRender(); });
  $('#scForm').addEventListener('submit', (e) => { e.preventDefault(); scrappyAsk($('#scInput').value); });
  $('#scInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); scrappyAsk($('#scInput').value); } });
  $('#scInput').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && SC.open) open(false); });
})();

// ======================================================================
// Performance tab — year-by-year returns by group
// ======================================================================
const RV = { mode: ['total', 'eq', 'fi', 'cash'].includes(store.get('rvMode', 'total')) ? store.get('rvMode', 'total') : 'total', chart: store.get('rvChart', 'years'), mix: store.get('rvMix', 'actual'), diff: store.get('rvDiff', false), labels: store.get('rvLabels', false), from: null, to: null, all: {}, loading: null };
const AC_COLOR = () => ({ eq: C.gold, fi: C.blue, mm: C.violet, cash: C.gray });
// four asset classes, always named and coloured the same way across the site
function acSummary() {
  const c = calc;
  return [
    { k: 'eq', name: 'Equities', v: c.eqValue, what: `${c.nEquity} stocks`, note: 'Compared with the S&P 500' },
    { k: 'fi', name: 'Fixed income', v: c.fiValue, what: c.rows.filter((r) => r.assetClass === 'Fixed Income').map((r) => r.ticker).join(', ') || 'none', note: 'Bond ETFs · compared with the Bloomberg US Aggregate (AGG)' },
    { k: 'mm', name: 'Money market', v: c.mmValue, what: c.rows.filter((r) => r.assetClass === 'Money Market').map((r) => r.ticker).join(', ') || 'none', note: 'Treasury money-market fund · compared with T-bills (BIL)' },
    { k: 'cash', name: 'Cash', v: c.cash, what: 'Uninvested cash at Schwab', note: 'What Trade Lab buys are paid from' },
  ];
}
function acStripHTML() {
  const t = calc.total;
  return `<div class="ac-strip">${acSummary().map((a) => `<div class="ac-cell ${a.k}"><div class="ac-l"><i class="ac-dot ${a.k}"></i><span>${a.name}</span><em>${fmt.pct(a.v / t)}</em></div><b class="ac-usd">${fmt.usd(a.v)}</b><small>${fmt.pct(a.v / t)} of the fund</small></div>`).join('')}</div>`;
}
async function loadAllHistory() {
  if (RV.loaded || !S.api || !S.hist) return;
  if (RV.loading) return RV.loading;
  const syms = Object.values(S.hist.tickers).filter((t) => assetClassOf(t.ticker, t.name, currentClasses()) !== 'Money Market').map((t) => t.ticker);
  const need = [...new Set(['SPY', 'AGG', 'BIL', ...syms])];
  RV.loading = (async () => {
    let done = 0;
    const chunks = []; for (let i = 0; i < need.length; i += 6) chunks.push(need.slice(i, i + 6));
    // a few requests at a time so the progress line moves and Yahoo isn't flooded
    for (let i = 0; i < chunks.length; i += 4) {
      await Promise.allSettled(chunks.slice(i, i + 4).map((c) => getJSON(`/api/market?symbols=${encodeURIComponent(c.join(','))}&range=all&interval=1wk`, {}, 30000)
        .then((r) => r.data.forEach((d) => { if (d && !d.error && d.closes?.length) RV.all[d.symbol.toUpperCase()] = d; }))));
      done = Math.min(need.length, (i + 4) * 6);
      if (S.view === 'returns') $('#rvTiles').innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty"><b>Loading ${need.length} price histories since 2009…</b>${done} of ${need.length} done. This happens once per visit.</div></div>`;
    }
    await verifyAndRepair(syms);
    RV.loaded = true; RV.loading = null;
  })();
  return RV.loading;
}
function overviewTrailing() {
  const out = [];
  for (const label of ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', '10Y', 'Since start']) {
    const start = label === 'Since start' ? S.hist.from : rangeStart(label);
    if (label !== 'Since start' && start < S.hist.from) { out.push({ label, fund: null, bench: null }); continue; }
    const daily = ['1M', '3M', '6M', 'YTD', '1Y'].includes(label) && S.market.SPY?.dates?.[0] <= start;
    const bt = actualBacktest(S.hist, daily ? S.market : RV.all, start);
    if (!bt) { out.push({ label, fund: null, bench: null }); continue; }
    out.push({ label, from: bt.dates[0], fund: bt.smifRet, bench: bt.benchRet, diff: bt.smifRet - bt.benchRet, fundAnn: bt.smifAnn, benchAnn: bt.benchAnn, years: bt.years });
  }
  return out;
}
function currentClasses() { return Object.fromEntries(S.base.holdings.map((h) => [h.ticker, h.assetClass])); }
function rvData() {
  if (!RV.ss) RV.ss = sleeveSeries(S.hist, RV.all, currentClasses());
  if (!RV.total) {
    const bt = actualBacktest(S.hist, RV.all, S.hist.from);
    const byD = new Map(RV.ss.weeks.map((w) => [w.d0, w]));
    RV.total = bt ? bt.dates.slice(1).map((d, i) => {
      const w = byD.get(bt.dates[i]), ve = w?.eq?.v || 0, vf = w?.fi?.v || 0, vc = w?.cash?.v || 0, tot = ve + vf + vc;
      return { d0: bt.dates[i], d1: d, r: bt.smif[i + 1] / bt.smif[i] - 1, b: bt.bench[i + 1] / bt.bench[i] - 1, cov: 1,
        est: tot ? ((w?.eq?.est || 0) * ve + (w?.fi?.est || 0) * vf) / tot : 0, estT: [...(w?.eq?.estT || []), ...(w?.fi?.estT || [])] };
    }) : [];
    RV.totalMissing = bt?.missing || [];
  }
  const ss = RV.ss;
  let weeks, label, bench, color;
  if (RV.mode === 'eq') { weeks = viewWeeks(ss, 'eq'); label = 'Equities'; bench = 'S&P 500 (SPY)'; color = C.gold; }
  else if (RV.mode === 'fi') { weeks = viewWeeks(ss, 'fi'); label = 'Fixed income'; bench = 'Bloomberg US Agg (AGG)'; color = C.blue; }
  else if (RV.mode === 'cash') { weeks = viewWeeks(ss, 'cash'); label = 'Money market & cash'; bench = '1–3 month T-bills (BIL)'; color = C.violet; }
  else { weeks = RV.total; label = 'SMIF (actual mix)'; bench = 'S&P 500 (SPY)'; color = C.gold; }
  // "Actual mix" trailing periods are worked out exactly like the Overview chart (same function, same
  // start dates, same prices: daily for 1 year and shorter, the checked weekly store beyond), so the two always match.
  const trailing = RV.mode === 'total' ? overviewTrailing() : trailingPeriods(weeks);
  const years = calendarYears(weeks);
  // this year's bar = the Overview chart's YTD number exactly
  const ytd = RV.mode === 'total' && trailing.find((x) => x.label === 'YTD' && x.fund != null);
  const cy = years.find((y) => y.year === new Date().getFullYear());
  if (ytd && cy) Object.assign(cy, { fund: ytd.fund, bench: ytd.bench, diff: ytd.fund - ytd.bench });
  return { weeks, label, bench, color, years, trailing };
}
async function renderReturns() {
  $('#rvSplit').innerHTML = acSplitHTML();
  syncRvControls();
  if (!S.api || !S.hist) {
    $('#rvTiles').innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty"><b>Needs live data and the Schwab history.</b>Open the deployed site to see year-by-year performance.</div></div>`;
    emptyChart('chYears', 'Year-by-year returns appear once live data is connected.');
    $('#tblYears').innerHTML = '';
    return;
  }
  if (!RV.loaded) {
    emptyChart('chYears', 'Loading price history…');
    await loadAllHistory();
    if (S.view !== 'returns') return;
    if (!RV.all.SPY) { emptyChart('chYears', 'Couldn\'t load long price history from Yahoo. Try Refresh in a minute.'); return; }
  }
  if (S.hist && S.market.SPY) await loadFormerHoldings(rangeStart('1Y') < `${new Date().getFullYear() - 1}-12-31` ? rangeStart('1Y') : `${new Date().getFullYear() - 1}-12-31`, false);
  if (S.view !== 'returns') return;
  drawReturns();
}
function syncRvControls() {
  $$('#rvMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === RV.mode));
  $$('#rvChart button').forEach((b) => b.classList.toggle('on', b.dataset.v === RV.chart));
  $('#rvYearsWrap').style.display = RV.chart === 'years' ? '' : 'none';
  $('#rvDiff').checked = RV.diff; $('#rvLabels').checked = RV.labels;
}
function drawReturns() {
  const D = rvData();
  const yrsAll = D.years;
  const yearsList = yrsAll.map((y) => y.year);
  // year range pickers
  const fromSel = $('#rvFrom'), toSel = $('#rvTo');
  const opts = yearsList.map((y) => `<option value="${y}">${y}</option>`).join('');
  if (fromSel.dataset.opts !== opts) { fromSel.innerHTML = opts; toSel.innerHTML = opts; fromSel.dataset.opts = opts; }
  let from = RV.from && yearsList.includes(RV.from) ? RV.from : yearsList[0], to = RV.to && yearsList.includes(RV.to) ? RV.to : yearsList[yearsList.length - 1];
  if (from > to) [from, to] = [to, from];
  fromSel.value = from; toSel.value = to;
  const years = yrsAll.filter((y) => y.year >= from && y.year <= to);
  const trail = D.trailing;
  const isYears = RV.chart === 'years';
  // benchmark line
  const notes = [];
  const t = calc.total;
  if (RV.mode === 'total') notes.push(`Everything the fund owns, at the weights we actually held: today ${fmt.pct(calc.eqValue / t, 0)} equities, ${fmt.pct(calc.fiValue / t, 0)} fixed income, ${fmt.pct(calc.cashLike / t, 0)} money market &amp; cash. Compared with the S&amp;P 500, the fund's benchmark.`);
  if (RV.mode === 'eq') notes.push('Only the stocks we held. Bonds, money market and cash are left out.');
  if (RV.mode === 'fi') notes.push(RV.ss.fiStart ? `Only our bond ETFs. SMIF first bought them on <b>${fdate(RV.ss.fiStart)}</b>; returns start with the first full week after that.` : 'The fund has no bond history yet.');
  if (RV.mode === 'cash') notes.push('Uninvested cash plus the Treasury money-market fund. Its return is the interest and money-market dividends we received.');
  $('#rvBench').innerHTML = `<span><i class="ac-dot" style="background:${D.color}"></i><b>${esc(D.label)}</b> vs <i class="ac-dot" style="background:${C.grayLight}"></i><b>${esc(D.bench)}</b></span>${notes.map((n) => `<span class="rv-note">${n}</span>`).join('')}`;
  // tiles
  const full = years.filter((y) => !y.partial);
  const beat = full.filter((y) => y.diff > 0).length;
  const best = years.reduce((a, y) => (!a || y.fund > a.fund ? y : a), null), worst = years.reduce((a, y) => (!a || y.fund < a.fund ? y : a), null);
  let f = 1, b = 1; years.forEach((y) => { f *= 1 + y.fund; b *= 1 + y.bench; });
  const span = years.length ? (new Date(years[years.length - 1].to) - new Date(years[0].from)) / (365.25 * 864e5) : 0;
  const ann = (g) => (span >= 1 ? Math.pow(g, 1 / span) - 1 : null);
  const tile = (k, v, s, t) => `<div class="card tile"><div class="label">${k} ${t ? tip(t) : ''}</div><div class="value num">${v}</div><div class="foot">${s}</div></div>`;
  $('#rvTiles').innerHTML = years.length ? [
    tile(`Total, ${years[0].year}–${years[years.length - 1].year}`, `<span class="${cls(f - 1)}">${fmt.spct(f - 1)}</span>`, `Benchmark ${fmt.spct(b - 1)} · difference ${fmt.spct(f - b)}`, 'Growth over the years shown, chained week by week.'),
    tile('Per year (annualized)', ann(f) != null ? `<span class="${cls(ann(f))}">${fmt.spct(ann(f))}</span>` : '—', ann(b) != null ? `Benchmark ${fmt.spct(ann(b))}` : 'Needs at least a year', 'The steady yearly rate that gives the same total.'),
    tile('Full years ahead of benchmark', full.length ? `${beat} of ${full.length}` : '—', full.length ? `${fmt.pct(beat / full.length, 0)} hit rate` : 'Only partial years so far', 'Partial first/last years are left out of this count.'),
    tile('Best / worst year', best ? `<span class="up">${fmt.spct(best.fund, 1)}</span> / <span class="${cls(worst.fund)}">${fmt.spct(worst.fund, 1)}</span>` : '—', best ? `${best.year} / ${worst.year}` : '', 'Calendar-year returns, partial years included.'),
  ].join('') : `<div class="card" style="grid-column:1/-1"><div class="empty"><b>No history for this view yet.</b>${RV.mode === 'fi' ? 'The fund hasn\'t held bond ETFs in the record.' : ''}</div></div>`;
  // chart
  const modeName = { total: 'total portfolio', eq: 'equities', fi: 'fixed income', cash: 'money market & cash' }[RV.mode];
  $('#rvTitle').textContent = `${isYears ? 'Calendar years' : 'Trailing periods'} — ${modeName}`;
  $('#rvHint').textContent = isYears ? (years.some((y) => y.partial) ? 'faded bars are partial years' : '') : 'total return over each period · same numbers as the Overview chart';
  const cats = isYears ? years.map((y) => String(y.year)) : trail.filter((t) => t.fund != null).map((t) => t.label);
  const rows = isYears ? years : trail.filter((t) => t.fund != null);
  const val = (r, k) => r[k]; // totals for every period, the same numbers the Overview chart shows
  const fade = (hex, a) => { const m = hex.match(/\w\w/g); return m && hex.startsWith('#') ? `rgba(${m.map((x) => parseInt(x, 16)).join(',')},${a})` : hex; };
  const bar = (k, col) => rows.map((r) => {
    const v = val(r, k);
    return { value: v == null ? null : +(v * 100).toFixed(2), itemStyle: { color: isYears && r.partial ? fade(col, 0.45) : col, borderRadius: v >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3], decal: isYears && r.proxyShare > 0.5 && k === 'fund' ? { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -0.8, color: 'rgba(255,255,255,0.25)' } : undefined } };
  });
  const lbl = { show: RV.labels, position: 'top', color: C.ink2, fontSize: 10, formatter: (p) => (p.value == null ? '' : `${p.value > 0 ? '+' : ''}${p.value.toFixed(1)}`) };
  const series = [
    { name: D.label, type: 'bar', data: bar('fund', D.color), itemStyle: { color: D.color }, barGap: '8%', barCategoryGap: '28%', label: lbl },
    { name: D.bench, type: 'bar', data: bar('bench', C.grayLight), itemStyle: { color: C.grayLight }, label: lbl },
  ];
  if (RV.diff) series.push({ name: 'Difference', type: 'bar', data: rows.map((r) => { const v = val(r, 'diff') ?? (val(r, 'fund') - val(r, 'bench')); return { value: +(v * 100).toFixed(2), itemStyle: { color: v >= 0 ? C.up : C.down, borderRadius: 2 } }; }), itemStyle: { color: C.up }, barWidth: isMobile() ? 4 : 8, label: { ...lbl, color: C.muted } });
  setChart('chYears', {
    grid: { left: 8, right: 12, top: isMobile() ? 70 : 44, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, textStyle: { color: C.ink2 }, itemWidth: 14, itemHeight: 10, icon: 'rect', backgroundColor: C.wash, padding: [6, 10], borderRadius: 6 },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: C.wash } }, formatter: (p) => {
      const r = rows[p[0].dataIndex];
      const f = val(r, 'fund'), bb = val(r, 'bench');
      let h = `<b>${isYears ? r.year : r.label}</b>${isYears && r.partial ? ` <span style="color:${C.muted}">(${fdate(r.from)} – ${fdate(r.to)})</span>` : !isYears ? ` <span style="color:${C.muted}">since ${fdate(r.from)}</span>` : ''}<br>`;
      h += `<span style="color:${D.color}">●</span> ${esc(D.label)}: <b>${fmt.spct(f)}</b><br><span style="color:${C.grayLight}">●</span> ${esc(D.bench)}: <b>${fmt.spct(bb)}</b><br>`;
      h += f - bb >= 0 ? `<span style="color:${C.up}">Ahead of the benchmark by ${fmt.pct(f - bb, 1)}</span>` : `<span style="color:${C.down}">Behind the benchmark by ${fmt.pct(bb - f, 1)}</span>`;
      if (isYears && r.proxyShare > 0) h += `<br><span style="color:${C.muted}">◇ bond part uses AGG for ${Math.round(r.proxyShare * 100)}% of the year</span>`;
      return h;
    } },
    xAxis: { type: 'category', data: cats, ...axisCommon, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, color: C.ink2, fontSize: isMobile() ? 10 : 12, interval: 0, rotate: isMobile() && cats.length > 9 ? 45 : 0 } },
    yAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => `${v}%` } },
    series,
  });
  // table
  const head = isYears ? ['Year', D.label, D.bench, 'Difference', 'Notes'] : ['Period', D.label, D.bench, 'Difference', 'Notes'];
  const body = rows.map((r) => {
    const f = val(r, 'fund'), bb = val(r, 'bench'), d = f - bb;
    const n = isYears ? (r.partial ? `${fdate(r.from)} – ${fdate(r.to)}` : '')
      : `since ${fdate(r.from)}${r.years >= 1 && r.fundAnn != null ? ` · per year ${fmt.spct(r.fundAnn)} vs ${fmt.spct(r.benchAnn)}` : ''}`;
    return `<tr><td><b>${isYears ? r.year : r.label}</b></td><td class="n ${cls(f)}">${fmt.spct(f)}</td><td class="n ${cls(bb)}">${fmt.spct(bb)}</td><td class="n ${cls(d)}">${fmt.spct(d)}</td><td style="color:var(--muted);font-size:12px">${n}</td></tr>`;
  }).join('');
  $('#tblYears').innerHTML = `<thead><tr>${head.map((h, i) => `<th class="${i && i < 4 ? 'n' : ''}" style="cursor:default">${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
  $('#rvTableHint').innerHTML = 'Time-weighted, dividends and interest included';
  RV.last = { D, rows, isYears, val };
}
function acSplitHTML() {
  if (!calc) return '';
  const t = calc.total, A = acSummary();
  const incl = { eq: ['Actual mix', 'All equities'], fi: ['Actual mix', 'All fixed income'], mm: ['Actual mix', 'Money market & cash'], cash: ['Actual mix', 'Money market & cash'] };
  return A.map((a) => `<div class="ac-card ${a.k}"><div class="ac-top"><i class="ac-dot ${a.k}"></i><b>${a.name}</b><span class="num">${fmt.pct(a.v / t)}</span></div>
    <div class="ac-v num">${fmt.usd(a.v)}</div><div class="ac-what">${esc(a.what)}</div><div class="ac-note">${esc(a.note)}</div>
    <div class="ac-in">In: ${incl[a.k].map((x) => `<span class="tag">${x}</span>`).join(' ')}</div></div>`).join('');
}
seg('rvMode', 'rvModeTmp', () => { RV.mode = S.rvModeTmp; store.set('rvMode', RV.mode); syncRvControls(); if (RV.loaded) drawReturns(); });
seg('rvChart', 'rvChartTmp', () => { RV.chart = S.rvChartTmp; store.set('rvChart', RV.chart); syncRvControls(); if (RV.loaded) drawReturns(); });
$('#rvFrom').addEventListener('change', (e) => { RV.from = +e.target.value; drawReturns(); });
$('#rvTo').addEventListener('change', (e) => { RV.to = +e.target.value; drawReturns(); });
$('#rvDiff').addEventListener('change', (e) => { RV.diff = e.target.checked; store.set('rvDiff', RV.diff); if (RV.loaded) drawReturns(); });
$('#rvLabels').addEventListener('change', (e) => { RV.labels = e.target.checked; store.set('rvLabels', RV.labels); if (RV.loaded) drawReturns(); });
$('#rvPng').addEventListener('click', () => {
  const c = charts.chYears; if (!c) return;
  const a = document.createElement('a');
  a.href = c.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: getComputedStyle(document.body).backgroundColor });
  a.download = `SMIF ${$('#rvTitle').textContent.replace(/\s*—\s*/g, ' - ').replace(/[^\w %/+-]+/g, '').replace(/\//g, '-').trim()}.png`; a.click();
});
$('#rvCsv').addEventListener('click', () => {
  if (!RV.last) return;
  const { D, rows, isYears, val } = RV.last;
  const lines = [[isYears ? 'Year' : 'Period', D.label, D.bench, 'Difference', 'Partial', 'From', 'To'].join(',')];
  rows.forEach((r) => lines.push([isYears ? r.year : r.label, (val(r, 'fund') * 100).toFixed(2) + '%', (val(r, 'bench') * 100).toFixed(2) + '%', ((val(r, 'fund') - val(r, 'bench')) * 100).toFixed(2) + '%', isYears && r.partial ? 'yes' : '', r.from || '', r.to || ''].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `SMIF ${$('#rvTitle').textContent.replace(/\s*—\s*/g, ' - ').replace(/[^\w %/+-]+/g, '').replace(/\//g, '-').trim()}.csv`; a.click();
});

function acTag(ac) {
  const k = { Equity: 'eq', 'Fixed Income': 'fi', 'Money Market': 'mm', Cash: 'cash' }[ac] || 'cash';
  const n = { Equity: 'Equity', 'Fixed Income': 'Fixed income', 'Money Market': 'Money market' }[ac] || ac;
  return `<span class="ac-tag ${k}"><i class="ac-dot ${k}"></i>${esc(n)}</span>`;
}
function fillAcStrips() {
  if (!calc) return;
  const h = acStripHTML();
  $$('.ac-strip-slot').forEach((el) => { if (el.closest('.view.active')) el.innerHTML = h; });
}

// Every price history is checked against the fund's own Schwab trade prices. A history that doesn't match
// (wrong company reusing an old ticker, bad data) or is missing gets a second source (Tiingo, via /api/prices);
// if that also fails, the stock's path is estimated from our trade prices.
async function verifyAndRepair(syms) {
  const Q = (RV.quality = {});
  const bad = [];
  for (const t of syms) {
    const h = S.hist.tickers[t]; if (!h) continue;
    const v = verifyPrices(h, RV.all[t]);
    Q[t] = { source: RV.all[t] ? 'Yahoo Finance' : null, ...v };
    if (!v.ok) { bad.push(t); if (RV.all[t]) { Q[t].rejected = 'Yahoo Finance'; delete RV.all[t]; } }
  }
  RV.secondSource = null;
  for (let i = 0; i < bad.length; i += 10) {
    try {
      const r = await getJSON(`/api/prices?symbols=${encodeURIComponent(bad.slice(i, i + 10).join(','))}`, {}, 30000);
      RV.secondSource = r.secondSource;
      r.data.forEach((d) => {
        const t = d.symbol?.toUpperCase(); if (!t || !Q[t]) return;
        if (d.error || !d.dates?.length) { Q[t].tried = d.error; return; }
        const v = verifyPrices(S.hist.tickers[t], d);
        if (v.ok) { RV.all[t] = d; Q[t] = { ...Q[t], ...v, source: d.source || 'Second source', ok: true }; }
        else Q[t].tried = `${d.source || 'Second source'} didn't match our trade prices either (median gap ${fmt.pct(v.medianErr, 0)})`;
      });
    } catch (e) { bad.slice(i, i + 10).forEach((t) => { if (Q[t]) Q[t].tried = String(e.message || e); }); }
  }
  bad.forEach((t) => { if (!RV.all[t]) Q[t].source = 'Estimated from our trade prices'; });
}

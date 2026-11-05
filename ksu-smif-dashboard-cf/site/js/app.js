// KSU SMIF Dashboard — app shell, data loading, views.
import {
  computePortfolio, symbolStats, portfolioStats, windowBacktest, windowAsHeld, actualBacktest, applyTrades, periodReturns, weightedBeta,
  fmt, cls, toGics, SECTORS, CASH_LIKE,
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
  settings: { name: '', ...store.get('settings', {}), maxPos: 10, band: 5 }, // trade guidelines: 10% max position, ±5 pts sector band
  view: 'overview',
  tmColor: 'ret', secBasis: 'equity', perfMode: 'ret', perfRange: store.get('perfRange', '1Y'), perfBasis: 'held', // actual results from the transaction history
  showTrades: store.get('showTrades', false),
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
const C = {
  gold: '#FFC629', goldDim: 'rgba(255,198,41,0.25)', gray: '#8e8c88', grayLight: '#b2b4b2',
  up: '#3ccf7f', down: '#f0625a', blue: '#3987e5', violet: '#9085e9', orange: '#d95926',
  ink: '#f2f0ea', ink2: '#c9c6bd', muted: '#8e8a82', grid: 'rgba(255,255,255,0.07)', axis: 'rgba(255,255,255,0.18)',
};
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
    if (!ax || Array.isArray(ax)) return ax;
    if (m && ax.name) ax.nameTextStyle = { ...ax.nameTextStyle, align: ax.nameLocation === 'middle' ? 'center' : 'left', fontSize: 10 };
    if (ax.type === 'category' && m) {
      const f0 = ax.axisLabel?.formatter;
      ax.axisLabel = { ...ax.axisLabel, fontSize: 10, width: 110, overflow: 'truncate', formatter: (v, i) => { const x = SHORT[v] || v; return typeof f0 === 'function' ? f0(x, i) : x; } };
    }
    return ax;
  };
  o.yAxis = fixAxis(o.yAxis); o.xAxis = fixAxis(o.xAxis);
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
    series: [{ type: 'pie', radius: ['55%', '82%'], center: ['32%', '50%'], padAngle: 2, itemStyle: { borderRadius: 6, borderColor: '#181614', borderWidth: 2 },
      label: { show: false }, data: mix }],
  });

  // KPI tiles
  const ps = S.pstats;
  const tiles = [
    ['Equity weight', fmt.pct(c.eqValue / c.total), `${c.nEquity} stocks · ${fmt.usd(c.eqValue)}`, 'Share of the fund invested in individual stocks.'],
    ['Cash & money market', fmt.pct(c.cashLike / c.total), `${fmt.usd(c.cashLike)} available to deploy`, 'Uninvested cash plus the Treasury money-market fund (SNOXX). This is what buys are paid from.'],
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
}
async function renderPerfChart() {
  // Without live prices there's nothing to compare over time: show the workbook's period returns instead
  if (!S.live || !S.market.SPY) return renderSnapshotPerf();
  const r = S.perfRange;
  $('#perfRange').style.display = '';
  $('#tradeToggleWrap').style.display = S.hist ? '' : 'none';
  $('#tradeToggle').checked = S.showTrades;
  $$('#perfRange button').forEach((b) => b.classList.toggle('on', b.dataset.v === r));
  const long = r === '3Y' || r === '5Y' || r === '10Y';
  if (long && !S.longLoaded) {
    $('#perfStats').innerHTML = '<span>Loading 10 years of weekly prices…</span>';
    await loadLongHistory();
    if (S.perfRange !== r || S.view !== 'overview') return;
    if (!S.longLoaded) { $('#perfStats').innerHTML = '<span class="down">Couldn\'t load long-term history. Make sure the latest market.mjs is deployed.</span>'; return; }
  }
  const asHeld = S.perfBasis === 'held';
  const start = rangeStart(r);
  if (asHeld && S.hist) {
    await loadFormerHoldings(start, long);
    if (S.perfRange !== r || S.view !== 'overview') return;
  }
  const mkt = long ? S.long : S.market;
  const bt = asHeld
    ? (S.hist ? actualBacktest(S.hist, mkt, start) : windowAsHeld(calc, mkt, start))
    : windowBacktest(calc, mkt, rf(), start, long ? 52 : 252);
  if (!bt) { emptyChart('chPerf', 'Not enough data for this period'); return; }
  const label = { '1M': 'past month', '3M': 'past 3 months', '6M': 'past 6 months', YTD: 'year to date', '1Y': 'past year', '3Y': 'past 3 years', '5Y': 'past 5 years', '10Y': 'past 10 years' }[r];
  $('#perfTitle').textContent = `SMIF vs S&P 500 — ${label}`;
  const diff = bt.smifRet - bt.benchRet;
  $('#perfStats').innerHTML = `
    <span>SMIF <b class="${cls(bt.smifRet)}">${fmt.spct(bt.smifRet)}</b></span>
    <span>S&amp;P 500 <b class="${cls(bt.benchRet)}">${fmt.spct(bt.benchRet)}</b></span>
    <span>Difference <b class="${cls(diff)}">${fmt.pts(diff)}</b></span>
    ${bt.smifAnn != null ? `<span>Annualized <b>${fmt.spct(bt.smifAnn)}</b> vs <b>${fmt.spct(bt.benchAnn)}</b></span>` : ''}`;
  let notes;
  if (bt.actual) {
    notes = [`Actual results, rebuilt from ${fmt.n(S.hist.transactions)} Schwab transactions: each day values exactly what the fund owned (including stocks since sold) plus cash and dividends. Money added or withdrawn is excluded, so this measures investment performance only.`];
    if (bt.missing.length) notes.push(`No market prices for ${bt.missing.join(', ')} — valued at their last trade price.`);
  } else if (asHeld) {
    notes = ['Estimate: each stock counts only from the date we first bought it. Upload the Schwab transaction history on the Master Copy page for exact results.'];
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
    marks = Object.entries(byDay).map(([d, v]) => ({
      xAxis: d, info: v,
      label: { show: false },
    }));
  }
  const short = r === '1M' || r === '3M';
  setChart('chPerf', {
    grid: { left: 44, right: 78, top: 20, bottom: 30 },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.gold, opacity: 0.5 } },
      formatter: (p) => {
        const d = p[0].axisValue;
        let h = `<b>${d}</b><br>` + p.map((x) => `${x.marker} ${x.seriesName}: ${fmt.spct(x.value / 100 - 1)}`).join('<br>');
        if (bt.actual) { const i = bt.dates.indexOf(d); if (i >= 0) h += `<br><span style="color:#8e8a82">Fund value: ${fmt.usd(bt.values[i])}</span>`; }
        const m = S.showTrades && marks.find((x) => x.xAxis === d);
        if (m) {
          const list = (a) => (a.length > 6 ? a.slice(0, 6).join(', ') + ` +${a.length - 6} more` : a.join(', '));
          if (m.info.buys.length) h += `<br><span style="color:#3ccf7f">Bought: ${list(m.info.buys)}</span>`;
          if (m.info.sells.length) h += `<br><span style="color:#f0625a">Sold: ${list(m.info.sells)}</span>`;
        }
        return h;
      } },
    legend: { top: 0, right: 0, textStyle: { color: C.ink2 }, icon: 'roundRect', itemWidth: 12, itemHeight: 3 },
    xAxis: { type: 'category', data: bt.dates, ...axisCommon, splitLine: { show: false },
      axisLabel: { ...axisCommon.axisLabel, formatter: (v) => (long ? v.slice(0, 7) : short ? v.slice(5) : v.slice(2, 7)) } },
    yAxis: { type: 'value', scale: true, ...axisCommon },
    series: [
      { name: bt.actual ? 'SMIF (actual)' : 'SMIF', type: 'line', data: bt.smif, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,198,41,0.25)' }, { offset: 1, color: 'rgba(255,198,41,0)' }]) },
        endLabel: { show: true, color: C.ink, formatter: (p) => `SMIF ${fmt.spct(p.value / 100 - 1)}` },
        markLine: marks.length && S.showTrades ? { silent: true, symbol: 'none', lineStyle: { color: 'rgba(255,198,41,0.28)', type: 'dashed', width: 1 }, data: marks } : undefined },
      { name: 'S&P 500 (SPY)', type: 'line', data: bt.bench, showSymbol: false, lineStyle: { width: 2, color: C.grayLight }, itemStyle: { color: C.grayLight },
        endLabel: { show: true, color: C.ink2, formatter: (p) => `SPY ${fmt.spct(p.value / 100 - 1)}` } },
    ],
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
    grid: { left: 150, right: 30, top: 28, bottom: 20 },
    legend: { top: 0, right: 0, textStyle: { color: C.ink2 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
    tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (p) => { const r = d[p[0].dataIndex]; return `<b>${r.s}</b><br>SMIF: ${fmt.pct(r.smif)}<br>S&P 500: ${fmt.pct(r.spx)}<br>Difference: ${fmt.pts(r.smif - r.spx)}`; } },
    xAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    yAxis: { type: 'category', data: d.map((x) => x.s), ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2, fontSize: 11 } },
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
    itemStyle: { color: '#3a3835', borderColor: '#0c0b0a', borderWidth: 3, gapWidth: 2 },
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
      upperLabel: { show: true, height: isMobile() ? 20 : 24, color: '#FFC629', fontWeight: 700, fontSize: isMobile() ? 10 : 12, backgroundColor: 'transparent', overflow: 'truncate', ellipsis: '',
        formatter: (p) => (p.name ? `${shortName(p.name)}  ${fmt.pct(p.value / calc.total, isMobile() ? 0 : 1)}` : '') },
      label: { show: true, color: '#fff', fontWeight: 700, fontSize: isMobile() ? 10 : 12, lineHeight: isMobile() ? 12 : 15, overflow: 'truncate', ellipsis: '',
        formatter: (p) => { const r = p.data.r; if (!r) return p.name; const v = mode === 'ret' ? r.ret : r.dayChg; return isMobile() ? p.name : `${p.name}\n{s|${fmt.spct(v, mode === 'ret' ? 0 : 1)}}`; },
        rich: { s: { fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.85)' } } },
      levels: [{ itemStyle: { borderColor: '#0c0b0a', borderWidth: 4, gapWidth: 4 } }, { itemStyle: { gapWidth: 2 } }],
      data,
    }],
  }, (p) => p.data?.r && openStock(p.data.r.ticker));
  renderSectorBars('chSector', S.secBasis);
  const d = sectorData('equity').map((x) => ({ ...x, diff: x.smif - x.spx })).sort((a, b) => a.diff - b.diff);
  const band = S.settings.band / 100;
  setChart('chActive', {
    grid: { left: 150, right: 60, top: 10, bottom: 20 },
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p) => { const r = d[p.dataIndex]; return `<b>${r.s}</b><br>${r.diff >= 0 ? 'Overweight' : 'Underweight'} by ${Math.abs(r.diff * 100).toFixed(1)} pts<br>SMIF ${fmt.pct(r.smif)} vs S&P ${fmt.pct(r.spx)}`; } },
    xAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => (v * 100).toFixed(0) + ' pts' } },
    yAxis: { type: 'category', data: d.map((x) => x.s), ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2 } },
    series: [{ type: 'bar', barWidth: '55%', data: d.map((x) => ({ value: x.diff, itemStyle: { color: x.diff >= 0 ? C.gold : C.blue, borderRadius: x.diff >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4], opacity: Math.abs(x.diff) > band ? 1 : 0.65 } })),
      label: { show: true, position: 'right', color: C.ink2, formatter: (p) => fmt.pts(p.value) },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: C.muted, type: 'dashed' }, label: { color: C.muted, formatter: `±${S.settings.band} pts` }, data: [{ xAxis: band }, { xAxis: -band }] } }],
  });

  // weights table grouped by sector
  const groups = Object.entries(byS).sort((a, b) => b[1].reduce((x, r) => x + r.value, 0) - a[1].reduce((x, r) => x + r.value, 0));
  const maxW = Math.max(...calc.rows.map((r) => r.weight));
  const spx = Object.fromEntries((S.base.spxConstituents || []).map((x) => [x.ticker, x.weight]));
  S.openSectors = S.openSectors || new Set();
  let html = `<thead><tr><th style="cursor:default">Sector / holding</th><th class="n" style="cursor:default">Value</th><th class="n" style="cursor:default">Weight (total)</th><th class="n" style="cursor:default">Weight ex-cash</th><th class="n" style="cursor:default">Weight in equities</th><th class="n" style="cursor:default">S&amp;P 500 weight</th></tr></thead><tbody>`;
  groups.forEach(([s, rs], gi) => {
    const v = rs.reduce((a, r) => a + r.value, 0);
    const open = S.openSectors.has(s);
    html += `<tr class="sector-row fold-row${open ? ' open' : ''}" data-sector="${esc(s)}" tabindex="0" role="button" aria-expanded="${open}"><td><span class="caret">▸</span>${esc(s)} <span class="tag">${rs.length}</span></td><td class="n">${fmt.usd(v)}</td><td class="n">${fmt.pct(v / calc.total, 2)}</td><td></td><td class="n">${s in calc.sectors ? fmt.pct(calc.sectors[s].wEq, 2) : ''}</td><td class="n">${S.base.benchmark.sectorWeights[s] != null ? fmt.pct(S.base.benchmark.sectorWeights[s], 2) : ''}</td></tr>`;
    rs.sort((a, b) => b.value - a.value).forEach((r) => {
      html += `<tr class="child-row clickable" data-parent="${esc(s)}" data-open="${r.ticker}" ${open ? '' : 'hidden'}><td style="padding-left:34px"><span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span></td><td class="n">${fmt.usd(r.value)}</td>
        <td class="n"><div class="wbar"><i style="width:${(r.weight / maxW) * 90}px"></i>${fmt.pct(r.weight, 2)}</div></td>
        <td class="n">${fmt.pct(r.weightExCash, 2)}</td><td class="n">${fmt.pct(r.weightEq, 2)}</td><td class="n">${spx[r.ticker] != null ? fmt.pct(spx[r.ticker], 2) : '—'}</td></tr>`;
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
  const rows = calc.rows.filter((r) => r.ret != null && r.assetClass !== 'Money Market');
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
    xAxis: { type: 'category', data: ps.series.dates, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => v.slice(5) } },
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
  const sec = sel.value;
  const rows = calc.rows.filter((r) => (!q || r.ticker.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)) && (!sec || r.sector === sec));
  sortableTable('#tblHoldings', [
    { k: 'ticker', l: 'Holding', f: (r) => `<span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span>` },
    { k: 'sector', l: 'Sector', f: (r) => `<span class="tag">${esc(r.sector || r.assetClass)}</span>` },
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
const fdate = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'today');
const yearsBetween = (a, b) => ((b ? new Date(b) : new Date()) - new Date(a)) / (365.25 * 86400000);
const heldFor = (a, b) => { const y = yearsBetween(a, b); return y >= 1 ? `${y.toFixed(1)} yrs` : `${Math.max(1, Math.round(y * 12))} mo`; };
const TYPE_CLS = { Buy: 'buy', Sell: 'sell', 'Spin-off': 'evt', Merger: 'evt', 'Ticker change': 'evt', Split: 'evt', 'Stock dividend': 'evt', 'Shares received': 'evt', 'Shares removed': 'evt' };

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
  const realizedTip = 'Profit or loss locked in by selling, using the average-cost method. Estimate — Schwab\'s tax lots can differ slightly.';
  const stats = `<div class="metrics hist-metrics">
    ${metric('Times owned', h.periods.length, cur ? 'Holding now' : 'Fully sold')}
    ${metric('Total bought', fmt.usd(h.bought), '')}
    ${metric('Total sold', fmt.usd(h.sold), '')}
    ${metric('Realized gain', `<span class="${cls(h.realized)}">${fmt.usd(h.realized)}</span>`, 'From shares sold', realizedTip)}
    ${metric('Dividends received', fmt.usd(h.dividends), h.foreignTax ? `after ${fmt.usd(h.foreignTax)} foreign tax` : '', 'All cash dividends and distributions paid to the fund while we owned it.')}
  </div>`;
  const rows = [...h.trades].reverse();
  const limit = opts.limit || 8;
  const rowHTML = (t) => `<tr><td>${fdate(t.date)}</td><td><span class="ttype ${TYPE_CLS[t.type] || 'evt'}">${esc(t.type)}</span></td><td class="n">${fmt.n(t.shares, 2)}</td>
    <td class="n">${t.price && (t.type === 'Buy' || t.type === 'Sell') ? fmt.usdC(t.price) : '—'}</td><td class="n">${t.amount && (t.type === 'Buy' || t.type === 'Sell') ? fmt.usd(t.amount) : '—'}</td><td class="n">${fmt.n(t.after, 2)}</td></tr>`;
  const table = `<div class="table-wrap hist-table"><table><thead><tr><th style="cursor:default">Date</th><th style="cursor:default">Action</th><th class="n" style="cursor:default">Shares</th><th class="n" style="cursor:default">Price</th><th class="n" style="cursor:default">Amount</th><th class="n" style="cursor:default">Shares after</th></tr></thead>
    <tbody>${rows.slice(0, limit).map(rowHTML).join('')}</tbody></table></div>
    ${rows.length > limit ? `<button class="btn sm mt hist-all" data-hist="${esc(sym)}">See all ${rows.length} transactions</button>` : ''}`;
  return status + timeline + stats + `<h3 class="mt">Transactions</h3>` + table;
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
    return { ...t, from: t.periods[0].from, to: last.to, held: t.periods.reduce((a, p) => a + yearsBetween(p.from, p.to), 0) };
  });
  sortableTable('#tblFormer', [
    { k: 'ticker', l: 'Stock', f: (r) => `<span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span>` },
    { k: 'from', l: 'First bought', n: 1, f: (r) => fdate(r.from) },
    { k: 'to', l: 'Last sold', n: 1, f: (r) => fdate(r.to) },
    { k: 'held', l: 'Time held', n: 1, f: (r) => (r.held >= 1 ? r.held.toFixed(1) + ' yrs' : Math.max(1, Math.round(r.held * 12)) + ' mo') + (r.periods.length > 1 ? ` <span class="tag">${r.periods.length}×</span>` : '') },
    { k: 'realized', l: 'Realized gain', n: 1, f: (r) => `<span class="${cls(r.realized)}">${fmt.usd(r.realized)}</span>`, t: 'Profit or loss from selling, average-cost method (estimate).' },
    { k: 'dividends', l: 'Dividends', n: 1, f: (r) => fmt.usd(r.dividends) },
    { k: 'hist', l: '', f: (r) => `<button class="btn sm hist-btn" data-hist="${r.ticker}">History</button>` },
  ], rows.map((r) => ({ ...r, ticker: r.ticker })), 'to');
  // trade log
  const type = $('#tlType').value, tq = ($('#tlSearch').value || '').trim().toUpperCase();
  const trades = [];
  all.forEach((t) => t.trades.forEach((x) => { if ((x.type === 'Buy' || x.type === 'Sell') && (!type || x.type === type) && (!tq || t.ticker.includes(tq))) trades.push({ ...x, ticker: t.ticker, name: t.name }); }));
  trades.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.ticker.localeCompare(b.ticker)));
  $('#tblTrades').innerHTML = `<thead><tr><th style="cursor:default">Date</th><th style="cursor:default">Action</th><th style="cursor:default">Stock</th><th class="n" style="cursor:default">Shares</th><th class="n" style="cursor:default">Price</th><th class="n" style="cursor:default">Amount</th></tr></thead><tbody>${
    trades.slice(0, tlShown).map((t) => `<tr class="clickable" data-hist="${t.ticker}"><td>${fdate(t.date)}</td><td><span class="ttype ${t.type === 'Buy' ? 'buy' : 'sell'}">${t.type}</span></td><td><span class="tk">${t.ticker}</span><span class="nm">${esc(t.name)}</span></td><td class="n">${fmt.n(t.shares, 2)}</td><td class="n">${fmt.usdC(t.price)}</td><td class="n">${fmt.usd(t.amount)}</td></tr>`).join('')}</tbody>`;
  $('#tlMore').style.display = trades.length > tlShown ? '' : 'none';
  $('#tlMore').textContent = `Show more (${trades.length - tlShown} left)`;
}

// ======================================================================
// Screener & trade lab
// ======================================================================
function universe() {
  const m = new Map();
  (S.base.spxConstituents || []).forEach((x) => m.set(x.ticker, { symbol: x.ticker, name: x.name, sector: x.sector, spx: x.weight }));
  S.base.holdings.forEach((h) => m.set(h.ticker, { ...(m.get(h.ticker) || {}), symbol: h.ticker, name: h.name, sector: h.sector, held: true }));
  return [...m.values()];
}
let sugIdx = -1, sugTimer;
function renderSuggest(list) {
  const box = $('#scrSuggest');
  if (!list.length) { box.classList.remove('open'); return; }
  box.innerHTML = list.slice(0, 8).map((x, i) => `<div data-s="${esc(x.symbol)}" class="${i === sugIdx ? 'hl' : ''}"><span><b>${esc(x.symbol)}</b> ${esc(x.name || '')}</span><small>${x.held ? 'HELD · ' : ''}${esc(x.sector || x.exchange || x.type || '')}</small></div>`).join('');
  box.classList.add('open');
  $$('div', box).forEach((d) => d.addEventListener('mousedown', (e) => { e.preventDefault(); analyze(d.dataset.s); }));
}
function onSearchInput() {
  const q = $('#scrInput').value.trim();
  sugIdx = -1;
  if (!q) return renderSuggest([]);
  const ql = q.toLowerCase();
  const local = universe().filter((x) => x.symbol.toLowerCase().startsWith(ql) || (x.name || '').toLowerCase().includes(ql))
    .sort((a, b) => (b.symbol.toLowerCase() === ql) - (a.symbol.toLowerCase() === ql) || (b.held ? 1 : 0) - (a.held ? 1 : 0) || (b.spx || 0) - (a.spx || 0));
  renderSuggest(local);
  clearTimeout(sugTimer);
  if (S.api && q.length >= 2) sugTimer = setTimeout(async () => {
    try {
      const r = await getJSON(`/api/profile?q=${encodeURIComponent(q)}`, {}, 6000);
      if ($('#scrInput').value.trim() !== q) return;
      const seen = new Set(local.map((x) => x.symbol));
      renderSuggest([...local, ...r.results.filter((x) => !seen.has(x.symbol))]);
    } catch { /* local suggestions are enough */ }
  }, 300);
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
      getJSON(`/api/profile?symbol=${encodeURIComponent(sym)}`, {}, 15000),
    ]);
    if (mr.status === 'fulfilled' && mr.value) mr.value.data.forEach((d) => { if (d && !d.error && d.closes?.length) S.market[d.symbol.toUpperCase()] = d; else if (d?.symbol?.toUpperCase() === sym) err = d.error; });
    if (mr.status === 'rejected') err = mr.reason?.message;
    if (pr.status === 'fulfilled') prof = pr.value;
    m = S.market[sym];
    if (m && S.market.SPY) S.stats[sym] = symbolStats(m, S.market.SPY, rf());
  }
  const st = S.stats[sym];
  const price = m?.price ?? held?.price ?? null;
  S.stock = {
    symbol: sym,
    name: prof?.name || m?.name || held?.name || spx?.name || sym,
    sector: held?.sector || (prof?.sector ? toGics(prof.sector) : spx?.sector) || null,
    industry: held?.industry || prof?.industry || '',
    assetClass: held?.assetClass || (m?.type === 'ETF' || prof?.quoteType === 'ETF' ? 'Equity' : 'Equity'),
    price, live: !!m, m, prof, st, held, spx,
  };
  if (!m && !held && !price) {
    S.stock.manual = true;
  }
  if (!S.stock.sector) S.stock.sector = 'Other';
  renderStockCard(err);
  syncTradePanel();
}

function metric(k, v, s, t) {
  return `<div class="metric"><div class="k">${k}${t ? tip(t) : ''}</div><div class="v num">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
}
function renderStockCard(err) {
  const s = S.stock, m = s.m, p = s.prof || {}, st = s.st;
  const day = m ? (m.dayPrevClose ? m.price / m.dayPrevClose - 1 : null) : s.held?.prevClose ? s.held.price / s.held.prevClose - 1 : null;
  const hr = s.held ? calc.rows.find((r) => r.ticker === s.symbol) : null;
  const secW = calc.sectors[s.sector]?.wEq || 0, secB = S.base.benchmark.sectorWeights[s.sector];
  const upside = p.targetMeanPrice && s.price ? p.targetMeanPrice / s.price - 1 : null;
  const pos52 = st && st.high52 > st.low52 ? (s.price - st.low52) / (st.high52 - st.low52) : null;
  let h = `<div class="stock-head">
    <div><div class="row"><h2 style="font-size:24px">${esc(s.symbol)}</h2>${s.held ? `<span class="tag gold">In portfolio</span>` : ''}${s.spx ? `<span class="tag">S&amp;P 500 · ${fmt.pct(s.spx.weight, 2)}</span>` : ''}</div>
      <div style="color:var(--ink-2);margin-top:4px">${esc(s.name)}</div>
      <div style="color:var(--muted);font-size:12px;margin-top:2px">${esc(s.sector)}${s.industry ? ' · ' + esc(s.industry) : ''}${m?.exchange ? ' · ' + esc(m.exchange) : ''}</div></div>
    <div class="px-wrap"><div class="px num">${s.price != null ? fmt.usdC(s.price) : '—'}</div>${day != null ? `<span class="chg ${day >= 0 ? 'up' : 'down'}">${fmt.spct(day, 2)} today</span>` : ''}
      <div style="color:var(--muted);font-size:11px;margin-top:6px">${s.live ? 'Live (delayed) · Yahoo Finance' : s.held ? 'Snapshot price from workbook' : 'No live data'}</div></div></div>`;
  if (err && !s.live) h += `<div class="warn-box">⚠ Couldn't load market data for ${esc(s.symbol)} (${esc(err)}). ${s.held ? 'Using the workbook price.' : 'Enter a price manually in the trade panel to simulate.'}</div>`;
  if (!S.api && !s.held) h += `<div class="warn-box">Live data is available once the site is deployed with its server functions. For now, type a price manually in the trade panel.</div>`;
  if (hr) h += `<div class="warn-box ok" style="margin-top:12px"><span>We own <b>${fmt.n(hr.quantity, 2)} shares</b> worth ${fmt.usd(hr.value)} (${fmt.pct(hr.weight, 2)} of the fund) · avg cost ${fmt.usdC(hr.avgCost)} · ${fmt.spct(hr.ret)} since ${hr.purchaseDate}</span></div>`;
  h += `<div id="chStock" class="chart short mt"></div>`;
  if (st) {
    h += `<div class="range52-wrap" style="margin:14px 0 4px"><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)"><span>52-wk low ${fmt.usdC(st.low52)}</span><span>52-week range ${tip(GLOSS.r52)}</span><span>high ${fmt.usdC(st.high52)}</span></div><div class="range52"><i style="left:${(pos52 ?? 0) * 100}%"></i></div></div>`;
  }
  h += `<h3 class="mt">Risk &amp; return (1 year, vs S&amp;P 500)</h3><div class="metrics">
    ${metric('Beta', fmt.x(st?.beta), p.beta != null ? `Yahoo (5y monthly): ${fmt.x(p.beta)}` : 'Daily, 1 year', GLOSS.beta)}
    ${metric('Volatility', fmt.pct(st?.vol), st ? `S&P: ${fmt.pct(S.stats.SPY?.vol)}` : '', GLOSS.vol)}
    ${metric('Sharpe ratio', st ? `<span class="${cls(st.sharpe)}">${fmt.x(st.sharpe)}</span>` : '—', st ? `S&P: ${fmt.x(S.stats.SPY?.sharpe)} · rf ${fmt.pct(rf(), 2)}` : '', GLOSS.sharpe)}
    ${metric('Sortino ratio', fmt.x(st?.sortino), '', GLOSS.sortino)}
    ${metric('Max drawdown', st ? `<span class="down">${fmt.pct(st.maxDD)}</span>` : '—', '', GLOSS.maxDD)}
    ${metric('Alpha', st ? `<span class="${cls(st.alpha)}">${fmt.spct(st.alpha)}</span>` : '—', '', GLOSS.alpha)}
    ${metric('Correlation', fmt.x(st?.corr), 'to S&P 500', GLOSS.corr)}
    ${metric('1Y return', st ? `<span class="${cls(st.periods['1Y'])}">${fmt.spct(st.periods['1Y'])}</span>` : '—', st ? `YTD ${fmt.spct(st.periods.YTD)} · 3M ${fmt.spct(st.periods['3M'])}` : '')}
  </div>
  <h3 class="mt">Portfolio fit</h3><div class="metrics">
    ${metric('Our ' + esc(s.sector) + ' weight', fmt.pct(secW), secB != null ? `S&P 500: ${fmt.pct(secB)} (${fmt.pts(secW - secB)})` : '', 'Share of our equity sleeve already in this sector, compared with the S&P 500.')}
    ${metric('Correlation to portfolio', S.pstats && st ? fmt.x(corrToPortfolio(s.symbol)) : '—', 'Lower = better diversifier', 'How closely this stock has moved with the SMIF portfolio over the past year.')}
  </div>
  <details class="fold mt" data-fold="val"><summary><span>Valuation &amp; fundamentals</span><small>${[p.trailingPE != null ? `P/E ${fmt.x(p.trailingPE, 1)}` : '', p.dividendYield != null ? `Yield ${fmt.pct(p.dividendYield, 2)}` : '', upside != null ? `Target ${fmt.spct(upside)}` : ''].filter(Boolean).join(' · ') || 'Tap to view'}</small></summary>
  <div class="metrics">
    ${metric('Market cap', fmt.big(p.marketCap), '', 'Total value of all shares outstanding.')}
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
</details>`;
  if (S.hist) {
    const hh = S.hist.tickers[s.symbol], cur = hh?.periods.find((x) => !x.to);
    const peek = !hh ? 'Never owned' : cur ? `Owned since ${fdate(cur.from)} · ${hh.trades.length} transactions` : `Owned ${hh.periods.map((x) => `${x.from.slice(0, 4)}–${x.to.slice(0, 4)}`).join(', ')} · ${hh.trades.length} transactions`;
    h += `<details class="fold mt" data-fold="hist"><summary><span>Our history with ${esc(s.symbol)}</span><small>${esc(peek)}</small></summary>${historyHTML(s.symbol)}</details>`;
  }
  if (p.summary) h += `<details class="fold mt" data-fold="biz"><summary><span>Business summary</span><small>${esc(p.industry || '')}</small></summary><p style="color:var(--ink-2);font-size:13px;line-height:1.6;margin-top:0">${esc(p.summary)}…</p></details>`;
  $('#stockCard').innerHTML = h;
  if (m) {
    const avg = s.held?.avgCost;
    setChart('chStock', {
      grid: { left: 50, right: 16, top: 12, bottom: 24 },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.gold, opacity: 0.5 } },
        formatter: (p) => { const d = p[0].axisValue; const tr = (S.hist?.tickers?.[s.symbol]?.trades || []).filter((t) => (t.type === 'Buy' || t.type === 'Sell') && m.dates[m.dates.findIndex((x) => x >= t.date)] === d);
          return `<b>${d}</b><br>${p[0].marker} ${fmt.usdC(p[0].value)}` + tr.map((t) => `<br><span style="color:${t.type === 'Buy' ? '#3ccf7f' : '#f0625a'}">We ${t.type === 'Buy' ? 'bought' : 'sold'} ${fmt.n(t.shares, 2)} sh @ ${fmt.usdC(t.price)}</span>`).join(''); } },
      xAxis: { type: 'category', data: m.dates, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => v.slice(5) } },
      yAxis: { type: 'value', scale: true, ...axisCommon },
      series: [{ name: s.symbol, type: 'line', data: m.closes, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,198,41,0.22)' }, { offset: 1, color: 'rgba(255,198,41,0)' }]) },
        markLine: avg ? { silent: true, symbol: 'none', lineStyle: { color: C.grayLight, type: 'dashed' }, label: { color: C.ink2, formatter: `Our avg cost ${fmt.usdC(avg)}`, position: 'insideStartTop' }, data: [{ yAxis: avg }] } : undefined,
        markPoint: (() => {
          const tr = (S.hist?.tickers?.[s.symbol]?.trades || []).filter((t) => (t.type === 'Buy' || t.type === 'Sell') && t.date >= m.dates[0]);
          if (!tr.length) return undefined;
          return { symbolSize: 26, label: { color: '#111', fontWeight: 800, fontSize: 10 }, data: tr.map((t) => {
            const i = m.dates.findIndex((d) => d >= t.date); if (i < 0) return null;
            return { coord: [m.dates[i], m.closes[i]], value: t.type === 'Buy' ? 'B' : 'S', symbol: 'pin', symbolRotate: t.type === 'Buy' ? 180 : 0, symbolOffset: [0, t.type === 'Buy' ? 14 : -14], itemStyle: { color: t.type === 'Buy' ? C.up : C.down },
              label: { offset: [0, t.type === 'Buy' ? 3 : 0] }, tip: `${t.type} ${fmt.n(t.shares, 2)} sh @ ${fmt.usdC(t.price)} on ${fdate(t.date)}` };
          }).filter(Boolean) };
        })() }],
    });
  } else emptyChart('chStock', s.held ? 'Price history appears once live data is connected.' : 'No price history available.');
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
  const funding = $('#fundSel').value;
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
  $('#fundWrap').style.display = S.trade.side === 'buy' || S.trade.mode === 'weight' ? '' : 'none';
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
    <div><span>${s.symbol} weight</span><b>${fmt.pct(t.ac.rows.find((r) => r.ticker === s.symbol)?.weight || 0, 2)} → ${fmt.pct(nr?.weight || 0, 2)}</b></div>
    <div><span>Cash &amp; MMF after</span><b class="${ac.cashLike < 0 ? 'down' : ''}">${fmt.usd(ac.cashLike)}</b></div>`;
  btn.disabled = false;
  btn.textContent = `Add ${t.side === 'buy' ? 'buy' : 'sell'} of ${fmt.n(t.shares)} ${s.symbol} to ticket`;
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
    <div><b>${t.ticker}</b> · ${fmt.n(t.shares)} sh @ ${fmt.usdC(t.price)}<div style="color:var(--muted);font-size:11px">${t.side === 'buy' && t.funding === 'new' ? 'New money' : t.side === 'buy' ? 'From cash & MMF' : 'Proceeds to cash'}</div></div>
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
  h += row('Cash &amp; money market', `${fmt.usd(before.cashLike)} (${fmt.pct(before.cashLike / before.total)})`, `${fmt.usd(after.cashLike)} (${fmt.pct(after.cashLike / after.total)})`);
  h += row('Equity weight', fmt.pct(before.eqValue / before.total), fmt.pct(after.eqValue / after.total));
  const tickers = [...new Set(S.trades.map((t) => t.ticker))];
  tickers.forEach((tk) => {
    const b = before.rows.find((r) => r.ticker === tk), a = after.rows.find((r) => r.ticker === tk);
    h += row(`<b>${tk}</b>&nbsp;weight`, fmt.pct(b?.weight || 0, 2), fmt.pct(a?.weight || 0, 2));
  });
  const secsT = [...new Set(S.trades.map((t) => t.sector).filter((s) => s && bw[s] != null))];
  secsT.forEach((s) => h += row(`${s} (S&amp;P ${fmt.pct(bw[s])})`, fmt.pct(before.sectors[s]?.wEq || 0), fmt.pct(after.sectors[s]?.wEq || 0), 'Share of our equity sleeve in this sector.'));
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
  const maxPos = S.settings.maxPos / 100, band = S.settings.band / 100;
  after.rows.filter((r) => r.assetClass === 'Equity' && r.weight > maxPos && tickers.includes(r.ticker)).forEach((r) => warns.push({ level: 'warn', text: `${r.ticker} would be ${fmt.pct(r.weight, 1)} of the fund — above the ${S.settings.maxPos}% single-position limit.` }));
  secsT.forEach((s) => {
    const d = (after.sectors[s]?.wEq || 0) - bw[s];
    if (Math.abs(d) > band) warns.push({ level: 'warn', text: `${s} would be ${fmt.pts(d)} vs the S&P 500 — outside the ±${S.settings.band} pt band.` });
  });
  if (after.cashLike < 0) warns.push({ level: 'bad', text: 'Cash would go negative — sell something or mark the buy as new money.' });
  h += warns.length ? warns.map((w) => `<div class="warn-box ${w.level === 'bad' ? 'bad' : ''}">⚠ ${esc(w.text)}</div>`).join('') : `<div class="warn-box ok">✓ Within the position (${S.settings.maxPos}%) and sector (±${S.settings.band} pts) guidelines.</div>`;
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
        trades = XLSX.utils.sheet_to_json(ws).map((r) => ({ ticker: String(r.Ticker).toUpperCase(), side: String(r.Side).toLowerCase(), shares: +r.Shares, price: +r.Price, name: r.Name, sector: r.Sector, assetClass: 'Equity', funding: /new/i.test(r.Funding || '') ? 'new' : 'cash' }));
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
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.trades.map((t) => ({ Side: t.side.toUpperCase(), Ticker: t.ticker, Name: t.name, Sector: t.sector, Shares: t.shares, Price: t.price, Amount: +(t.shares * t.price).toFixed(2), Funding: t.side === 'buy' ? (t.funding === 'new' ? 'New money' : 'Cash & MMF') : 'Proceeds to cash' }))), 'Trades');
  const secs = SECTORS.map((s) => ({ Sector: s, 'Now (equity %)': +((before.sectors[s]?.wEq || 0) * 100).toFixed(2), 'After (equity %)': +((after.sectors[s]?.wEq || 0) * 100).toFixed(2), 'S&P 500 %': +((S.base.benchmark.sectorWeights[s] || 0) * 100).toFixed(2) }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { Metric: 'Total value', Now: +before.total.toFixed(2), After: +after.total.toFixed(2) },
    { Metric: 'Positions', Now: before.rows.length, After: after.rows.length },
    { Metric: 'Cash & MMF', Now: +before.cashLike.toFixed(2), After: +after.cashLike.toFixed(2) },
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
  // B) the original SMIF workbook (Portfolio tab)
  const ws = wb.Sheets.Portfolio;
  if (!ws) throw new Error('Expected a "Holdings" tab (site export) or a "Portfolio" tab (SMIF workbook).');
  const a = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  const hdr = a[0].map((x) => String(x || '').trim());
  const ix = (n) => hdr.indexOf(n);
  const iT = ix('Ticker'), iQ = ix('Quantity'), iP = ix('Current Price'), iPC = ix('Previous Close'), iC = ix('Purchase Price'), iD = ix('Purchase Date');
  const iS = hdr.indexOf('GICS Industry'), iI = hdr.lastIndexOf('GICS Industry');
  if (iT < 0 || iQ < 0) throw new Error('Portfolio tab is missing Ticker/Quantity columns.');
  let section = 'Equity', cash = 0;
  const holdings = [];
  for (const r of a.slice(1)) {
    const name = r[0];
    if (name === 'Equity') { section = 'Fixed Income'; continue; }
    if (name === 'Fixed Income') { section = 'Money Market'; continue; }
    if (name === 'Cash') { cash = +r[8] || 0; continue; }
    const t = r[iT], q = +r[iQ];
    if (!t || typeof t !== 'string' || !isFinite(q)) continue;
    holdings.push({
      ticker: t.trim().toUpperCase(), name: String(name || t).replace(/\s+/g, ' ').trim(), assetClass: section,
      sector: section === 'Equity' ? r[iS] : section, industry: section === 'Equity' ? r[iI] : '',
      quantity: q, avgCost: section === 'Money Market' ? 1 : +r[iC] || 0, price: +r[iP] || null, prevClose: +r[iPC] || null, purchaseDate: normDate(r[iD]),
    });
  }
  return { cash, holdings };
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

async function handleFile(f) {
  try {
    let parsed;
    if (f.name.toLowerCase().endsWith('.json')) {
      const j = JSON.parse(await f.text());
      parsed = { cash: j.cash, holdings: j.holdings, meta: j.meta };
    } else {
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
      if (aoa.length && looksLikeTransactions(aoa[0])) return handleTxHistory(aoa, f.name);
      parsed = parseWorkbook(XLSX.read(await f.arrayBuffer(), { cellDates: false }));
    }
    if (!parsed.holdings?.length) throw new Error('No holdings found');
    const next = cleanPortfolio({ ...S.base, ...parsed, meta: { ...S.base.meta, asOf: new Date().toISOString().slice(0, 10), source: f.name } });
    S.pendingUpload = next;
    // diff
    const cur = Object.fromEntries(S.base.holdings.map((h) => [h.ticker, h]));
    const nxt = Object.fromEntries(next.holdings.map((h) => [h.ticker, h]));
    const added = next.holdings.filter((h) => !cur[h.ticker]);
    const removed = S.base.holdings.filter((h) => !nxt[h.ticker]);
    const changed = next.holdings.filter((h) => cur[h.ticker] && (Math.abs(+cur[h.ticker].quantity - +h.quantity) > 1e-6 || Math.abs(+cur[h.ticker].avgCost - +h.avgCost) > 1e-4));
    const el = $('#uploadPreview');
    el.style.display = '';
    el.innerHTML = `<div class="card-head"><h2>Review upload: ${esc(f.name)}</h2><span class="hint">${next.holdings.length} holdings · cash ${fmt.usdC(next.cash)}</span></div>
      <div class="grid g-3">
        <div><h3 class="up">Added (${added.length})</h3>${added.map((h) => `<div class="list-item"><b>${h.ticker}</b><span>${fmt.n(h.quantity, 2)} sh</span></div>`).join('') || '<div style="color:var(--muted);font-size:13px">None</div>'}</div>
        <div><h3 class="down">Removed (${removed.length})</h3>${removed.map((h) => `<div class="list-item"><b>${h.ticker}</b><span>${fmt.n(h.quantity, 2)} sh</span></div>`).join('') || '<div style="color:var(--muted);font-size:13px">None</div>'}</div>
        <div><h3 style="color:var(--gold)">Changed (${changed.length})</h3>${changed.map((h) => `<div class="list-item"><b>${h.ticker}</b><span>${fmt.n(cur[h.ticker].quantity, 2)} → ${fmt.n(h.quantity, 2)} sh</span></div>`).join('') || '<div style="color:var(--muted);font-size:13px">None</div>'}</div>
      </div>${Math.abs(next.cash - S.base.cash) > 0.005 ? `<div class="warn-box">Cash: ${fmt.usdC(S.base.cash)} → ${fmt.usdC(next.cash)}</div>` : ''}
      <div class="row mt"><button class="btn" id="upLocal">Use for me only</button><button class="btn primary" id="upPublish">Publish as master</button><button class="btn" id="upCancel">Cancel</button></div>`;
    $('#upCancel').onclick = () => { el.style.display = 'none'; S.pendingUpload = null; };
    $('#upLocal').onclick = () => useLocal(S.pendingUpload);
    $('#upPublish').onclick = () => confirmPublish(S.pendingUpload, `Uploaded ${f.name}`, () => { el.style.display = 'none'; });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    toast('Could not read that file: ' + e.message, 5000);
  }
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
const renderers = { overview: renderOverview, allocation: renderAllocation, performance: renderPerformance, risk: renderRisk, holdings: renderHoldings, screener: () => { renderTicket(); syncTradePanel(); }, data: renderData };
function show(view) {
  if (!renderers[view]) view = 'overview';
  if ($('#modal').classList.contains('open')) closeModal();
  hideTip?.();
  S.view = view;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  try { renderers[view](); } catch (e) { console.error(e); toast('Render error: ' + e.message, 5000); }
  requestAnimationFrame(() => Object.values(charts).forEach((c) => c && !c.isDisposed() && c.resize()));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function refreshAll(resetDraft) {
  recalc();
  if (resetDraft) S.draft = null;
  renderStatus();
  renderTape();
  renderers[S.view]();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
$$('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.go); }));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
const seg = (id, key, fn) => $$(`#${id} button`).forEach((b) => b.addEventListener('click', () => { S[key] = b.dataset.v; $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b)); fn(); }));
seg('tmColor', 'tmColor', renderAllocation);
seg('perfRange', 'perfRange', () => { store.set('perfRange', S.perfRange); renderPerfChart(); });
$('#tradeToggle').addEventListener('change', (e) => { S.showTrades = e.target.checked; store.set('showTrades', S.showTrades); renderPerfChart(); });
seg('secBasis', 'secBasis', () => renderSectorBars('chSector', S.secBasis));
seg('perfMode', 'perfMode', renderPerformance);
$('#hSearch').addEventListener('input', renderHoldings);
$('#fhSearch').addEventListener('input', renderHistoryLists);
$('#tlType').addEventListener('change', () => { tlShown = 40; renderHistoryLists(); });
$('#tlSearch').addEventListener('input', () => { tlShown = 40; renderHistoryLists(); });
$('#tlMore').addEventListener('click', () => { tlShown += 60; renderHistoryLists(); });
$('#hSector').addEventListener('change', renderHoldings);
$('#hExport').addEventListener('click', downloadMaster);
$('#rfInput').addEventListener('change', (e) => { const v = parseFloat(e.target.value); S.rf = isFinite(v) ? Math.min(20, Math.max(0, v)) / 100 : null; if (S.rf != null) e.target.value = (S.rf * 100).toFixed(2); store.set('rf', S.rf); computeStats(); renderRisk(); });
$('#refreshBtn').addEventListener('click', async () => { toast('Refreshing prices…'); await loadMarket(); refreshAll(); toast(S.live ? 'Prices updated' : 'Live data unavailable — showing snapshot'); });

// screener wiring
$('#scrInput').addEventListener('input', onSearchInput);
$('#scrInput').addEventListener('keydown', (e) => {
  const items = $$('#scrSuggest div');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sugIdx = Math.max(0, Math.min(items.length - 1, sugIdx + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((d, i) => d.classList.toggle('hl', i === sugIdx)); }
  if (e.key === 'Enter') { e.preventDefault(); analyze(sugIdx >= 0 && items[sugIdx] ? items[sugIdx].dataset.s : $('#scrInput').value); }
  if (e.key === 'Escape') $('#scrSuggest').classList.remove('open');
});
$('#scrInput').addEventListener('blur', () => setTimeout(() => $('#scrSuggest').classList.remove('open'), 150));
$('#scrGo').addEventListener('click', () => analyze($('#scrInput').value));
$$('#sideToggle button').forEach((b) => b.addEventListener('click', () => { S.trade.side = b.dataset.v; syncTradePanel(); }));
$$('#amtMode button').forEach((b) => b.addEventListener('click', () => { S.trade.mode = b.dataset.v; $('#amtInput').value = ''; syncTradePanel(); }));
['amtInput', 'manualPx', 'fundSel'].forEach((id) => $('#' + id).addEventListener('input', syncTradePanel));
$('#addTrade').addEventListener('click', () => {
  const t = computeTrade();
  if (!t || !t.shares) return;
  if (S.stock.manual && !S.stock.price) S.stock.price = t.px;
  S.trades.push(mkTrade(t));
  store.set('ticket', S.trades);
  $('#amtInput').value = '';
  renderTicket(); syncTradePanel();
  toast(`Added ${t.side} ${t.shares} ${S.stock.symbol}`);
});
$('#clearTicket').addEventListener('click', () => { S.trades = []; store.set('ticket', []); renderTicket(); syncTradePanel(); });
$('#saveScenario').addEventListener('click', saveScenario);
$('#loadScenario').addEventListener('click', loadScenario);
$('#exportScenario').addEventListener('click', exportScenario);
$('#commitScenario').addEventListener('click', commitScenario);

// data room wiring
$('#dlMaster').addEventListener('click', downloadMaster);
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('tip')) { e.preventDefault(); showTip(e.target); } });
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

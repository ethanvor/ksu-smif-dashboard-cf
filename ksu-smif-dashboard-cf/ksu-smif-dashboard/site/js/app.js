// KSU SMIF Dashboard — app shell, data loading, views.
import {
  computePortfolio, symbolStats, portfolioStats, applyTrades, periodReturns, weightedBeta,
  fmt, cls, toGics, SECTORS, CASH_LIKE,
} from './analytics.js';

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
  rfAuto: null,
  settings: { maxPos: 10, band: 5, name: '', ...store.get('settings', {}) },
  view: 'overview',
  tmColor: 'ret', secBasis: 'equity', perfMode: 'ret',
  trades: [],
  stock: null,         // screener current stock
  trade: { side: 'buy', mode: 'shares' },
  draft: null,
  pendingUpload: null,
};
const rf = () => (S.rf != null ? S.rf : S.rfAuto != null ? S.rfAuto : 0.04);
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
  $('#modalBody').innerHTML = html;
  $('#modal').classList.add('open');
  return $('#modalBody');
}
const closeModal = () => $('#modal').classList.remove('open');
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
  textStyle: { color: C.ink, fontFamily: 'Montserrat, system-ui', fontSize: 12 }, extraCssText: 'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);',
};
const axisCommon = {
  axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
  axisLabel: { color: C.muted, fontFamily: 'Montserrat, system-ui', fontSize: 11 },
  splitLine: { lineStyle: { color: C.grid } },
};
function setChart(id, option) {
  const ch = chart(id);
  if (!ch) return;
  ch.setOption({ textStyle: baseText, animationDuration: 700, animationEasing: 'cubicOut', ...option }, true);
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
}

function allSymbols() {
  return [...new Set(S.base.holdings.map((h) => h.ticker).filter((t) => !CASH_LIKE.has(t) && t !== 'SNOXX'))];
}

async function loadMarket() {
  if (!S.api) { S.live = false; return; }
  try {
    const syms = [...allSymbols(), 'SPY', '^IRX'];
    const chunks = [];
    for (let i = 0; i < syms.length; i += 40) chunks.push(syms.slice(i, i + 40));
    const res = await Promise.all(chunks.map((c) => getJSON(`/api/market?symbols=${encodeURIComponent(c.join(','))}&range=1y`, {}, 30000)));
    let ok = 0;
    res.forEach((r) => r.data.forEach((d) => { if (d && !d.error && d.closes?.length) { S.market[d.symbol.toUpperCase()] = d; ok++; } }));
    const irx = S.market['^IRX'];
    if (irx && irx.price > 0 && irx.price < 20) S.rfAuto = irx.price / 100; // 13-week T-bill yield
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
  $('#statusText').textContent = S.live
    ? `Live · ${S.fetchedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : `Snapshot · ${S.base.meta?.asOf || ''}`;
  pill.title = `${src}. ${S.live ? 'Prices from Yahoo Finance (delayed).' : 'Prices from the workbook snapshot — live data needs the deployed site.'}`;
  $('#footMeta').textContent = `Showing: ${src}${S.base.meta?.version ? ' v' + S.base.meta.version : ''} · last updated ${S.base.meta?.updatedAt ? new Date(S.base.meta.updatedAt).toLocaleString() : '—'} by ${S.base.meta?.updatedBy || '—'}`;
}

// ======================================================================
// Overview
// ======================================================================
function renderOverview() {
  const c = calc;
  const [whole, cents] = fmt.usdC(c.total).split('.');
  $('#heroValue').innerHTML = `${whole}<span class="cents">.${cents}</span>`;
  const dc = $('#heroChg');
  dc.className = 'chg ' + (c.dayGl >= 0 ? 'up' : 'down');
  dc.textContent = `${c.dayGl >= 0 ? '▲' : '▼'} ${fmt.usd(Math.abs(c.dayGl))} (${fmt.spct(c.dayPct, 2)}) today`;
  const spyDay = S.live ? S.stats.SPY?.periods?.['1D'] : S.base.benchmark?.snapshot?.SPY?.change;
  $('#heroVs').textContent = spyDay != null ? `S&P 500 ${fmt.spct(spyDay, 2)}` : '';
  $('#heroMeta').innerHTML = `
    <div>Cost basis<b class="num">${fmt.usd(c.costBasis)}</b></div>
    <div>Unrealized gain<b class="num ${cls(c.unrealized)}">${fmt.usd(c.unrealized)} · ${fmt.spct(c.unrealizedPct)}</b></div>
    <div>Positions<b class="num">${c.rows.length}</b></div>
    <div>As of<b>${S.live ? 'Live (delayed)' : S.base.meta?.asOf || '—'}</b></div>`;

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
    const { dates, rets, bench } = ps.series;
    let a = 100, b = 100;
    const sa = [], sb = [];
    rets.forEach((r, i) => { a *= 1 + r; b *= 1 + bench[i]; sa.push(+a.toFixed(2)); sb.push(+b.toFixed(2)); });
    $('#perfTitle').textContent = 'SMIF vs S&P 500 — past year';
    $('#perfHint').textContent = "Today's holdings held for 1 year, rebased to 100";
    setChart('chPerf', {
      grid: { left: 44, right: 70, top: 20, bottom: 30 },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.gold, opacity: 0.5 } },
        formatter: (p) => `<b>${p[0].axisValue}</b><br>` + p.map((x) => `${x.marker} ${x.seriesName}: ${x.value} (${fmt.spct(x.value / 100 - 1)})`).join('<br>') },
      legend: { top: 0, right: 0, textStyle: { color: C.ink2 }, icon: 'roundRect', itemWidth: 12, itemHeight: 3 },
      xAxis: { type: 'category', data: dates, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => v.slice(5) } },
      yAxis: { type: 'value', scale: true, ...axisCommon },
      series: [
        { name: 'SMIF', type: 'line', data: sa, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,198,41,0.25)' }, { offset: 1, color: 'rgba(255,198,41,0)' }]) },
          endLabel: { show: true, color: C.ink, formatter: (p) => `SMIF ${fmt.spct(p.value / 100 - 1)}` } },
        { name: 'S&P 500 (SPY)', type: 'line', data: sb, showSymbol: false, lineStyle: { width: 2, color: C.grayLight }, itemStyle: { color: C.grayLight },
          endLabel: { show: true, color: C.ink2, formatter: (p) => `SPY ${fmt.spct(p.value / 100 - 1)}` } },
      ],
    });
  } else {
    // Snapshot: weighted SMIF return over each period from the Stock History tab
    const per = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y'];
    const sr = S.base.snapshotReturns || {};
    const vals = per.map((p) => {
      let w = 0, r = 0;
      c.rows.forEach((row) => { const v = sr[row.ticker]?.[p]; if (v != null) { r += row.weight * v; w += row.weight; } });
      return w ? +(r / w).toFixed(4) : null;
    });
    $('#perfTitle').textContent = 'SMIF return by period';
    $('#perfHint').textContent = 'Weighted by current holdings · workbook snapshot';
    setChart('chPerf', {
      grid: { left: 50, right: 20, top: 30, bottom: 30 },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => fmt.spct(v) },
      xAxis: { type: 'category', data: per, ...axisCommon, splitLine: { show: false } },
      yAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
      series: [{ name: 'SMIF', type: 'bar', barMaxWidth: 34, data: vals.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? C.gold : C.down, borderRadius: v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
        label: { show: true, position: 'top', color: C.ink2, formatter: (p) => fmt.spct(p.value) } }],
    });
  }

  // Movers
  const movers = c.rows.filter((r) => r.dayChg != null && r.assetClass === 'Equity').sort((a, b) => b.dayChg - a.dayChg);
  const li = (r) => `<div class="list-item"><div><span class="tk" style="font-weight:800">${r.ticker}</span> <span style="color:var(--muted);font-size:12px">${esc(r.name).slice(0, 26)}</span></div><div class="num ${cls(r.dayChg)}" style="font-weight:700">${fmt.spct(r.dayChg, 2)}</div></div>`;
  $('#movers').innerHTML = `<h3>Leaders</h3><div class="list">${movers.slice(0, 5).map(li).join('')}</div><h3 style="margin-top:14px">Laggards</h3><div class="list">${movers.slice(-5).reverse().map(li).join('')}</div>`;

  // Top 10
  const top = [...c.rows].filter((r) => r.assetClass === 'Equity').sort((a, b) => b.value - a.value).slice(0, 10).reverse();
  setChart('chTop10', {
    grid: { left: 60, right: 56, top: 6, bottom: 20 },
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p) => { const r = top[p.dataIndex]; return `<b>${r.ticker}</b> ${esc(r.name)}<br>${fmt.usd(r.value)} · ${fmt.pct(r.weight, 2)} of fund`; } },
    xAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.pct(v, 0) } },
    yAxis: { type: 'category', data: top.map((r) => r.ticker), ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink, fontWeight: 700 } },
    series: [{ type: 'bar', data: top.map((r) => r.weight), barWidth: '58%', itemStyle: { color: C.gold, borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: C.ink2, formatter: (p) => fmt.pct(p.value, 1) } }],
  });
  renderSectorBars('chSectorOv', 'equity');
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
      upperLabel: { show: true, height: 24, color: '#FFC629', fontWeight: 700, fontSize: 12, backgroundColor: 'transparent', formatter: (p) => (p.name ? `${p.name}  ${fmt.pct(p.value / calc.total)}` : '') },
      label: { show: true, color: '#fff', fontWeight: 700, fontSize: 12, lineHeight: 15,
        formatter: (p) => { const r = p.data.r; if (!r) return p.name; const v = mode === 'ret' ? r.ret : r.dayChg; return `${p.name}\n{s|${fmt.spct(v, mode === 'ret' ? 0 : 1)}}`; },
        rich: { s: { fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.85)' } } },
      levels: [{ itemStyle: { borderColor: '#0c0b0a', borderWidth: 4, gapWidth: 4 } }, { itemStyle: { gapWidth: 2 } }],
      data,
    }],
  });
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
  let html = `<thead><tr><th>Holding</th><th class="n">Value</th><th class="n">Weight (total)</th><th class="n">Weight ex-cash</th><th class="n">Weight in equities</th><th class="n">S&amp;P 500 weight</th></tr></thead><tbody>`;
  groups.forEach(([s, rs]) => {
    const v = rs.reduce((a, r) => a + r.value, 0);
    html += `<tr class="sector-row"><td>${esc(s)} <span class="tag">${rs.length}</span></td><td class="n">${fmt.usd(v)}</td><td class="n">${fmt.pct(v / calc.total, 2)}</td><td></td><td class="n">${s in calc.sectors ? fmt.pct(calc.sectors[s].wEq, 2) : ''}</td><td class="n">${S.base.benchmark.sectorWeights[s] != null ? fmt.pct(S.base.benchmark.sectorWeights[s], 2) : ''}</td></tr>`;
    rs.sort((a, b) => b.value - a.value).forEach((r) => {
      html += `<tr><td><span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span></td><td class="n">${fmt.usd(r.value)}</td>
        <td class="n"><div class="wbar"><i style="width:${(r.weight / maxW) * 90}px"></i>${fmt.pct(r.weight, 2)}</div></td>
        <td class="n">${fmt.pct(r.weightExCash, 2)}</td><td class="n">${fmt.pct(r.weightEq, 2)}</td><td class="n">${spx[r.ticker] != null ? fmt.pct(spx[r.ticker], 2) : '—'}</td></tr>`;
    });
  });
  $('#tblWeights').innerHTML = html + '</tbody>';
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
  setChart('chPerfBar', {
    grid: { left: 60, right: 20, top: 30, bottom: 60 },
    tooltip: { ...tooltipBase, trigger: 'item', formatter: (p) => { const r = sorted[p.dataIndex]; return `<b>${r.ticker}</b> ${esc(r.name)}<br>Return: ${fmt.spct(r.ret)} · ${fmt.usd(r.gl)}<br>Avg cost ${fmt.usdC(r.avgCost)} → ${fmt.usdC(r.price)}<br>Held ${r.days} days (since ${r.purchaseDate})${mode === 'ann' && r.days < 180 ? '<br><i>Short holding — annualized figure is exaggerated</i>' : ''}`; } },
    xAxis: { type: 'category', data: sorted.map((r) => r.ticker), ...axisCommon, splitLine: { show: false }, axisLabel: { color: C.ink2, rotate: 60, fontSize: 10, interval: 0 } },
    yAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: mode === 'gl' ? (v) => fmt.big(v) : (v) => fmt.pct(v, 0) } },
    series: [{ type: 'bar', barMaxWidth: 22, data: sorted.map((r) => ({ value: r[key], itemStyle: { color: r[key] >= 0 ? C.up : C.down, borderRadius: r[key] >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
      label: { show: sorted.length <= 50, position: 'top', color: C.muted, fontSize: 9, formatter: (p) => (Math.abs(p.dataIndex - 0) < 3 || p.dataIndex > sorted.length - 4 ? f(p.value) : '') } }],
  });

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
      <tbody>${data.map((r) => `<tr>${cols.map((c) => `<td class="${c.n ? 'n' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
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
  ], rows, 'value');
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
    <div style="text-align:right"><div class="px num">${s.price != null ? fmt.usdC(s.price) : '—'}</div>${day != null ? `<span class="chg ${day >= 0 ? 'up' : 'down'}">${fmt.spct(day, 2)} today</span>` : ''}
      <div style="color:var(--muted);font-size:11px;margin-top:6px">${s.live ? 'Live (delayed) · Yahoo Finance' : s.held ? 'Snapshot price from workbook' : 'No live data'}</div></div></div>`;
  if (err && !s.live) h += `<div class="warn-box">⚠ Couldn't load market data for ${esc(s.symbol)} (${esc(err)}). ${s.held ? 'Using the workbook price.' : 'Enter a price manually in the trade panel to simulate.'}</div>`;
  if (!S.api && !s.held) h += `<div class="warn-box">Live data is available once the site is deployed with its server functions. For now, type a price manually in the trade panel.</div>`;
  if (hr) h += `<div class="warn-box ok" style="margin-top:12px">We own <b>&nbsp;${fmt.n(hr.quantity, 2)} shares&nbsp;</b> worth ${fmt.usd(hr.value)} (${fmt.pct(hr.weight, 2)} of the fund) · avg cost ${fmt.usdC(hr.avgCost)} · ${fmt.spct(hr.ret)} since ${hr.purchaseDate}</div>`;
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
  <h3 class="mt">Valuation &amp; fundamentals</h3><div class="metrics">
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
  <h3 class="mt">Portfolio fit</h3><div class="metrics">
    ${metric('Our ' + esc(s.sector) + ' weight', fmt.pct(secW), secB != null ? `S&P 500: ${fmt.pct(secB)} (${fmt.pts(secW - secB)})` : '', 'Share of our equity sleeve already in this sector, compared with the S&P 500.')}
    ${metric('Correlation to portfolio', S.pstats && st ? fmt.x(corrToPortfolio(s.symbol)) : '—', 'Lower = better diversifier', 'How closely this stock has moved with the SMIF portfolio over the past year.')}
  </div>`;
  if (p.summary) h += `<details class="mt" style="color:var(--ink-2);font-size:13px;line-height:1.6"><summary style="cursor:pointer;color:var(--gold);font-weight:600">Business summary</summary><p>${esc(p.summary)}…</p></details>`;
  $('#stockCard').innerHTML = h;
  if (m) {
    const avg = s.held?.avgCost;
    setChart('chStock', {
      grid: { left: 50, right: 16, top: 12, bottom: 24 },
      tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.gold, opacity: 0.5 } }, valueFormatter: (v) => fmt.usdC(v) },
      xAxis: { type: 'category', data: m.dates, ...axisCommon, splitLine: { show: false }, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => v.slice(5) } },
      yAxis: { type: 'value', scale: true, ...axisCommon },
      series: [{ name: s.symbol, type: 'line', data: m.closes, showSymbol: false, lineStyle: { width: 2, color: C.gold }, itemStyle: { color: C.gold },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,198,41,0.22)' }, { offset: 1, color: 'rgba(255,198,41,0)' }]) },
        markLine: avg ? { silent: true, symbol: 'none', lineStyle: { color: C.grayLight, type: 'dashed' }, label: { color: C.ink2, formatter: `Our avg cost ${fmt.usdC(avg)}`, position: 'insideStartTop' }, data: [{ yAxis: avg }] } : undefined }],
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
  if (!(raw > 0)) return { px, shares: 0 };
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
  $$('[data-ld]', b).forEach((x) => x.onclick = () => { S.trades = all[x.dataset.ld].trades; store.set('ticket', S.trades); renderTicket(); syncTradePanel(); closeModal(); toast('Scenario loaded'); });
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
  $('#setMaxPos').value = S.settings.maxPos;
  $('#setBand').value = S.settings.band;
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
async function handleFile(f) {
  try {
    let parsed;
    if (f.name.toLowerCase().endsWith('.json')) {
      const j = JSON.parse(await f.text());
      parsed = { cash: j.cash, holdings: j.holdings, meta: j.meta };
    } else parsed = parseWorkbook(XLSX.read(await f.arrayBuffer(), { cellDates: false }));
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
  renderers[S.view]();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
$$('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.go); }));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
const seg = (id, key, fn) => $$(`#${id} button`).forEach((b) => b.addEventListener('click', () => { S[key] = b.dataset.v; $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b)); fn(); }));
seg('tmColor', 'tmColor', renderAllocation);
seg('secBasis', 'secBasis', () => renderSectorBars('chSector', S.secBasis));
seg('perfMode', 'perfMode', renderPerformance);
$('#hSearch').addEventListener('input', renderHoldings);
$('#hSector').addEventListener('change', renderHoldings);
$('#hExport').addEventListener('click', downloadMaster);
$('#rfInput').addEventListener('change', (e) => { const v = parseFloat(e.target.value); S.rf = isFinite(v) ? v / 100 : null; store.set('rf', S.rf); computeStats(); renderRisk(); });
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
const draftValid = () => { const bad = S.draft.holdings.find((h) => !h.ticker); if (bad) { toast('Every row needs a ticker'); return false; } return true; };
$('#useLocal').addEventListener('click', () => draftValid() && useLocal(S.draft));
$('#publishEdits').addEventListener('click', () => draftValid() && confirmPublish(S.draft, 'Edited holdings', () => { S.draft = null; }));
$('#loadHistory').addEventListener('click', loadHistory);
const saveSettings = () => { S.settings.name = $('#setName').value; S.settings.maxPos = parseFloat($('#setMaxPos').value) || 10; S.settings.band = parseFloat($('#setBand').value) || 5; store.set('settings', { name: S.settings.name, maxPos: S.settings.maxPos, band: S.settings.band }); };
['setName', 'setMaxPos', 'setBand'].forEach((id) => $('#' + id).addEventListener('change', saveSettings));
$('#setKey').addEventListener('change', (e) => store.sset('key', e.target.value));
$('#checkKey').addEventListener('click', async () => {
  if (!S.api) return toast('Needs the deployed site.');
  try { const r = await getJSON('/api/portfolio?check=1', { method: 'POST', headers: { 'x-admin-key': $('#setKey').value } }); toast(!r.configured ? 'No ADMIN_KEY set on the server yet' : r.ok ? '✓ Passcode works' : '✕ Wrong passcode'); }
  catch (e) { toast('Check failed: ' + e.message); }
});
$('#resetLocal').addEventListener('click', () => { store.del('localPortfolio'); S.base = S.master || S.seed; S.source = S.master ? 'master' : 'seed'; refreshAll(true); toast('Local copy cleared'); });

// ======================================================================
// Boot
// ======================================================================
(async function boot() {
  try {
    await loadPortfolio();
  } catch (e) {
    document.querySelector('main').innerHTML = `<div class="card"><div class="empty"><b>Couldn't load the portfolio</b>${esc(e.message)}</div></div>`;
    return;
  }
  S.trades = store.get('ticket', []);
  calc = computePortfolio(S.base, {});
  renderStatus();
  $('#scrChips').innerHTML = [...(S.base.watchlist || []), ...(S.base.focusList || [])].map((t) => `<button class="chip" data-t="${t}">${t}</button>`).join('') || '<span style="color:var(--muted);font-size:12px">—</span>';
  $$('#scrChips .chip').forEach((c) => c.addEventListener('click', () => analyze(c.dataset.t)));
  show(location.hash.slice(1) || 'overview');
  await loadMarket();
  refreshAll();
  setInterval(async () => { if (!document.hidden && S.api) { await loadMarket(); refreshAll(); } }, 5 * 60 * 1000);
})();

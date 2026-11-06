// Pure portfolio math — no DOM. Everything the dashboard shows is derived here.

export const CASH_LIKE = new Set(['SNOXX', 'CASH']);
export const SECTORS = [
  'Information Technology', 'Financials', 'Health Care', 'Communication Services', 'Consumer Discretionary',
  'Industrials', 'Consumer Staples', 'Energy', 'Materials', 'Utilities', 'Real Estate',
];

// Yahoo's sector names → GICS names used in the workbook
const YAHOO_TO_GICS = {
  Technology: 'Information Technology', 'Financial Services': 'Financials', Healthcare: 'Health Care',
  'Communication Services': 'Communication Services', 'Consumer Cyclical': 'Consumer Discretionary',
  Industrials: 'Industrials', 'Consumer Defensive': 'Consumer Staples', Energy: 'Energy',
  'Basic Materials': 'Materials', Utilities: 'Utilities', 'Real Estate': 'Real Estate',
};
export const toGics = (s) => YAHOO_TO_GICS[s] || s || 'Other';

const DAY = 86400000;

/** Combine the stored portfolio with live market data into display rows + totals. */
export function computePortfolio(port, market = {}, asOfDate = new Date()) {
  const rows = port.holdings.map((h) => {
    const m = market[h.ticker];
    const live = m && isFinite(m.price);
    const price = live ? m.price : h.price ?? h.avgCost ?? 0;
    const prev = live ? m.dayPrevClose ?? m.prevClose ?? h.prevClose : h.prevClose ?? price;
    const qty = +h.quantity || 0;
    const value = qty * price;
    const cost = qty * (+h.avgCost || 0);
    const days = h.purchaseDate ? Math.max(1, Math.round((asOfDate - new Date(h.purchaseDate)) / DAY)) : null;
    const ret = cost > 0 ? value / cost - 1 : null;
    return {
      ...h,
      price, prevClose: prev, live,
      value, cost,
      gl: value - cost,
      ret,
      dayChg: prev ? price / prev - 1 : null,
      dayGl: prev ? qty * (price - prev) : 0,
      days,
      annRet: ret != null && days ? ret / (days / 365.25) : null, // simple annualization, same as the workbook
      cagr: ret != null && days && days > 30 ? Math.pow(1 + ret, 365.25 / days) - 1 : null,
    };
  });
  const cash = +port.cash || 0;
  const total = rows.reduce((a, r) => a + r.value, 0) + cash;
  const equity = rows.filter((r) => r.assetClass === 'Equity');
  const eqValue = equity.reduce((a, r) => a + r.value, 0);
  const fiValue = rows.filter((r) => r.assetClass === 'Fixed Income').reduce((a, r) => a + r.value, 0);
  const mmValue = rows.filter((r) => r.assetClass === 'Money Market').reduce((a, r) => a + r.value, 0);
  const investedNonCash = eqValue + fiValue;
  rows.forEach((r) => {
    r.weight = total ? r.value / total : 0;
    r.weightExCash = investedNonCash && !CASH_LIKE.has(r.ticker) && r.assetClass !== 'Money Market' ? r.value / investedNonCash : null;
    r.weightEq = r.assetClass === 'Equity' && eqValue ? r.value / eqValue : null;
  });
  const sectors = {};
  equity.forEach((r) => {
    const s = r.sector || 'Other';
    sectors[s] = sectors[s] || { sector: s, value: 0, count: 0 };
    sectors[s].value += r.value;
    sectors[s].count++;
  });
  Object.values(sectors).forEach((s) => {
    s.wEq = eqValue ? s.value / eqValue : 0;
    s.wTotal = total ? s.value / total : 0;
  });
  const priced = rows.filter((r) => r.cost > 0);
  const costBasis = priced.reduce((a, r) => a + r.cost, 0);
  const mktOfPriced = priced.reduce((a, r) => a + r.value, 0);
  const dayGl = rows.reduce((a, r) => a + r.dayGl, 0);
  return {
    rows, cash, total, eqValue, fiValue, mmValue,
    cashLike: cash + mmValue,
    sectors,
    costBasis,
    unrealized: mktOfPriced - costBasis,
    unrealizedPct: costBasis ? mktOfPriced / costBasis - 1 : 0,
    dayGl,
    dayPct: total - dayGl ? dayGl / (total - dayGl) : 0,
    nEquity: equity.length,
  };
}

// ---------- return-series statistics ----------
export function dailyReturns(series) {
  const out = new Map();
  if (!series) return out;
  const { dates, closes } = series;
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) out.set(dates[i], closes[i] / closes[i - 1] - 1);
  return out;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function std(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1));
}
function cov(a, b) {
  const ma = mean(a), mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / Math.max(1, a.length - 1);
}

/** Core risk stats for a daily-return array, optionally against a benchmark array (same dates). */
export function statsFromReturns(r, bench, rf = 0.04) {
  if (!r || r.length < 20) return null;
  const vol = std(r) * Math.sqrt(252);
  let growth = 1;
  let peak = 1, maxDD = 0;
  const dd = [];
  for (const x of r) {
    growth *= 1 + x;
    peak = Math.max(peak, growth);
    const d = growth / peak - 1;
    maxDD = Math.min(maxDD, d);
    dd.push(d);
  }
  const annRet = Math.pow(growth, 252 / r.length) - 1;
  const downside = r.filter((x) => x < 0);
  const dVol = Math.sqrt(downside.reduce((a, x) => a + x * x, 0) / Math.max(1, r.length)) * Math.sqrt(252);
  const out = {
    vol, annRet, totalRet: growth - 1, maxDD, dd,
    sharpe: vol ? (annRet - rf) / vol : null,
    sortino: dVol ? (annRet - rf) / dVol : null,
    n: r.length,
  };
  if (bench && bench.length === r.length) {
    const vb = cov(bench, bench);
    out.beta = vb ? cov(r, bench) / vb : null;
    const corr = std(r) && std(bench) ? cov(r, bench) / (std(r) * std(bench)) : null;
    out.corr = corr;
    const bAnn = Math.pow(bench.reduce((g, x) => g * (1 + x), 1), 252 / bench.length) - 1;
    out.alpha = out.beta != null ? annRet - (rf + out.beta * (bAnn - rf)) : null; // Jensen's alpha
  }
  return out;
}

/** Stats for one symbol vs SPY using aligned dates. */
export function symbolStats(series, spySeries, rf) {
  if (!series || !spySeries) return null;
  const a = dailyReturns(series), b = dailyReturns(spySeries);
  const ra = [], rb = [];
  for (const [d, x] of a) if (b.has(d)) { ra.push(x); rb.push(b.get(d)); }
  const s = statsFromReturns(ra, rb, rf);
  if (!s) return null;
  const c = series.closes;
  const hi = Math.max(...c), lo = Math.min(...c);
  s.high52 = series.high52 || hi;
  s.low52 = series.low52 || lo;
  s.periods = periodReturns(series);
  return s;
}

/** 1D/5D/1M/3M/6M/YTD/1Y from a daily close series. */
export function periodReturns(series) {
  const { dates, closes } = series;
  const n = closes.length;
  if (n < 2) return {};
  const last = series.price ?? closes[n - 1];
  const back = (k) => (n - 1 - k >= 0 ? last / closes[n - 1 - k] - 1 : null);
  const yr = new Date().getFullYear();
  let ytdBase = null;
  for (let i = n - 1; i >= 0; i--) if (+dates[i].slice(0, 4) < yr) { ytdBase = closes[i]; break; }
  return {
    '1D': series.dayPrevClose ? last / series.dayPrevClose - 1 : back(1),
    '5D': back(5), '1M': back(21), '3M': back(63), '6M': back(126),
    YTD: ytdBase ? last / ytdBase - 1 : null,
    '1Y': last / closes[0] - 1,
  };
}

/**
 * Hypothetical daily returns of the portfolio *as it is weighted today*
 * (what you'd have earned holding these exact weights for the past year).
 * Cash & money-market earn rf/252 per day.
 */
export function portfolioSeries(calc, market, rf) {
  const spy = market.SPY;
  if (!spy) return null;
  const dates = spy.dates.slice(1);
  const rets = new Array(dates.length).fill(0);
  let covered = 0;
  const missing = [];
  const cashW = (calc.cash + calc.mmValue) / calc.total;
  calc.rows.forEach((r) => {
    if (r.assetClass === 'Money Market' || CASH_LIKE.has(r.ticker)) return;
    const s = market[r.ticker];
    if (!s || !s.dates) { missing.push(r.ticker); return; }
    covered += r.weight;
    const dr = dailyReturns(s);
    dates.forEach((d, i) => { rets[i] += r.weight * (dr.get(d) ?? 0); });
  });
  dates.forEach((_, i) => { rets[i] += cashW * (rf / 252); });
  const bench = dates.map((d) => dailyReturns(spy).get(d) ?? 0);
  return { dates, rets, bench, covered: covered + cashW, missing };
}

export function portfolioStats(calc, market, rf) {
  const ps = portfolioSeries(calc, market, rf);
  if (!ps) return null;
  const s = statsFromReturns(ps.rets, ps.bench, rf);
  if (!s) return null;
  s.series = ps;
  s.benchStats = statsFromReturns(ps.bench, ps.bench, rf);
  return s;
}

/** Weighted-average beta: Σ weight × beta (cash counts as beta 0). */
export function weightedBeta(calc, betas) {
  let b = 0;
  calc.rows.forEach((r) => { if (betas[r.ticker] != null) b += r.weight * betas[r.ticker]; });
  return b;
}

// ---------- trade simulation ----------
/**
 * Apply mock trades to a copy of the portfolio.
 * trade = { ticker, side: 'buy'|'sell', shares, price, name, sector, industry, assetClass, funding: 'cash'|'new' }
 */
export function applyTrades(port, trades) {
  const p = JSON.parse(JSON.stringify(port));
  const notes = [];
  for (const t of trades) {
    const amt = t.shares * t.price;
    let h = p.holdings.find((x) => x.ticker === t.ticker);
    if (t.side === 'buy') {
      if (h) {
        const q0 = +h.quantity;
        h.avgCost = (q0 * (+h.avgCost || 0) + amt) / (q0 + t.shares);
        h.quantity = q0 + t.shares;
        h.price = t.price;
      } else {
        h = {
          ticker: t.ticker, name: t.name || t.ticker, assetClass: t.assetClass || 'Equity',
          sector: t.sector || 'Other', industry: t.industry || '', quantity: t.shares,
          avgCost: t.price, price: t.price, prevClose: t.price, purchaseDate: new Date().toISOString().slice(0, 10),
        };
        p.holdings.push(h);
      }
      if (t.funding !== 'new') {
        let need = amt;
        const fromCash = Math.min(need, Math.max(0, p.cash));
        p.cash -= fromCash;
        need -= fromCash;
        const mm = p.holdings.find((x) => x.ticker === 'SNOXX');
        if (need > 0 && mm) {
          const px = mm.price || 1;
          const take = Math.min(need, mm.quantity * px);
          mm.quantity -= take / px;
          need -= take;
        }
        if (need > 0.005) { p.cash -= need; notes.push({ level: 'bad', text: `Not enough cash & money market to pay for ${t.ticker} — short by $${need.toLocaleString(undefined, { maximumFractionDigits: 0 })}.` }); }
      }
    } else {
      if (!h) { notes.push({ level: 'bad', text: `Can't sell ${t.ticker}: we don't own it.` }); continue; }
      const q = Math.min(t.shares, +h.quantity);
      if (t.shares > +h.quantity) notes.push({ level: 'bad', text: `Sell of ${t.ticker} capped at the ${h.quantity} shares we own.` });
      h.quantity = +h.quantity - q;
      p.cash += q * t.price;
      if (h.quantity <= 1e-9) p.holdings = p.holdings.filter((x) => x !== h);
    }
  }
  return { port: p, notes };
}

// ---------- formatting ----------
export const fmt = {
  usd: (v, d = 0) => (v == null || !isFinite(v) ? '—' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })),
  usdC: (v) => fmt.usd(v, 2),
  big: (v) => {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    return fmt.usd(v);
  },
  pct: (v, d = 1) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d) + '%'),
  spct: (v, d = 1) => { if (v == null || !isFinite(v)) return '—'; const t = (v * 100).toFixed(d); return (+t === 0 ? (0).toFixed(d) : (v > 0 ? '+' : '') + t) + '%'; },
  pts: (v, d = 1) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(d) + ' pts'),
  x: (v, d = 2) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d)),
  n: (v, d = 0) => (v == null || !isFinite(v) ? '—' : (+v).toLocaleString('en-US', { maximumFractionDigits: d })),
};
export const cls = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

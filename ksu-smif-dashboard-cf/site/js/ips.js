// SMIF Investment Policy Statement (IPS): the rules that can be checked for a single stock.
// Portfolio-wide rules (portfolio beta, sector weights, 75% US / large-cap totals) are checked on trades, not here.
export const IPS = {
  maxBeta: 2, // 2-year weekly adjusted beta
  minMktCap: 2e9,
  largeCap: 10e9, // the IPS doesn't define "large cap"; $10B+ is the usual definition
  minInitial: 0.01,
  smallBench: 0.02, // "stocks less than 2% of benchmark"
  smallMaxInitial: 0.03,
  bigExtra: 0.02, // ≥2% of benchmark: max initial = benchmark weight + 2%
  smallMaxHold: 0.05, // <2% of benchmark: never more than 5% of the fund
  trackBench: 0.04, // ≥4% of benchmark: stay within ±2%, rebalance beyond ±3%
  trackBand: 0.02, trackRebalance: 0.03,
  sectorTrade: 0.02, sectorRebalance: 0.03,
  portBeta: [0.9, 1.1],
  minHoldYears: 1, horizonYears: 3,
};

const DEVELOPED = /nasdaq|nyse|bats|cboe|toronto|tsx|london|lse|xetra|frankfurt|paris|euronext|amsterdam|brussels|lisbon|dublin|swiss|six |zurich|tokyo|osaka|sydney|asx|hong ?kong|singapore|milan|madrid|stockholm|oslo|copenhagen|helsinki|vienna|new zealand|tel aviv/i;
const NOT_DEVELOPED = /otc|pink|grey|other otc/i;

/** Weekly adjusted beta (Bloomberg style: 0.67 × raw + 0.33) from weekly adjusted closes vs SPY, last ~2 years. */
/** Plain (raw) OLS beta of period returns vs SPY over the last n periods, matched by date. */
export function regBeta(m, spy, n, minN = 24) {
  if (!m?.dates?.length || !spy?.dates?.length) return null;
  const sm = new Map(spy.dates.map((d, i) => [d, spy.closes[i]]));
  const pairs = [];
  for (let i = 1; i < m.dates.length; i++) {
    const a = sm.get(m.dates[i - 1]), b = sm.get(m.dates[i]);
    if (a && b && m.closes[i - 1] && m.closes[i]) pairs.push([m.closes[i] / m.closes[i - 1] - 1, b / a - 1]);
  }
  const p = pairs.slice(-n);
  if (p.length < minN) return null;
  const mx = p.reduce((t, x) => t + x[1], 0) / p.length, my = p.reduce((t, x) => t + x[0], 0) / p.length;
  let cov = 0, v = 0; p.forEach(([y, x]) => { cov += (x - mx) * (y - my); v += (x - mx) ** 2; });
  return { raw: cov / v, n: p.length, from: m.dates[m.dates.length - p.length - 1] };
}

export function weeklyAdjBeta(m, spy, weeks = 104) {
  if (!m?.dates?.length || !spy?.dates?.length) return null;
  const sm = new Map(spy.dates.map((d, i) => [d, spy.closes[i]]));
  const pairs = [];
  for (let i = 1; i < m.dates.length; i++) {
    const a = sm.get(m.dates[i - 1]), b = sm.get(m.dates[i]);
    if (a && b && m.closes[i - 1] && m.closes[i]) pairs.push([m.closes[i] / m.closes[i - 1] - 1, b / a - 1]);
  }
  const p = pairs.slice(-weeks);
  if (p.length < 52) return null;
  const mx = p.reduce((s, x) => s + x[1], 0) / p.length, my = p.reduce((s, x) => s + x[0], 0) / p.length;
  let cov = 0, v = 0; p.forEach(([y, x]) => { cov += (x - mx) * (y - my); v += (x - mx) ** 2; });
  const raw = cov / v;
  return { raw, adj: 0.67 * raw + 0.33, weeks: p.length };
}

/** Size limits for one stock, from its S&P 500 weight. */
export function sizeLimits(benchW) {
  const b = benchW || 0;
  const minInit = IPS.minInitial;
  const maxInit = b < IPS.smallBench ? IPS.smallMaxInitial : b + IPS.bigExtra;
  const maxHold = b < IPS.smallBench ? IPS.smallMaxHold : null; // 2–4%: no explicit cap beyond the initial rule
  const track = b >= IPS.trackBench ? { lo: b - IPS.trackBand, hi: b + IPS.trackBand, reLo: b - IPS.trackRebalance, reHi: b + IPS.trackRebalance } : null;
  return { minInit, maxInit, maxHold, track, benchW: b };
}

const fmtB = (v) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`);
const nice = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

/**
 * Stock-level IPS checks. status: 'pass' | 'fail' | 'warn' | 'info' | 'pending'
 * ctx: { spx, prof, m, held, firstBuy, beta, weightNow, total, price, today }
 */
export function stockChecks(ctx) {
  const { spx, prof, m, held, firstBuy, beta, weightNow, total, price } = ctx;
  const out = [];
  const add = (group, label, status, detail, tip) => out.push({ group, label, status, detail, tip });
  // --- eligibility ---
  const spxAt = out.length; // S&P line is filled in after the other three checks
  out.push(null);
  if (beta === undefined) add('Eligibility', '2-year weekly adjusted beta ≤ 2', 'pending', 'Calculating…', '');
  else if (beta === null) add('Eligibility', '2-year weekly adjusted beta ≤ 2', 'pending', 'Not enough price history', 'Needs about two years of weekly prices.');
  else add('Eligibility', '2-year weekly adjusted beta ≤ 2', beta.adj <= IPS.maxBeta ? 'pass' : 'fail', `${beta.adj.toFixed(2)} (raw ${beta.raw.toFixed(2)}, ${beta.weeks} weeks)`, 'The IPS measure: weekly returns vs the S&P 500 over the last 2 years, adjusted like Bloomberg (0.67 × raw beta + 0.33). It differs from the Beta tile below, which is the raw 5-year weekly beta.');
  const cap = prof?.marketCap ?? null;
  add('Eligibility', 'Market cap above $2B', cap == null ? (ctx.capFailed ? 'info' : 'pending') : cap > IPS.minMktCap ? 'pass' : 'fail', cap == null ? (ctx.capFailed ? 'Couldn\'t load right now — confirm on Bloomberg' : 'Loading…') : fmtB(cap) + (prof?.capNote === 'shares × last price' ? ' (shares × last price)' : ''), 'IPS: market cap > $2B.');
  const ex = m?.exchange || prof?.exchange || '';
  const dev = ex ? !NOT_DEVELOPED.test(ex) && DEVELOPED.test(ex) : null;
  add('Eligibility', 'Listed on a developed-market exchange', dev == null ? 'pending' : dev ? 'pass' : 'fail', ex || 'Exchange not available', 'IPS: must be traded on developed market exchanges (e.g. NYSE, Nasdaq, London, Toronto, Tokyo). OTC listings don\'t count.');
  // S&P 500 membership qualifies a company outright, but it isn't required: a non-member that meets
  // the other three eligibility rules can still be bought at the committee's discretion.
  const others = out.slice(spxAt + 1).map((c) => c.status);
  const SPX_TIP = 'Under the IPS, S&P 500 membership makes a company investable on its own. It is not a requirement: a company outside the index may still be considered if it meets the beta, market-cap and exchange criteria.';
  out[spxAt] = spx
    ? { group: 'Eligibility', label: 'In the S&P 500', status: 'pass', detail: `Index weight ${pct(spx.weight, 2)}`, tip: SPX_TIP }
    : others.includes('fail')
      ? { group: 'Eligibility', label: 'Not in the S&P 500', status: 'fail', detail: 'Outside the index and does not meet the other eligibility criteria below', tip: SPX_TIP }
      : others.includes('pending')
        ? { group: 'Eligibility', label: 'Not in the S&P 500', status: 'pending', detail: 'Outside the index — checking the other criteria…', tip: SPX_TIP }
        : { group: 'Eligibility', label: 'Not in the S&P 500', status: 'warn', detail: 'Meets the beta, market-cap and exchange criteria, so it remains eligible at the committee\'s discretion.', tip: SPX_TIP };
  // --- what it counts toward (portfolio minimums are checked on trades) ---
  const us = prof?.country ? /united states|^us$|usa/i.test(prof.country) : null;
  add('Counts toward', 'US company', us == null ? 'info' : us ? 'pass' : 'info', us == null ? 'Country not available' : us ? 'Counts toward the 75% US minimum' : `${prof.country} — doesn't count toward the 75% US minimum`, 'IPS: at least 75% of the fund in US companies.');
  add('Counts toward', 'Large cap ($10B+)', cap == null ? 'info' : cap >= IPS.largeCap ? 'pass' : 'info', cap == null ? '—' : cap >= IPS.largeCap ? 'Counts toward the 75% large-cap minimum' : `${fmtB(cap)} — mid cap, doesn't count toward the 75% large-cap minimum`, 'IPS: at least 75% in large caps. The IPS doesn\'t define large cap; $10B+ is used here.');
  // --- position size ---
  const L = sizeLimits(spx?.weight);
  const $ = (w) => (total ? ` ≈ $${Math.round(w * total).toLocaleString()}${price ? ` (${Math.floor((w * total) / price)} sh)` : ''}` : '');
  add('Position size', 'Allowed first purchase', 'info', `${pct(L.minInit, 0)}${$(L.minInit)} to ${pct(L.maxInit, 1)}${$(L.maxInit)}`, spx?.weight >= IPS.smallBench ? `Minimum 1%. Index weight is ${pct(spx.weight, 2)} (2% or more), so the maximum first purchase is the index weight + 2%.` : spx ? 'Minimum 1%. Index weight under 2%, so the maximum first purchase is 3%.' : 'Minimum 1%. Not in the index (0% benchmark weight), so the under-2% limits apply: maximum first purchase 3%, never more than 5% of the fund.');
  if (held && weightNow != null) {
    if (L.maxHold != null) add('Position size', 'Our weight ≤ 5% (index weight under 2%)', weightNow <= L.maxHold ? 'pass' : 'fail', `We hold ${pct(weightNow, 2)}`, 'IPS: no stock under 2% of the benchmark may be more than 5% of the fund.');
    if (L.track) {
      const inBand = weightNow >= L.track.lo && weightNow <= L.track.hi, mustRe = weightNow < L.track.reLo || weightNow > L.track.reHi;
      add('Position size', `Within ±2% of its ${pct(L.benchW, 1)} index weight`, inBand ? 'pass' : 'fail', `We hold ${pct(weightNow, 2)} (allowed ${pct(Math.max(0, L.track.lo), 1)}–${pct(L.track.hi, 1)})${mustRe ? ' · beyond ±3%: rebalance' : ''}`, 'IPS: stocks that are at least 4% of the benchmark must stay within ±2% of their index weight, and be rebalanced beyond ±3%.');
    }
  } else if (L.track) add('Position size', `Index heavyweight (${pct(L.benchW, 1)})`, 'info', `Once owned, keep within ${pct(Math.max(0, L.track.lo), 1)}–${pct(L.track.hi, 1)} of the fund`, 'IPS: stocks that are at least 4% of the benchmark must stay within ±2% of their index weight.');
  // --- holding period ---
  if (held && firstBuy) {
    const d1 = new Date(firstBuy); d1.setFullYear(d1.getFullYear() + IPS.minHoldYears);
    const d3 = new Date(firstBuy); d3.setFullYear(d3.getFullYear() + IPS.horizonYears);
    const now = ctx.today || new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    add('Holding period', 'Eligible to sell (held 1+ year)', now >= d1 ? 'pass' : 'warn', now >= d1 ? `Since ${nice(d1)}` : `Not until ${nice(d1)}, unless fundamentals shift significantly`, 'IPS: investment horizon of 3+ years; a position can be traded after 1 year if the company\'s fundamentals have shifted significantly.');
    add('Holding period', '3-year horizon reached', now >= d3 ? 'pass' : 'info', now >= d3 ? `Since ${nice(d3)}` : `On ${nice(d3)}`, 'IPS: investment horizon of 3+ years.');
  } else add('Holding period', 'Plan to hold 3+ years', 'info', 'Selling is allowed after 1 year if the fundamentals shift significantly', 'IPS: investment horizon of 3+ years.');
  return out;
}

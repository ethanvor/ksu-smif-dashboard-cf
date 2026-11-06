// Builds the fund's trading history from a Schwab "Transactions – All" export.
// Pure functions (no DOM) so the same code runs in the browser (upload) and in Node (seed file).

const ORDER = {
  Buy: 0, 'Credit Security': 1, 'Credit Security (Custodian Lot Adjustment)': 1, Split: 2,
  'Debit Security (Custodian Lot Adjustment)': 0, 'Debit Security': 0, Sell: 3,
};
const CASH_IN = new Set(['Sell', 'Deposit', 'Income (Qualified Dividend)', 'Income (Dividend)', 'Income (Non-Qualified Dividend)',
  'Income (Short Term Gain)', 'Income (Long Term Gain)', 'Return of Principal']);
const CASH_OUT = new Set(['Buy', 'Withdrawal', 'Expense (Foreign Tax Paid)', 'Expense (Other Expense)']);
const INCOME = new Set(['Income (Qualified Dividend)', 'Income (Dividend)', 'Income (Non-Qualified Dividend)', 'Income (Short Term Gain)',
  'Income (Long Term Gain)', 'Income (Reinvested Dividend)', 'Income (Reinvested Qualified Dividend)', 'Return of Principal']);
const SHARE_SIGN = {
  Buy: 1, Sell: -1, Split: 1, 'Credit Security': 1, 'Debit Security': -1,
  'Credit Security (Custodian Lot Adjustment)': 1, 'Debit Security (Custodian Lot Adjustment)': -1,
  'Income (Reinvested Dividend)': 1, 'Income (Reinvested Qualified Dividend)': 1,
};
export const DUST = 0.05; // fractional leftovers from old dividend reinvestment count as zero

const iso = (v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10); // Excel serial
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function label(act, note) {
  const n = String(note || '').toUpperCase();
  if (act === 'Buy') return 'Buy';
  if (act === 'Sell') return n.includes('CASH IN LIEU') ? 'Cash in lieu' : 'Sell';
  if (act === 'Split') return n.includes('STOCK DIVIDEND') ? 'Stock dividend' : 'Split';
  if (n.includes('SPINOFF') || n.includes('SPIN-OFF')) return 'Spin-off';
  if (n.includes('MERGER') || n.includes('ACQUISITION') || n.includes('TENDER')) return 'Merger';
  if (n.includes('NAME CHANGE') || n.includes('SYMBOL CHANGE') || n.includes('TICKER')) return 'Ticker change';
  if (act.startsWith('Income (Reinvested')) return 'Dividend reinvested';
  if (act.startsWith('Credit')) return 'Shares received';
  if (act.startsWith('Debit')) return 'Shares removed';
  return act;
}

/** Is this sheet a Schwab transaction export? (header row as array of strings) */
export function looksLikeTransactions(header) {
  const h = header.map((x) => clean(x).toLowerCase());
  return ['trade date', 'activity', 'symbol', 'quantity', 'amount'].every((k) => h.includes(k));
}

/**
 * rows: array of objects {date, activity, description, symbol, quantity, amount, notes}
 * returns the history document stored in the master copy / data/history.json
 */
export function buildHistory(rows, source = 'Transaction history') {
  const r = rows
    .map((x, i) => ({ ...x, i, day: iso(x.date), symbol: clean(x.symbol).toUpperCase(), q: +x.quantity || 0, amt: +x.amount || 0 }))
    .filter((x) => x.day && x.activity);
  // Export is newest-first: reverse for chronological order, keep same-day order sensible.
  r.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (ORDER[a.activity] ?? 2) - (ORDER[b.activity] ?? 2) || b.i - a.i));

  const S = {};
  const nameBy = {};
  let cash = 0;
  const cashSeries = [];
  const flows = [];
  const income = []; // dated dividends/interest net of fees — the fund's investment income
  const totals = { dividends: 0, realized: 0, foreignTax: 0, deposits: 0, withdrawals: 0, buys: 0, sells: 0, trades: 0 };
  const st = (sym) => (S[sym] = S[sym] || { ticker: sym, name: nameBy[sym] || sym, qty: 0, cost: 0, realized: 0, dividends: 0, foreignTax: 0, bought: 0, sold: 0, trades: [], periods: [], open: null });

  for (const x of r) {
    const { day, activity: act, symbol: sym, q, amt } = x;
    const desc = clean(x.description);
    if (sym && sym !== 'CASH' && desc) { nameBy[sym] = desc; if (S[sym] && (S[sym].name === sym || !S[sym].name)) S[sym].name = desc; }
    // cash ledger
    if (CASH_IN.has(act)) cash += amt;
    else if (CASH_OUT.has(act)) cash -= amt;
    if (sym === 'CASH' && act.startsWith('Income (Reinvested')) cash += amt;
    const inc = INCOME.has(act) || (sym === 'CASH' && act.startsWith('Income (Reinvested')) ? amt : act.startsWith('Expense') ? -amt : 0;
    if (inc) { const li = income[income.length - 1]; if (li && li[0] === day) li[1] = +(li[1] + inc).toFixed(2); else income.push([day, +inc.toFixed(2)]); }
    if (act === 'Deposit') { flows.push([day, amt]); totals.deposits += amt; }
    if (act === 'Withdrawal') { flows.push([day, -amt]); totals.withdrawals += amt; }
    const last = cashSeries[cashSeries.length - 1];
    if (last && last[0] === day) last[1] = +cash.toFixed(2); else cashSeries.push([day, +cash.toFixed(2)]);

    if (!sym || sym === 'CASH') {
      if (act === 'Expense (Foreign Tax Paid)') {
        totals.foreignTax += amt;
        const k = Object.keys(nameBy).find((s) => nameBy[s] === desc);
        if (k && S[k]) S[k].foreignTax += amt;
      }
      continue;
    }
    const s = st(sym);
    if (INCOME.has(act)) { s.dividends += amt; totals.dividends += amt; }
    const sign = SHARE_SIGN[act];
    if (sign == null || (q === 0 && act !== 'Split')) continue;
    const lotAdj = act.includes('Custodian Lot Adjustment');
    const cil = act === 'Sell' && String(x.notes || '').toUpperCase().includes('CASH IN LIEU'); // fractional share paid out in cash, not a trade
    const before = s.qty;
    if (sign > 0) {
      if (act === 'Buy' || act.startsWith('Income (Reinvested') || act.startsWith('Credit')) s.cost += amt;
      if (act === 'Buy') { s.bought += amt; totals.buys += amt; }
      s.qty += q;
    } else {
      const avg = s.qty > 1e-9 ? s.cost / s.qty : 0;
      const take = s.qty > 0 ? Math.min(q, s.qty) : q;
      if (act === 'Sell') {
        const g = amt - avg * take;
        s.realized += g; totals.realized += g;
        if (!cil) { s.sold += amt; totals.sells += amt; }
        s.cost -= avg * take;
      } else s.cost -= amt || avg * take;
      s.qty -= q;
      if (s.qty < 1e-9) s.cost = 0;
    }
    if (lotAdj) continue; // Schwab cost-basis resets: no change in what we own
    const type = label(act, x.notes);
    if (type === 'Dividend reinvested') continue; // tiny share amounts; shown in dividends instead
    if (type === 'Buy' || type === 'Sell') totals.trades++;
    s.trades.push({ date: day, type, shares: +q.toFixed(4), price: q && amt ? +(amt / q).toFixed(4) : null, amount: +amt.toFixed(2), after: +Math.max(0, s.qty).toFixed(4) });
  }
  Object.values(S).forEach((s) => {
    // holding periods from END-OF-DAY positions, so same-day spin-offs/ticker swaps don't split a period
    const eod = [];
    s.trades.forEach((t) => { if (eod.length && eod[eod.length - 1][0] === t.date) eod[eod.length - 1][1] = t.after; else eod.push([t.date, t.after]); });
    let prev = 0, open = null;
    eod.forEach(([d, q]) => {
      if (prev < DUST && q >= DUST) open = d;
      if (prev >= DUST && q < DUST && open) { s.periods.push({ from: open, to: d }); open = null; }
      prev = q;
    });
    if (open && s.qty >= DUST) s.periods.push({ from: open, to: null });
    delete s.open;
    s.avgCost = s.qty >= DUST ? +(s.cost / s.qty).toFixed(4) : null;
    ['qty', 'cost', 'realized', 'dividends', 'foreignTax', 'bought', 'sold'].forEach((k) => (s[k] = +s[k].toFixed(2)));
  });
  Object.keys(totals).forEach((k) => (totals[k] = +totals[k].toFixed(2)));
  const tickers = {};
  Object.values(S).filter((s) => s.trades.length).forEach((s) => (tickers[s.ticker] = s));
  return {
    source, from: r[0]?.day, to: r[r.length - 1]?.day, transactions: r.length, builtAt: new Date().toISOString(),
    cash: +cash.toFixed(2), cashSeries, flows, income, totals, tickers,
  };
}

/** Rows from a SheetJS worksheet (array-of-arrays with a header row). */
export function rowsFromSheet(aoa) {
  const hdr = aoa[0].map((x) => clean(x).toLowerCase());
  const ix = (k) => hdr.indexOf(k);
  const iD = ix('trade date'), iA = ix('activity'), iDe = ix('description'), iS = ix('symbol'), iQ = ix('quantity'), iAm = ix('amount'), iN = ix('notes');
  return aoa.slice(1).filter((row) => row[iD] != null && row[iA]).map((row) => ({
    date: row[iD], activity: clean(row[iA]), description: row[iDe], symbol: row[iS], quantity: row[iQ], amount: row[iAm], notes: iN >= 0 ? row[iN] : '',
  }));
}

/** Shares of `ticker` held at the end of `day` (from the trade log). */
export function sharesOn(h, day) {
  const t = h?.trades;
  if (!t || !t.length || day < t[0].date) return 0;
  let lo = 0, hi = t.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m].date <= day) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? 0 : t[ans].after;
}

/** Cash at the end of `day`. */
export function cashOn(hist, day) {
  const c = hist.cashSeries;
  let lo = 0, hi = c.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m][0] <= day) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? 0 : c[ans][1];
}

/** Tickers we held at any point on/after `day`. */
export function heldSince(hist, day) {
  return Object.values(hist.tickers).filter((s) => s.periods.some((p) => !p.to || p.to >= day)).map((s) => s.ticker);
}

"""Extract the SMIF workbook into the dashboard's seed JSON (site/data/portfolio.json)."""
import json, sys, datetime
import openpyxl

src, out = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src, data_only=True)


def num(v):
    return float(v) if isinstance(v, (int, float)) else None


def d(v):
    return v.strftime('%Y-%m-%d') if isinstance(v, datetime.datetime) else None


# ---------- Holdings (Portfolio tab) ----------
ws = wb['Portfolio']
holdings, cash, as_of = [], 0.0, None
section = 'Equity'
for r in ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True):
    name, tkr = r[0], r[1]
    if name == 'Equity':
        section = 'Fixed Income'; continue
    if name == 'Fixed Income':
        section = 'Money Market'; continue
    if name == 'Cash':
        cash = num(r[8]) or 0.0; continue
    if isinstance(r[4], datetime.datetime):
        as_of = d(r[4])
    if not tkr or not isinstance(tkr, str) or num(r[2]) is None:
        continue
    holdings.append({
        'ticker': tkr.strip().upper(),
        'name': (name or tkr).replace('  ', ' ').strip(),
        'assetClass': section,
        'sector': r[14] if section == 'Equity' else section,
        'industry': r[15] if section == 'Equity' else ('Treasury MMF' if section == 'Money Market' else 'Bond ETF'),
        'quantity': num(r[2]),
        'avgCost': num(r[6]) if section != 'Money Market' else 1.0,
        'price': num(r[4]),
        'prevClose': num(r[3]),
        'purchaseDate': d(r[16]),
    })

# ---------- Snapshot period returns (Stock History tab) ----------
ws = wb['Stock History']
periods = {'1D': ('D', 'F'), '5D': ('H', 'J'), '1M': ('L', 'N'), '3M': ('P', 'R'),
           '6M': ('T', 'V'), '1Y': ('X', 'Z'), 'YTD': ('AB', 'AD')}
returns = {}
for row in range(5, ws.max_row + 1):
    for p, (tc, cc) in periods.items():
        t, c = ws[f'{tc}{row}'].value, ws[f'{cc}{row}'].value
        if isinstance(t, str) and isinstance(c, (int, float)):
            returns.setdefault(t.strip().upper(), {})[p] = float(c)

# ---------- S&P 500 sector weights (Sheet1, labelled columns) ----------
ws = wb['Sheet1']
spx_sectors = {}
for row in ws.iter_rows(min_row=3, max_row=20, values_only=True):
    vals = [v for v in row]
    for i, v in enumerate(vals):
        if isinstance(v, str) and i + 1 < len(vals) and isinstance(vals[i + 1], float) and v not in spx_sectors \
                and v in {'Information Technology', 'Financials', 'Health Care', 'Consumer Discretionary',
                          'Communication Services', 'Industrials', 'Consumer Staples', 'Energy', 'Real Estate',
                          'Materials', 'Utilities'}:
            spx_sectors[v] = vals[i + 1]
            break

# ---------- S&P 500 constituents (DRAFT_SPX DATA cols T..X) ----------
ws = wb['DRAFT_SPX DATA']
spx = []
for row in range(4, ws.max_row + 1):
    t, n, w, s = ws[f'T{row}'].value, ws[f'U{row}'].value, ws[f'W{row}'].value, ws[f'X{row}'].value
    if isinstance(t, str) and isinstance(w, (int, float)):
        spx.append({'ticker': t.strip().upper(), 'name': n, 'weight': float(w), 'sector': s})

# ---------- Focus list / watchlist (Port View col D after the headers) ----------
ws = wb['Port View']
held = {h['ticker'] for h in holdings}
lists, mode = {'focus': [], 'watch': []}, None
for row in range(1, ws.max_row + 1):
    c = ws[f'C{row}'].value
    if c == 'Focus List': mode = 'focus'; continue
    if c == 'Watchlist': mode = 'watch'; continue
    t = ws[f'D{row}'].value
    if isinstance(t, str) and t.isupper() and 1 <= len(t) <= 6:
        if mode:
            lists[mode].append(t)
        elif t not in held:
            lists['watch'].append(t)

# Port & SPY daily snapshot
ws = wb['Portfolio']
snap = {}
for r in ws.iter_rows(min_row=50, max_row=ws.max_row, values_only=True):
    if r[2] in ('Port', 'SPY'):
        snap[r[2]] = {'value': num(r[4]), 'prev': num(r[5]), 'change': num(r[6])}

data = {
    'meta': {
        'fund': 'KSU Student Managed Investment Fund',
        'asOf': as_of,
        'source': 'SMIF_Portfolio_11-4.xlsx',
        'updatedAt': datetime.datetime.utcnow().isoformat() + 'Z',
        'updatedBy': 'Initial import from Excel',
        'version': 1,
    },
    'cash': cash,
    'holdings': holdings,
    'snapshotReturns': returns,
    'benchmark': {'name': 'S&P 500', 'sectorWeights': spx_sectors, 'snapshot': snap},
    'spxConstituents': spx,
    'watchlist': sorted(set(lists['watch']) - held),
    'focusList': sorted(set(lists['focus']) - held),
}
json.dump(data, open(out, 'w'), indent=1)
tot = sum(h['quantity'] * h['price'] for h in holdings) + cash
print('holdings', len(holdings), 'cash', cash, 'total', round(tot, 2), 'asOf', as_of)
print('spx sectors', len(spx_sectors), round(sum(spx_sectors.values()), 4), 'spx names', len(spx))
print('returns', len(returns), 'watch', data['watchlist'], 'focus', data['focusList'])
print('snap', snap)

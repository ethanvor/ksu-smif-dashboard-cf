// GET /api/market?symbols=AAPL,MSFT,SPY&range=1y
// Returns latest price + daily adjusted-close history for each symbol.
import { chart, cleanSymbol, json, pool } from '../lib/yahoo.mjs';

const RANGES = new Set(['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'ytd']);

export default async (req) => {
  const u = new URL(req.url);
  const symbols = [...new Set((u.searchParams.get('symbols') || '').split(',').map(cleanSymbol).filter(Boolean))].slice(0, 80);
  const range = RANGES.has(u.searchParams.get('range')) ? u.searchParams.get('range') : '1y';
  if (!symbols.length) return json({ error: 'Pass ?symbols=AAPL,MSFT' }, 400);
  const data = await pool(symbols, 8, (s) => chart(s, range));
  // Cache at the CDN for 5 minutes so 12 analysts opening the page don't hammer Yahoo.
  return json({ range, fetchedAt: new Date().toISOString(), data }, 200, {
    'cache-control': 'public, max-age=60',
    'netlify-cdn-cache-control': 'public, s-maxage=300, stale-while-revalidate=600',
  });
};

export const config = { path: '/api/market' };

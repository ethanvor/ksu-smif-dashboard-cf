// The shared MASTER copy of the SMIF portfolio, stored in Netlify Blobs.
//
//   GET  /api/portfolio                 -> current master (or {master:null} if never published)
//   GET  /api/portfolio?history=1       -> list of saved versions (newest first)
//   GET  /api/portfolio?version=<key>   -> one past version
//   PUT  /api/portfolio                 -> publish a new master  (header  x-admin-key: <ADMIN_KEY>)
//   POST /api/portfolio?check=1         -> verify a passcode without saving
//
// Anyone can READ. Only people with the passcode (set ADMIN_KEY in Netlify env vars) can WRITE.
import { getStore } from '@netlify/blobs';
import { json } from '../lib/yahoo.mjs';

const store = () => getStore({ name: 'smif-portfolio', consistency: 'strong' });

function authorized(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return false; // writes disabled until a passcode is configured
  const given = req.headers.get('x-admin-key') || '';
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function validate(p) {
  if (!p || typeof p !== 'object') return 'Body must be a portfolio object';
  if (!Array.isArray(p.holdings)) return 'holdings[] missing';
  if (p.holdings.length > 500) return 'Too many holdings';
  for (const h of p.holdings) {
    if (!h.ticker || typeof h.ticker !== 'string') return 'Every holding needs a ticker';
    if (!isFinite(+h.quantity)) return `Bad quantity for ${h.ticker}`;
  }
  if (!isFinite(+p.cash)) return 'cash must be a number';
  return null;
}

export default async (req) => {
  const u = new URL(req.url);
  const s = store();
  const noCache = { 'cache-control': 'no-store' };

  if (req.method === 'GET') {
    if (u.searchParams.get('history')) {
      const { blobs } = await s.list({ prefix: 'history/' });
      const items = blobs.map((b) => b.key).sort().reverse().slice(0, 100);
      const metas = await Promise.all(
        items.map(async (key) => {
          const m = await s.getMetadata(key);
          return { key, ...(m?.metadata || {}) };
        })
      );
      return json({ versions: metas }, 200, noCache);
    }
    const v = u.searchParams.get('version');
    if (v) {
      if (!v.startsWith('history/')) return json({ error: 'bad version key' }, 400);
      return json({ master: await s.get(v, { type: 'json' }) }, 200, noCache);
    }
    return json({ master: (await s.get('master', { type: 'json' })) || null, writable: !!process.env.ADMIN_KEY }, 200, noCache);
  }

  if (req.method === 'POST' && u.searchParams.get('check')) {
    return json({ ok: authorized(req), configured: !!process.env.ADMIN_KEY }, 200, noCache);
  }

  if (req.method === 'PUT') {
    if (!process.env.ADMIN_KEY) return json({ error: 'Writes are disabled: set ADMIN_KEY in Netlify environment variables.' }, 403);
    if (!authorized(req)) return json({ error: 'Wrong passcode' }, 401);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const err = validate(body);
    if (err) return json({ error: err }, 400);
    const prev = await s.get('master', { type: 'json' });
    const now = new Date().toISOString();
    body.meta = {
      ...(body.meta || {}),
      updatedAt: now,
      updatedBy: String(body.meta?.updatedBy || 'Admin').slice(0, 60),
      note: String(body.meta?.note || '').slice(0, 200),
      version: (prev?.meta?.version || 0) + 1,
    };
    // Keep the outgoing master in history so any change can be rolled back.
    const meta = { updatedAt: now, updatedBy: body.meta.updatedBy, note: body.meta.note, version: body.meta.version, holdings: body.holdings.length };
    await s.setJSON(`history/${now}`, body, { metadata: meta });
    await s.setJSON('master', body);
    return json({ ok: true, meta: body.meta }, 200, noCache);
  }

  return json({ error: 'Method not allowed' }, 405);
};

export const config = { path: '/api/portfolio' };

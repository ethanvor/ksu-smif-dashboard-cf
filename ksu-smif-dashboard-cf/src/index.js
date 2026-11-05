// Cloudflare Worker entry point: serves the website from ./site and routes /api/* to the server code.
// (The same handlers in /functions also work if this repo is ever deployed as a Cloudflare Pages project.)
import * as market from '../functions/api/market.js';
import * as profile from '../functions/api/profile.js';
import * as portfolio from '../functions/api/portfolio.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const context = { request, env, waitUntil: (p) => ctx.waitUntil(p) };
    try {
      if (url.pathname === '/api/market') return request.method === 'GET' ? await market.onRequestGet(context) : new Response('Method not allowed', { status: 405 });
      if (url.pathname === '/api/profile') return request.method === 'GET' ? await profile.onRequestGet(context) : new Response('Method not allowed', { status: 405 });
      if (url.pathname === '/api/portfolio') return await portfolio.onRequest(context);
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    // everything else: the static website
    return env.ASSETS.fetch(request);
  },
};

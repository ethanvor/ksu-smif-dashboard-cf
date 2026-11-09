# KSU SMIF Dashboard — Cloudflare version

Same dashboard as before. Only the hosting changed: **Cloudflare Pages** (free) instead of Netlify.

| Piece | Netlify version | Cloudflare version |
|---|---|---|
| Website files | `site/` | `site/` (unchanged) |
| Live prices / fundamentals | `netlify/functions/market.mjs`, `profile.mjs` | `functions/api/market.js`, `profile.js` |
| Master copy + trade history storage | Netlify Blobs | Cloudflare **KV** (binding `SMIF_KV`) |
| Officer passcode | env var `ADMIN_KEY` | secret `ADMIN_KEY` |
| Shared Yahoo code | `netlify/lib/yahoo.mjs` | `lib/yahoo.js` |

## Cost
**$0.** Cloudflare's free plan: unlimited requests and bandwidth for the website files, 100,000 function requests a day (the SMIF site uses roughly 10 per page view), and KV storage with 100,000 reads and 1,000 writes a day. Limits reset daily at midnight UTC, so the site is never paused for a month the way Netlify pauses it. Nothing needs a credit card.

Optional: a custom domain (e.g. `ksusmif.com`) is about $10–12 a year through Cloudflare Registrar.

## Setup (about 30 minutes, one time)

**1. Make a new GitHub repo.** This keeps the Netlify site untouched, and it uses zero Netlify credits, until the new one works.
   - github.com → **New repository** → name it `ksu-smif-dashboard-cf` → **Create**.
   - **Add file → Upload files**, then drag in the `site`, `functions` and `lib` folders and `README.md`, all in one upload, using Chrome. Check that the paths start with `site/`, `functions/` and `lib/`, then **Commit**.

**2. Create a free Cloudflare account** at dash.cloudflare.com/sign-up and verify your email.

**3. Create the storage (KV).**
   - In the dashboard: **Storage & Databases → KV → Create** (in some layouts it's under **Workers & Pages → KV**).
   - Name: `smif-data` → **Add**.

**4. Create the Pages project.**
   - **Workers & Pages → Create → Pages tab → Import an existing Git repository / Connect to Git**. If the screen offers a "Worker", look for the **Pages** option. We want Pages.
   - Authorize GitHub, pick `ksu-smif-dashboard-cf` → **Begin setup**.
   - Framework preset: **None**. Build command: *(leave empty)*. **Build output directory: `site`** → **Save and Deploy**.

**5. Connect storage and the passcode.** Open the project, then **Settings**:
   - **Bindings → Add → KV namespace**: Variable name **`SMIF_KV`** (exactly), namespace `smif-data` → **Save**.
   - **Variables and Secrets → Add**: Type **Secret**, Name **`ADMIN_KEY`**, Value = the officers' passcode → **Save**.

**6. Redeploy** so the settings take effect: **Deployments → ⋯ on the latest → Retry deployment**. Settings only apply to new deployments.

**7. Test** at `https://<project-name>.pages.dev`:
   - The header pill says **Live**.
   - **Master Copy → Settings → Test passcode** shows "✓ Passcode works".
   - Optional: drop the Schwab transaction export on Master Copy → **Publish history for everyone**. The site already includes the history through 11/4/2026.

**8. Switch over.** Share the new link with analysts. Once you're happy, delete the Netlify site (Netlify → Site configuration → Delete).

## Updating later
Any commit to the GitHub repo redeploys automatically (500 free builds a month). Holdings updates still happen on the site itself (Master Copy → upload → Publish) and don't need a deploy at all.

## Good to know
- **Publishing delay:** a newly published master copy can take up to about a minute to show for everyone, because KV copies data around the world.
- **Yahoo Finance** sometimes rate-limits cloud servers. The functions retry on Yahoo's backup server. If prices still don't load, the site shows workbook prices and keeps working. A free-key data provider (Financial Modeling Prep, Twelve Data) can be swapped into `lib/yahoo.js` if that ever becomes a pattern.
- **Logs:** Pages project → **Functions** tab → real-time logs, if something misbehaves.

## Moving your other sites (static sites)
For each site: **Workers & Pages → Create → Pages → Connect to Git →** pick its repo, then build settings:
- **Plain HTML/CSS/JS:** build command empty; output directory = the folder containing `index.html` (`/` if it's at the top).
- **Built with a framework** (Vite/React/Astro, etc.): pick the framework preset. It fills in the build command and output folder (usually `npm run build` → `dist`).

Things that work differently on Cloudflare:
- `_redirects` and `_headers` files work the same.
- `netlify.toml` settings are ignored: move headers to a `_headers` file.
- **Netlify Forms** don't exist on Cloudflare. Use a free form service (e.g. Formspree), or ask me for a small Pages Function.
- **Netlify Functions** need porting to `functions/` (like the SMIF ones).
- **Custom domain:** project → **Custom domains → Set up a domain**. If the domain's DNS is at Netlify, you'll add Cloudflare's records at your registrar. That usually takes minutes, occasionally a few hours.

## Scrappy AI (portfolio assistant)
- The **Ask Scrappy** button (bottom-right) opens a chat limited to the fund: holdings, history, risk, and whether a stock fits SMIF.
- For each question the dashboard gathers the fund data (holdings, sector weights vs S&P, risk stats, former holdings, recent trades) plus details on any company it recognizes, and sends it to `/api/scrappy` (`functions/api/scrappy.js`).
- Runs on **Cloudflare Workers AI** (Llama 3.1 8B) through the `"ai": { "binding": "AI" }` line in `wrangler.jsonc`. It's free up to Cloudflare's daily allowance (10,000 "neurons"), which works out to roughly 250–290 questions a day. The allowance resets at midnight UTC. Each device is limited to 40 questions a day.
- Guardrails (`lib/guard.js`): jailbreak / prompt-injection attempts ("ignore your instructions", "what's your system prompt", role-play, "developer mode", fake system messages, encoded text) and clearly unrelated requests are refused before reaching the AI, so they don't use the allowance. Earlier attempts are dropped from the chat history, role markers are stripped from the fund data, and answers that leak the instructions are replaced with a refusal. To adjust, edit the patterns in `lib/guard.js`.
- Optional, paid: to use OpenAI instead, add a **Secret** `OPENAI_API_KEY` and a **Variable** `OPENAI_MODEL` (a current model name from OpenAI's pricing page) under Settings → Variables and Secrets.
- To change how Scrappy behaves (scope, tone, the fund's rules), edit the `SYSTEM` text at the top of `functions/api/scrappy.js`.

## Price accuracy (Performance tab)
- Every stock's weekly price history is checked against the prices SMIF actually paid and received in the Schwab transaction history (median gap allowed: 10%). This catches missing data and old tickers that now belong to a different company.
- Order of sources: **Yahoo Finance** → **Tiingo** (second source, used only for stocks Yahoo is missing or gets wrong) → **estimated** from our own trade prices.
- To turn on Tiingo (free): sign up at tiingo.com, copy your API token (Profile → API → Token), then in Cloudflare open the `smif` app → Settings → Variables and Secrets → Add → Type **Secret**, Name `TIINGO_KEY`, paste the token → Deploy. Free plan: 500 different tickers a month, 50 requests an hour, 1,000 a day. Each ticker is fetched once and saved in KV forever, so this stays far under the limits.
- The "Price data check" card on the Performance tab lists where every price history came from.

## Easter egg
A little 8-bit owl (`site/js/owl.js`) flies a few laps around the screen: click the KSU logo in the header 3 times quickly. Click it while it flies for a hoot. It never appears for people who have reduced motion turned on.


## Handing over to the next managers — what to upload

Everything lives on **Master Copy** ("What can I upload?" card). Nothing is published until an officer reviews it and enters the passcode; every published version can be restored from Version history.

**1. After a trade — positions workbook**
- Easiest: Master Copy → **⬇ Current positions (upload format)**. It downloads today's holdings already filled in. Change the share counts / purchase price / cash, save, and drop it back in the upload box.
- Starting fresh: `site/templates/SMIF_Positions_Template.xlsx` (also linked on the page). Instructions are on its first tab.
- Required columns: **Ticker, Quantity**. Also read if present: Name, Current Price, Previous Close, Purchase Price (or Cost Basis), GICS Sector, GICS Industry, Purchase Date. Common alternative names work (Symbol, Shares, Avg Cost, Market Value).
- Layout: stocks, then an **Equity** subtotal row; bond ETFs, then a **Fixed Income** subtotal row; then the money-market fund and a **Cash** row (amount in Current Value). The old SMIF workbook layout still works as-is.
- The review pop-up lists every trade (old → new shares), checks the subtotals and cash, and warns if the file looks like the template's example rows or would sell out most of the fund.

**2. For history & performance — Schwab transaction history**
- Schwab → fund account → History → all transaction types, widest date range → Export (Excel or CSV). Upload it unchanged.
- Required columns (Schwab includes them): Trade Date, Activity, Symbol, Quantity, Amount (+ Description, Notes). Format sample: `site/templates/Schwab_Transactions_Sample.xlsx`.
- It reconciles share counts, first-bought dates and cash against the positions, then **Publish history for everyone**.

Order after a trade: positions first, then the transaction history.

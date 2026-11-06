# KSU SMIF Dashboard

A portfolio dashboard and trade simulator for the KSU Student Managed Investment Fund. It's a static website plus three small server functions on Netlify.

**What's in it**
- **Overview**: total AUM, today's change compared with the S&P 500, asset mix, a one-year backtest of SMIF against SPY, the day's biggest movers, the top 10 holdings, and sector weights compared with the S&P 500.
- **Weighting**: a treemap of every position, sector weights compared with the S&P 500, an over/under-weight chart, and a table of position weights.
- **Gain Since Buy**: each holding's return since purchase in % and $, annualized returns, holding period against return, and a heatmap of returns over 1D, 5D, 1M, 3M, 6M, YTD and 1Y.
- **Risk**: beta, volatility, Sharpe, Sortino, max drawdown, alpha and correlation, both for the whole portfolio and for each holding. The risk-free rate is set automatically from the 13-week T-bill yield (^IRX).
- **Holdings**: the full position list. You can search it, sort it and export it to Excel.
- **Screener & Trade Lab**: look up any ticker to see its fundamentals and risk numbers, then stack up mock buys and sells (by shares, by dollars or to a target weight). It shows how each trade would change position weights, sector tilt, cash, beta, volatility and Sharpe, and warns you when a trade breaks the position-size or sector limits. You can save a scenario, export it to Excel, or apply it to the master copy.
- **Master Copy**: one shared portfolio that everyone sees. Anyone can download it as Excel, upload a workbook to look at locally, or edit holdings. Officers with the passcode can publish changes, and every published version is saved so it can be restored.

---

## Deploy (about 10 minutes, free)

### Option A — GitHub + Netlify (recommended)
1. Create a new GitHub repo, e.g. `ksu-smif-dashboard`, and upload **the contents of this folder** (`netlify.toml` must be at the top level).
2. Go to [app.netlify.com](https://app.netlify.com) and choose **Add new site → Import an existing project → GitHub**, then pick the repo. Leave the build settings as they are, because `netlify.toml` already sets them.
3. **Set the admin passcode:** go to Site configuration → Environment variables → Add `ADMIN_KEY` = a passcode for officers only (make it long). Then redeploy.
4. Open the site. The status pill in the header turns green and says **Live** once prices load.

After that, any push to GitHub redeploys the site automatically.

### Option B — Netlify CLI
```bash
npm install -g netlify-cli
cd ksu-smif-dashboard
npm install
netlify login
netlify init            # create a new site
netlify env:set ADMIN_KEY "your-long-passcode"
netlify deploy --prod
```
To run it locally with working functions: `netlify dev` (opens http://localhost:8888).

> Netlify's drag-and-drop "Drop" uploader only publishes the static files, not the functions. The site will still work in **Snapshot** mode (workbook prices, with no live data and no shared master), so use Option A or B for the full version.

### Custom domain
In Netlify, go to Domain management → Add a domain (for example `smif.yourdomain.com`). You could also link to the site from your portfolio site.

---

## How the data works

| Piece | Where it lives | Who can change it |
|---|---|---|
| Live prices & history | Yahoo Finance, fetched by `/api/market` (cached for 5 minutes) | — |
| Fundamentals & ticker search | Yahoo Finance, fetched by `/api/profile` | — |
| **Master portfolio** | Netlify Blobs (the built-in key-value store), through `/api/portfolio` | Anyone with `ADMIN_KEY` |
| Version history | Netlify Blobs, saved automatically on every publish | Restore needs `ADMIN_KEY` |
| Starting data / fallback | `site/data/portfolio.json` (built from `SMIF_Portfolio_11-4.xlsx`) | Redeploy |
| Mock trades, saved scenarios, settings | Each analyst's own browser (localStorage) | That analyst |

**Order the site checks when it loads:** a local copy (only if an analyst chose "Use for me only"), then the master copy, then the shipped Excel import.

### Monthly / after-trade workflow
1. Update the Excel workbook as usual.
2. Go to **Master Copy → drop the workbook**. The site reads the **Portfolio** tab (or its own Holdings export) and shows what was added, removed or changed.
3. Click **Publish as master** and enter the passcode. Everyone sees the new version immediately.
4. To apply trades that were approved in the Trade Lab, open that scenario and click **Apply to master**.

### Analysts
- They don't need an account. Mock trades, scenarios and "local copies" stay in their own browser.
- To share a pitch, click **⬇ Excel** on the trade ticket. This produces a file with Trades, Summary, Sectors and Proposed Holdings tabs that can be imported back with **📂 Load → Import**.

---

## Notes & limits
- Yahoo Finance data is free but unofficial and delayed, so it's fine for education but isn't a trading feed. If Yahoo changes its API, the site falls back to the workbook snapshot, and only `netlify/lib/yahoo.mjs` would need updating.
- The risk metrics use **one year of daily returns at today's weights**. They're a backtest of the current portfolio, not the fund's actual track record.
- "Annualized" on the Gain Since Buy page uses the workbook's formula (return ÷ years held), so it overstates positions bought only weeks ago. The scatter chart uses compound annual growth and leaves out holdings held for under 90 days.
- The passcode is one shared secret. If you later want individual logins for each officer, add Netlify Identity or Supabase Auth in front of the `PUT` route.
- S&P 500 sector weights and constituent weights come from the workbook (Sheet1 and DRAFT_SPX DATA). Update them by uploading a new workbook export, or by re-running `tools/extract.py` and redeploying.

## Re-seeding from a new workbook (optional)
```bash
pip install openpyxl
python tools/extract.py "SMIF_Portfolio_MM-DD.xlsx" site/data/portfolio.json
```

## File map
```
netlify.toml                 build + functions config
package.json                 @netlify/blobs dependency
netlify/functions/market.mjs   GET /api/market   prices + 1y history
netlify/functions/profile.mjs  GET /api/profile  fundamentals + ticker search
netlify/functions/portfolio.mjs GET/PUT /api/portfolio  master copy + history
netlify/lib/yahoo.mjs        Yahoo Finance helpers
site/index.html              the app
site/js/app.js               views, screener, master-copy logic
site/js/analytics.js         portfolio math (beta, Sharpe, drawdown, trade sim)
site/js/bg3d.js              3D background (three.js, bundled)
site/vendor/                 ECharts + SheetJS (bundled so nothing depends on a CDN)
site/data/portfolio.json     data extracted from the workbook
```

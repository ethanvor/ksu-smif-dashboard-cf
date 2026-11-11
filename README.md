# KSU Student Managed Investment Fund — Portfolio Dashboard

**Live site:** [smif.ksusmif.workers.dev](https://smif.ksusmif.workers.dev) · **Fund:** [KSU Coles College SMIF](https://campus.kennesaw.edu/colleges-departments/coles/academics/economics/student-managed-investment-fund/index.php)

A portfolio analytics platform for Kennesaw State University's Student Managed Investment Fund: a student-run, $500K+ equity and fixed-income portfolio benchmarked to the S&P 500. It gives the fund's analysts and officers one place to track performance, check positions against the Investment Policy Statement (IPS), and test trade ideas before pitching them.

<!-- Tip: add screenshots here, e.g. ![Overview](docs/overview.png) -->

---

## What it does

| Area | What analysts get |
|---|---|
| **Overview** | Live portfolio value, day change, and SMIF vs S&P 500 performance with selectable and custom date ranges. |
| **Performance** | Calendar-year and trailing returns since 2009, split into total fund, equities (vs S&P 500), fixed income (vs AGG), and money market & cash (vs T-bills). |
| **Weighting** | GICS sector weights vs the S&P 500, over/underweight in percentage points, and the IPS ±2 / ±3 pt sector bands. |
| **Risk** | Beta, volatility, Sharpe, Sortino, max drawdown, correlation, and each holding's contribution to risk. |
| **Holdings & gains** | Every position by asset class, with cost basis, unrealized and realized gains, and holding periods. |
| **Stock screener & trade lab** | Look up any stock: price history up to 10 years, a head-to-head compare, an IPS eligibility checklist (✓ / ✗), and a mock trade ticket showing how a buy or sell would change sector weights, cash, beta, and IPS compliance. |
| **Scrappy AI** | A portfolio-only research assistant that answers questions like *"Have we ever owned Apple?"* or *"Which sectors are we most underweight?"* from the fund's own data. |
| **Master copy** | Officers upload the positions workbook or the Schwab transaction export. The site reconciles it, shows a trade-by-trade review, and publishes after passcode approval, with version history. |

## Highlights

- **Performance rebuilt from source records.** Returns are time-weighted and reconstructed from 3,000+ Schwab transactions back to 2009. That covers every buy, sell, dividend, stock dividend, cash-in-lieu payment, and money-market distribution, so contributions and withdrawals don't distort results.
- **Data validation.** Each market price history is checked against the prices the fund actually traded at in Schwab. Histories that don't match are replaced from a second market-data provider, and positions that no longer trade publicly are reconstructed from the fund's own trade prices.
- **Investment Policy Statement built in.** IPS rules (beta limits, market cap, S&P 500 eligibility, position sizing, sector bands, holding period) are encoded once and applied consistently across the screener, trade lab, weighting view, and AI assistant.
- **Guardrailed AI.** Scrappy runs on Cloudflare Workers AI and is limited to the fund's data:
  - prompt-injection detection;
  - output checks for leaked instructions;
  - per-user and daily usage caps;
  - fund-specific rules (for example, the fund is tax-exempt, so the assistant never discusses tax).
- **Built for handoff.** Upload templates, a pre-filled "current positions" export, and in-app guidance let future fund managers keep the site current without touching code.
- **Polished front end.** Responsive from 320 px phones to wide desktops, light and dark themes, accessible pop-ups and keyboard support, and a small KSU easter egg.

## Tech stack

- **Front end:** HTML, CSS, vanilla JavaScript (ES modules), [Apache ECharts](https://echarts.apache.org/) for charts, [SheetJS](https://sheetjs.com/) for reading and writing Excel files.
- **Back end:** [Cloudflare Workers](https://workers.cloudflare.com/) (serverless API plus static assets), Workers KV for storage and caching, Workers AI for the assistant.
- **Data sources:** Yahoo Finance (prices and fundamentals), Tiingo (secondary price history), SEC EDGAR (shares outstanding fallback), Schwab exports (positions and transactions).
- **Testing:**
  - Playwright browser tests: functional, mobile-layout, and chart-text overflow checks across 7 screen sizes and both themes.
  - Node unit tests for the analytics, IPS rules, and AI guardrails.

## Architecture

```
Browser (static site)                 Cloudflare Worker  (/api/*)
├─ index.html, css/, js/              ├─ /api/market     price history (Yahoo, cached)
│  ├─ app.js        UI & views        ├─ /api/prices     secondary price history (Tiingo, cached in KV)
│  ├─ analytics.js  returns, risk     ├─ /api/profile    fundamentals + market cap fallback chain
│  ├─ history.js    Schwab → history  ├─ /api/portfolio  master copy: read / publish (passcode)
│  ├─ ips.js        IPS rules         └─ /api/scrappy    AI assistant (Workers AI + guardrails)
│  └─ gics.js       GICS mapping
└─ data/  shipped portfolio + history snapshot
```

## Repository layout

```
ksu-smif-dashboard-cf/
├─ site/          static front end (served as Worker assets)
├─ src/index.js   Worker entry and API router
├─ functions/api/ API handlers
├─ lib/           shared server code (Yahoo client, AI guardrails)
├─ wrangler.jsonc Cloudflare configuration
└─ README.md      setup, deployment and handoff guide for fund officers
```

Setup, deployment, secrets, and the officer handoff guide are in [`ksu-smif-dashboard-cf/README.md`](ksu-smif-dashboard-cf/README.md).

## About

Developed by **Ethan Voraotsady**, Managing Director of the KSU Student Managed Investment Fund and Finance BBA candidate at Kennesaw State University.

[LinkedIn](https://www.linkedin.com/in/voraotsady/) · [GitHub](https://github.com/EthanVor)

*Educational project for the KSU SMIF. Nothing on the site is investment advice.*

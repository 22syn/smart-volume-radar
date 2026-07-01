# Lean Radar Dashboard

Cloudflare Pages app over D1 (`lean-radar`). Data from the Lean Radar daily scan.

## Secrets (GitHub Actions)
- `CF_API_TOKEN` — Cloudflare token, permission: Account › D1 › Edit
- `CF_ACCOUNT_ID` — Cloudflare account id
- `D1_DATABASE_ID` — `lean-radar` database id (from `wrangler d1 create`)

## Schema:  `wrangler d1 execute lean-radar --remote --file schema.sql`
## Seed:    `npx tsx scripts/seed.ts ../results`
## Deploy:  `wrangler pages deploy public --project-name lean-dashboard`
## Access:  Cloudflare Zero Trust → Access → email allowlist (Kobi + friend).

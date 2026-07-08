-- Adds the run timestamp to every ingested row.
-- Apply to prod D1 (radar-dashboard) once, before deploying the ingest that writes it:
--   npx wrangler d1 execute <db-name> --remote --file=migrations/0002_add_ingested_at.sql
ALTER TABLE lean_signals ADD COLUMN ingested_at TEXT;

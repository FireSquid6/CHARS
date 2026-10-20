# Site notes

For Bun setup, persistent local SQLite, ingestion, backup/restore, and **single-host
systemd deployment**, see the [root README](../README.md) and [`deploy/` units](../deploy/).
Next.js and the scheduled workers share one durable SQLite file on the same host. Do
not deploy this site alone to ephemeral serverless storage or run independent writable
database replicas.

## Published snapshot JSON

`GET /api/seasons/2020/snapshots/2020%3Aselection-final` returns the current published
revision; append `?revision=1` for a specific published historical revision. The response
includes coverage and policy, pinned game-revision references, ranking records and
selection routes, stored head-to-head graph/SCC audit and swaps, and fixed bracket slots
and matchups. Revisions published before migration 011 have `auditAvailable: false` and
null graph/claims; the endpoint does not infer their history from corrected live games.
It never returns raw ingestion payloads, credentials, or a recomputed selection. If
migration 011 has not been applied, the endpoint returns a migration-required 503;
run `bun run db:migrate` with the site and workers stopped after a verified backup.

## Synthetic browser acceptance

From the repository root, use a **new** path under `/tmp/opencode/` (the fixture refuses
an existing file), then run the site against only that file:

```bash
DATABASE_PATH=/tmp/opencode/chars-browser-unique.db bun site/tests/browser-fixture.ts
cd site
DATABASE_PATH=/tmp/opencode/chars-browser-unique.db NEXT_DIST_DIR=.next-fixture bun run dev -- --port 3199
# In another shell, from the repository root:
SYNTHETIC_BROWSER_URL=http://localhost:3199 bun test site/tests/browser.integration.test.ts
```

`NEXT_DIST_DIR` keeps the fixture server separate from any existing Next dev server.
Check `/` → `/seasons/2020`, click Older and a status bubble, use browser Back and the
week selector, then inspect the final bracket at mobile width and focus the scrollable
rankings table with Tab. The Bun integration test checks server-rendered HTML and JSON;
manual browser checks cover actual navigation and viewport. Verify Tab/Enter in a browser
with keyboard-event support.

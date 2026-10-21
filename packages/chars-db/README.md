# chars-db

PostgreSQL schema and Bun SQL / Drizzle connection for the existing `cfbdb` database. The database is the source of truth: **this package does not create tables or run migrations**. The old SQLite migrations were removed; do not apply them to `cfbdb`.

Set `DATABASE_URL` to a PostgreSQL connection string for `cfbdb`, then run `bun run typecheck` and `bun test`. For a local peer-authenticated server, set `DATABASE_SOCKET` to the full Unix socket filename (for example, `/path/to/.s.PGSQL.5432`) as well as a URL containing the matching user and database name. `TEST_DATABASE_URL` can override the test connection. Database integration tests perform read-only queries and skip without a configured connection.

```ts
import { openDatabase, teams } from "chars-db";

const connection = openDatabase();
try {
  console.log(await connection.db.select().from(teams).limit(10));
} finally {
  await connection.close();
}
```

The schema mirrors the existing tables `teams`, `conferences`, `seasons`, `games`, `poll_releases`, `poll_entries`, `poll_team_names`, and the read-only `poll_rankings` view. Columns use camelCase in TypeScript and snake_case in PostgreSQL. Game dates are Unix milliseconds (`bigint` in PostgreSQL, `number` in Drizzle); poll dates are nullable SQL `date` values (`YYYY-MM-DD` strings). `game_id` is a generated bigint identity. `games.game_type` is nullable: `regular`, `ccg`, `playoff`, `bowl`, or `NULL` (unknown). The archive currently contains predominantly regular-season games; this classification does not insert missing postseason games.

The migration in `sql/add-game-type.sql` was applied to the local `cfbdb` as `firesquid` on 2026-10-21 in an explicit read-write transaction (the database defaults to read-only). An ignored, local-only `one-off/` backfill matched game IDs against a pinned [cfbfastR-data schedules](https://github.com/sportsdataverse/cfbfastR-data/tree/main/schedules/csv) snapshot. Of 37,614 existing games, 36,889 matched source games classified `regular`; 725 unmatched games remain `NULL`. No CCG, playoff, or bowl games were already present to classify. The one-off scripts are not shipped with this package. The CLI reader credentials cannot perform database changes. Existing CLI ranking and archive queries are unchanged because the archive currently contains no non-regular games; if non-regular games are added later, update those queries to filter `game_type` explicitly.

Before changing these definitions, inspect the live database schema. Do not run `drizzle-kit generate` or `migrate` against it; the existing database has its own schema history.

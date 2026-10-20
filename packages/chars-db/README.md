# chars-db

SQLite database package using Drizzle ORM and Bun's built-in SQLite driver.

From this directory:

```sh
bun install
DATABASE_PATH=/absolute/path/to/chars.sqlite bun run db:migrate
bun run typecheck
bun test
```

The parent directory of the database must already exist. `DATABASE_PATH` defaults
to `chars.sqlite` in the process working directory. From the repository root,
`bun run db:migrate` also applies migrations.

```ts
import { openDatabase, teams } from "chars-db";

const connection = openDatabase();
try {
  connection.db.insert(teams).values({
    teamId: "example",
    teamName: "Example University",
    abbreviation: "EXU",
  }).run();
  console.log(connection.db.select().from(teams).all());
} finally {
  connection.close();
}
```

## Schema

- `teams` and `conferences`: string primary keys.
- `seasons`: team/year composite primary key, conference foreign key, nullable
  division, and checked `FBS | FCS | DIV2 | DIV3` classification.
- `games`: integer primary key, team foreign keys, year/week, kickoff date,
  nullable scores and overtime count. Store **only regular-season games**; callers
  must exclude postseason games before insertion. Equal scores support ties;
  null scores must not be interpreted as a completed 0–0 tie.
- `pollReleases`: string `releaseId` primary key and string `pollId` (e.g. `AP`
  or `CFP`), year/week and release date. No separate polls table is required.
- `pollEntries`: release/team composite primary key and positive rank. Shared
  ranks are allowed for tied poll positions.

TypeScript fields use camelCase; SQLite columns use snake_case. Both date fields
accept/return `Date` values and are stored as UTC Unix milliseconds. All fields
are required except division and game scores/overtimes. Foreign keys are enabled
on every connection, along with WAL and a five-second busy timeout.

Import tables and inferred select/insert types from `chars-db` or
`chars-db/schema`. Opening a connection does not run migrations. To migrate
programmatically, import `migrateDatabase` from `chars-db/migrate`.

After schema edits, run `bun run db:generate` and commit the generated SQL and
metadata, then run `bun run db:migrate`. This initial schema targets a new
database; it does not convert databases from the previous application schema.

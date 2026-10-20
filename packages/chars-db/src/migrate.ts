import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDatabase } from "./database";

export function migrateDatabase(path?: string) {
  const connection = openDatabase(path);
  try {
    migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
  } finally {
    connection.close();
  }
}

if (import.meta.main) {
  migrateDatabase();
  console.log("Database migrations applied.");
}

import { expect, test } from "bun:test";
import { createProgram } from "../src/main";

test("Commander exposes the archive commands without connecting for help", async () => {
  let output = "";
  const program = createProgram();
  program.exitOverride().configureOutput({ writeOut: (text) => { output += text; } });
  try { await program.parseAsync(["node", "chars", "--help"]); } catch { /* Commander exits after help. */ }
  expect(output).toContain("standings <year>");
  expect(output).toContain("sql <query>");
});

test("invalid years fail before opening the database", async () => {
  const program = createProgram();
  const standings = program.commands.find((command) => command.name() === "standings")!;
  standings.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  expect(standings.parseAsync(["node", "standings", "2025junk"])).rejects.toThrow("year must be four digits");
});

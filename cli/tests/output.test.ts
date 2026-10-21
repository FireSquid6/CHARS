import { expect, test } from "bun:test";
import { render } from "../src/output";

test("renders empty results without inventing data", () => {
  expect(render([], "table")).toBe("No results.");
  expect(render([], "json")).toBe("[]");
  expect(render([], "csv", ["team", "wins"])).toBe("team,wins");
});

test("renders CSV with escaped values and empty nulls", () => {
  expect(render([{ team: 'A, "B"', wins: null }, { team: "C\nD", wins: 10 }], "csv"))
    .toBe('team,wins\n"A, ""B""",\n"C\nD",10');
});

test("renders table columns and JSON bigints", () => {
  expect(render([{ team: "Long name", wins: 12 }], "table", ["team", "wins"]))
    .toBe("team       wins\n---------  ----\nLong name  12");
  expect(render([{ count: 12n }], "json")).toBe('[\n  {\n    "count": "12"\n  }\n]');
});

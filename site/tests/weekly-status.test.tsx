import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { openDatabase } from "../../packages/chars-db/src/index";
import { migrate } from "../../packages/chars-db/src/migrate";
import { POLL_MODEL_VERSION, SOLVER_VERSION } from "../../packages/chars-algorithm/src/index";
import { getSeasonData } from "../lib/season-data";
import { filterByStatus, statusHref } from "../lib/weekly-status";
import SeasonPage from "../app/seasons/[year]/page";
import { StatusBubbles } from "../app/seasons/[year]/weekly-status";
import type { WeeklyStatuses } from "../lib/weekly-status";

const original = process.env.DATABASE_PATH;
const dirs: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = original;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("all four filters are keyboard-native links with counts, not a fifth status", () => {
  const statuses: WeeklyStatuses = Object.fromEntries(["eliminated", "needs_help", "controls_destiny", "clinched", "pending"]
    .map((label, index) => [String(index), { label: label === "pending" ? null : label,
      state: label === "pending" ? "pending" : null, assumptions: [], pollDependent: false, path: null }])) as WeeklyStatuses;
  const html = renderToStaticMarkup(<StatusBubbles base="/seasons/2020" week="2020:week:1" search="Al"
    view="eligible" active={null} statuses={statuses} total={5} />);
  for (const label of ["Eliminated", "Needs help", "Controls destiny", "Clinched"]) {
    expect(html).toContain(`Show ${label} teams (1)`);
  }
  expect(html).toContain("1 unclassified team");
  expect((html.match(/class="status-bubble /g) ?? [])).toHaveLength(4);
  expect(html).toContain("q=Al&amp;view=eligible&amp;status=clinched");
  expect(html).not.toContain("onclick=");
});

test("weekly certificates require current revision, input hash, generation and solver model; filters preserve URL", async () => {
  const dir = mkdtempSync("/tmp/opencode/chars-status-"); dirs.push(dir);
  process.env.DATABASE_PATH = join(dir, "data.db");
  const db = openDatabase({ path: process.env.DATABASE_PATH });
  try {
    await migrate(db);
    db.query("INSERT INTO seasons (year,state,calendar_policy_version) VALUES (2020,'final','test')").run();
    db.query("INSERT INTO season_input_generations (season,generation) VALUES (2020,1)").run();
    db.query("INSERT INTO teams (id,name) VALUES ('A','Alpha'),('B','Beta'),('C','Gamma')").run();
    db.query("INSERT INTO team_seasons (season,team_id,membership) VALUES (2020,'A','fbs'),(2020,'B','fbs'),(2020,'C','fbs')").run();
    db.query(`INSERT INTO snapshots (snapshot_key,revision,season,week,kind,game_cutoff_utc,input_hash,
      policy_version,model_version,calendar_policy_version,coverage_json,published_at_utc)
      VALUES ('2020:week:1',1,2020,1,'week_final','2020-09-01T00:00:00.000Z','input1','policy','model','calendar',
      '{"complete":true,"reasons":[]}','2020-09-02T00:00:00.000Z')`).run();
    db.query(`INSERT INTO snapshot_publications (snapshot_key,revision,published_at_utc,state)
      VALUES ('2020:week:1',1,'2020-09-02T00:00:00.000Z','current')`).run();
    for (const [id, rank] of [["A", 1], ["B", 2], ["C", 3]] as const) db.query(`INSERT INTO snapshot_rankings
      (snapshot_key,snapshot_revision,team_id,wins,losses,ties,rating,residual,precision_method,colley_rank,eligible,original_route,final_category)
      VALUES ('2020:week:1',1,?,0,0,0,.5,0,'double',?,0,'outside','outside')`).run(id, rank);
    const hash = "scenario-input";
    const id = createHash("sha256").update(JSON.stringify(["2020:week:1", 1, POLL_MODEL_VERSION, SOLVER_VERSION, hash])).digest("hex");
    db.query(`INSERT INTO scenario_jobs (id,snapshot_key,snapshot_revision,poll_model_version,solver_version,input_hash,
      input_generation,state,created_at_utc,updated_at_utc) VALUES (?,'2020:week:1',1,?,?,?,1,'proved','2020-09-02','2020-09-02')`)
      .run(id, POLL_MODEL_VERSION, SOLVER_VERSION, hash);
    const status = db.query(`INSERT INTO scenario_statuses (job_id,team_id,state,label,assumptions_json,proof_metadata_json)
      VALUES (?,?,'proved',?,?,?)`);
    const assumptions = JSON.stringify(["fixed remaining included regular-season schedule", "all eligible poll orders"]);
    status.run(id, "A", "needs_help", assumptions, JSON.stringify({ snapshotInputHash: "input1", pollDependent: true }));
    status.run(id, "B", "eliminated", assumptions, JSON.stringify({ snapshotInputHash: "old-input" }));
    db.query(`INSERT INTO scenario_witnesses (job_id,team_id,kind,sequence,witness_json) VALUES (?, 'A','qualifying_win_out',1,?)`)
      .run(id, JSON.stringify({ kind: "qualifying_win_out", gameOutcomes: { game1: "home" }, pollOrderTeamIds: ["A", "B"] }));
    const data = getSeasonData(2020, "2020:week:1");
    expect(data.statuses.A).toMatchObject({ label: "needs_help", pollDependent: true,
      path: { outcomes: { game1: "home" }, winOut: true } });
    expect(data.statuses.B?.label).toBeNull();
    expect(data.statuses.C?.state).toBe("pending");
    expect(filterByStatus(data.rankings, data.statuses, "needs_help").map(t => t.name)).toEqual(["Alpha"]);
    const url = statusHref("/seasons/2020", "2020:week:1", "Al", "eligible", "needs_help");
    expect(new URL(url, "http://localhost").searchParams.get("status")).toBe("needs_help");
    expect(url).toContain("view=eligible");
    const html = renderToStaticMarkup(await SeasonPage({ params: Promise.resolve({ year: "2020" }),
      searchParams: Promise.resolve({ week: "2020:week:1", status: "needs_help" }) }));
    expect(html).toContain("aria-label=\"Alpha: Needs help\"");
    expect(html).toContain("Poll-dependent:");
    expect(html).toContain("One possible path");
    expect(html).toContain("2 unclassified teams");
    expect(html).toContain("aria-current=\"true\"");
    expect(html).toContain("<summary>Why needs help?</summary>");
    expect(html).toContain("<nav class=\"status-bubbles\"");
    expect(html).not.toContain("tabindex=\"-1\"");
    expect(html).toContain("href=\"/seasons/2020?week=2020%3Aweek%3A1");
    db.query("UPDATE scenario_statuses SET state='unsupported',label=NULL,proof_metadata_json=? WHERE job_id=? AND team_id='B'")
      .run(JSON.stringify({ snapshotInputHash: "input1", exception: "policy/model review required" }), id);
    expect(getSeasonData(2020, "2020:week:1").statuses.B?.state).toBe("unsupported");
    db.query("UPDATE scenario_statuses SET state='proved',label='eliminated' WHERE job_id=? AND team_id='B'").run(id);
    db.query(`INSERT INTO snapshots (snapshot_key,revision,season,week,kind,game_cutoff_utc,input_hash,
      policy_version,model_version,calendar_policy_version,coverage_json,published_at_utc)
      VALUES ('2020:selection-final',1,2020,14,'selection_final','2020-11-29T00:00:00.000Z','final',
      'policy','model','calendar','{"complete":true,"reasons":[]}','2020-12-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO snapshot_publications (snapshot_key,revision,published_at_utc,state)
      VALUES ('2020:selection-final',1,'2020-12-01T00:00:00.000Z','current')`).run();
    const final = renderToStaticMarkup(await SeasonPage({ params: Promise.resolve({ year: "2020" }),
      searchParams: Promise.resolve({ week: "2020:selection-final", status: "needs_help" }) }));
    expect(final).not.toContain("status-bubbles");
    expect(final).not.toContain("Playoff status</th>");
    db.query("UPDATE season_input_generations SET generation=2 WHERE season=2020").run();
    expect(getSeasonData(2020, "2020:week:1").statuses.A?.label).toBeNull();
    db.query("UPDATE season_input_generations SET generation=1 WHERE season=2020").run();
    db.query("UPDATE snapshot_publications SET state='stale' WHERE snapshot_key='2020:week:1'").run();
    expect(getSeasonData(2020, "2020:week:1").statuses.A?.label).toBeNull();
  } finally { db.close(); }
});

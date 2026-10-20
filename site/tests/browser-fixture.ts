/** Hand-authored UI fixture only; rankings and scenario labels are not mathematical proofs. */
import { closeSync, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { migrate } from "../../packages/chars-db/src/migrate";
import { openDatabase } from "../../packages/chars-db/src/index";
import { POLL_MODEL_VERSION, SOLVER_VERSION } from "../../packages/chars-algorithm/src/index";

const path = process.env.DATABASE_PATH;
const parent = "/tmp/opencode";
if (!path || !isAbsolute(path) || dirname(path) !== parent ||
  realpathSync(parent) !== parent || !/^[A-Za-z0-9_-]+\.(?:db|sqlite)$/.test(basename(path)) ||
  path !== join(parent, basename(path)))
  throw new Error("Set DATABASE_PATH to a new .db/.sqlite file directly under canonical /tmp/opencode/");
// O_EXCL refuses existing files and symlinks atomically. Sticky parent prevents another
// user from replacing our owned file before SQLite opens it; keep fd to verify identity.
const claim = openSync(path, "wx", 0o600);
let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase({ path });
  const claimed = fstatSync(claim), opened = statSync(path);
  if (claimed.dev !== opened.dev || claimed.ino !== opened.ino) throw new Error("Fixture path changed during creation");
} finally { closeSync(claim); }
try {
  await migrate(db);
  db.query("INSERT INTO seasons VALUES (2020,'final',NULL,'pre-ccg-weekend-v1','{}')").run();
  for (const [id, name, membership] of [["A", "Alpha", "fbs"], ["B", "Beta", "fbs"],
    ["C", "Gamma", "fbs"], ["D", "Delta", "fbs"], ["F", "FCS Fixture", "fcs"]]) {
    db.query("INSERT INTO teams (id,name,abbreviation) VALUES (?,?,?)").run(id, name, id);
    db.query("INSERT INTO team_seasons (season,team_id,membership) VALUES (2020,?,?)").run(id, membership);
  }
  for (const [id, sourceHash, releaseTime] of [["ui-poll-1", "original-source-1", "2020-11-30"],
    ["ui-poll-2", "original-source-2", "2020-12-01"]]) {
    db.query(`INSERT INTO poll_releases (id,season,poll_type,game_week,source_hash,
      released_at_utc,timing_provenance,provider_season_type,is_current)
      VALUES (?,2020,'cfp',15,?,?,'fixture','regular',?)`)
      .run(id, sourceHash, releaseTime, Number(id === "ui-poll-2"));
    for (const [team, rank] of [["B", 1], ["C", 2], ["D", 2]] as const)
      db.query("INSERT INTO poll_entries (release_id,team_id,rank) VALUES (?,?,?)").run(id, team, rank);
  }
  db.query(`INSERT INTO season_calendar_weeks (season,season_type,week,start_utc,end_utc,source_hash)
    VALUES (2020,'regular',1,'2020-09-01T00:00:00Z','2020-09-08T00:00:00Z','fixture')`).run();
  const games = [{ id: "fixture-game", homeId: "A", awayId: "B", homeScore: 21, awayScore: 7 },
    { id: "gamma-fcs", homeId: "C", awayId: "F", homeScore: 14, awayScore: 0 },
    { id: "delta-fcs", homeId: "D", awayId: "F", homeScore: 17, awayScore: 0 }];
  for (const game of games) {
    db.query(`INSERT INTO games (id,provider_game_id,season,week,home_team_id,away_team_id,kickoff_utc,
      home_score,away_score,status,completed,provider_season_type,application_game_type,classification_source,
      first_seen_utc,last_seen_utc,payload_hash) VALUES (?, ?,2020,1,?,?,'2020-09-05T00:00:00Z',?,?,'completed',1,'regular','regular','fixture','2020-09-05','2020-09-05','fixture')`)
      .run(game.id, game.id, game.homeId, game.awayId, game.homeScore, game.awayScore);
    db.query("INSERT INTO game_revisions (game_id,revision,payload_hash,observed_at_utc,normalized_json) VALUES (?,1,'fixture','2020-09-05',?)")
      .run(game.id, JSON.stringify({ ...game, week: 1, kickoffUtc: "2020-09-05T00:00:00Z", applicationGameType: "regular" }));
  }
  const coverage = JSON.stringify({ complete: true, reasons: [], poll: { type: "cfp", fallback: false, timingProvenance: "fixture" } });
  const auditPoll = (key: string, revision: number, releaseId: string, sourceHash: string, releasedAtUtc: string) => {
    db.query("INSERT INTO snapshot_poll_audit VALUES (?,?,?,?)").run(key, revision,
      JSON.stringify({ releaseId, type: "cfp", gameWeek: 15, releasedAtUtc, effectiveAtUtc: null,
        timingProvenance: "fixture", sourceHash, providerSeasonType: "regular", fallback: false }),
      JSON.stringify([["B", "Beta", 1, false], ["C", "Gamma", 2, true], ["D", "Delta", 2, true]]
        .map(([teamId, name, rank, eligibleAtSnapshot]) => ({ teamId, name, abbreviation: teamId,
          rank, points: null, eligibleAtSnapshot }))));
  };
  for (const [key, kind, week, cutoff] of [["2020:week:1", "week_final", 1, "2020-09-08T00:00:00Z"],
    ["2020:selection-final", "selection_final", 14, "2020-11-29T00:00:00Z"]] as const) {
    db.query(`INSERT INTO snapshots (snapshot_key,revision,season,week,kind,game_cutoff_utc,input_hash,
      poll_release_id,policy_version,model_version,calendar_policy_version,coverage_json,published_at_utc)
      VALUES (?,1,2020,?,?,?,'fixture','ui-poll-1','selection-v1','colley-fbs-only-v1','pre-ccg-weekend-v1',?,'2020-12-01T00:00:00Z')`)
      .run(key, week, kind, cutoff, coverage);
    db.query("INSERT INTO snapshot_publications (snapshot_key,revision,published_at_utc,state) VALUES (?,1,'2020-12-01T00:00:00Z','current')").run(key);
    for (const game of games) db.query("INSERT INTO snapshot_games VALUES (?,1,?,1)").run(key, game.id);
    for (const [i, id] of ["A", "B", "C", "D"].entries()) {
      const category = i === 0 ? "bid" : i === 1 ? "outside" : "playin";
      db.query(`INSERT INTO snapshot_rankings VALUES (?,1,?, ?, ?,0, ?,0,'fixture', ?, ?, ?, ?, ?, ?)`)
        .run(key, id, i === 1 ? 0 : 1, i === 1 ? 1 : 0, 0.65 - i * 0.06, i + 1,
          i === 1 ? null : i === 0 ? 1 : i, i === 1 ? 0 : 1, i === 1 ? "below .750" : null,
          i === 0 ? "colley_minimum_bid" : i === 1 ? "outside" : "poll_playin", category);
    }
    db.query("INSERT INTO snapshot_h2h_audit VALUES (?,1,?,?)")
      .run(key, JSON.stringify({ rawEdges: [{ winnerTeamId: "A", loserTeamId: "B", supportingGameIds: ["fixture-game"] }],
        suppressedEdges: [], activeEdges: [{ winnerTeamId: "A", loserTeamId: "B", supportingGameIds: ["fixture-game"] }],
        components: [["A"], ["B"], ["C"], ["D"]], cyclicComponents: [] }), "[]");
    auditPoll(key, 1, "ui-poll-1", "original-source-1", "2020-11-30");
  }
  for (const [position, seed, a, b, pair] of [[0, 1, "A", null, null], [1, 2, "C", "D", "pair-1"]] as const)
    db.query("INSERT INTO bracket_slots VALUES ('2020:selection-final',1,0,?,?,?,?,?,NULL,0)")
      .run(position, seed, a, b, pair);
  db.query("INSERT INTO bracket_slots VALUES ('2020:selection-final',1,1,0,NULL,NULL,NULL,?,?,0)")
    .run(JSON.stringify({ kind: "slot", slotId: "main-slot-1" }), JSON.stringify({ kind: "slot", slotId: "main-slot-2" }));
  const finalKey = "2020:selection-final";
  db.query(`INSERT INTO snapshots (snapshot_key,revision,season,week,kind,game_cutoff_utc,
    input_hash,poll_release_id,policy_version,model_version,calendar_policy_version,coverage_json,published_at_utc)
    SELECT snapshot_key,2,season,week,kind,game_cutoff_utc,'fixture-revision-2','ui-poll-2',
      policy_version,model_version,calendar_policy_version,coverage_json,'2020-12-02T00:00:00Z'
    FROM snapshots WHERE snapshot_key=? AND revision=1`).run(finalKey);
  db.query(`INSERT INTO snapshot_games SELECT snapshot_key,2,game_id,game_revision
    FROM snapshot_games WHERE snapshot_key=? AND snapshot_revision=1`).run(finalKey);
  db.query(`INSERT INTO snapshot_rankings SELECT snapshot_key,2,team_id,wins,losses,ties,rating,residual,
    precision_method,colley_rank,adjusted_rank,eligible,eligibility_reason,original_route,final_category
    FROM snapshot_rankings WHERE snapshot_key=? AND snapshot_revision=1`).run(finalKey);
  db.query(`INSERT INTO bracket_slots SELECT snapshot_key,2,round,position,seed,team_a_id,team_b_id,
    source_slot_a,source_slot_b,is_bye FROM bracket_slots WHERE snapshot_key=? AND snapshot_revision=1`).run(finalKey);
  db.query(`INSERT INTO snapshot_h2h_audit SELECT snapshot_key,2,graph_json,unapplied_claims_json
    FROM snapshot_h2h_audit WHERE snapshot_key=? AND snapshot_revision=1`).run(finalKey);
  auditPoll(finalKey, 2, "ui-poll-2", "original-source-2", "2020-12-01");
  db.query("UPDATE snapshot_publications SET revision=2 WHERE snapshot_key=?").run(finalKey);
  // A pre-012 published snapshot has coverage-only poll provenance, not inferred entries.
  db.query(`INSERT INTO snapshots (snapshot_key,revision,season,week,kind,game_cutoff_utc,
    input_hash,poll_release_id,policy_version,model_version,calendar_policy_version,coverage_json,published_at_utc)
    SELECT '2020:legacy',1,season,week,kind,'2020-08-01T00:00:00Z','legacy-fixture',poll_release_id,
      policy_version,model_version,calendar_policy_version,coverage_json,published_at_utc
    FROM snapshots WHERE snapshot_key='2020:week:1' AND revision=1`).run();
  db.query(`INSERT INTO snapshot_publications (snapshot_key,revision,published_at_utc,state)
    VALUES ('2020:legacy',1,'2020-12-01T00:00:00Z','current')`).run();
  // Correct source data AFTER publication: neither revision's JSON should drift.
  db.query("UPDATE poll_releases SET source_hash='corrected-later',released_at_utc='2021-01-01' WHERE id='ui-poll-1'").run();
  db.query("UPDATE poll_entries SET rank=20 WHERE release_id='ui-poll-1' AND team_id='B'").run();
  db.query("INSERT INTO season_input_generations (season,generation) VALUES (2020,1)").run();
  const jobInput = "synthetic-scenarios";
  const jobId = createHash("sha256").update(JSON.stringify(["2020:week:1", 1,
    POLL_MODEL_VERSION, SOLVER_VERSION, jobInput])).digest("hex");
  db.query(`INSERT INTO scenario_jobs (id,snapshot_key,snapshot_revision,poll_model_version,solver_version,
    input_hash,state,created_at_utc,updated_at_utc,input_generation)
    VALUES (?,'2020:week:1',1,?, ?, ?,'proved','2020-12-01','2020-12-01',1)`)
    .run(jobId, POLL_MODEL_VERSION, SOLVER_VERSION, jobInput);
  for (const [id, label] of [["A", "clinched"], ["B", "eliminated"],
    ["C", "controls_destiny"], ["D", "needs_help"]]) {
    db.query(`INSERT INTO scenario_statuses (job_id,team_id,state,label,assumptions_json,proof_metadata_json)
      VALUES (?,?,'proved',?, ?,?)`).run(jobId, id, label,
        JSON.stringify(["all eligible poll orders; synthetic fixture"]), JSON.stringify({ snapshotInputHash: "fixture" }));
    if (label === "needs_help") for (const [index, kind] of ["qualifying_win_out", "failing_win_out"].entries())
      db.query(`INSERT INTO scenario_witnesses (job_id,team_id,kind,sequence,witness_json) VALUES (?,?,?,?,?)`)
        .run(jobId, id, kind, index + 1, JSON.stringify({ kind, gameOutcomes: {}, pollOrderTeamIds: [] }));
  }
  console.log(`Synthetic fixture: ${path}`);
} finally { db.close(); }

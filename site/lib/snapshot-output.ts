import "server-only";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { assertSnapshotOutputSchema } from "./snapshot-output-schema";

type SnapshotRow = {
  snapshot_key: string; revision: number; season: number; week: number | null; kind: string;
  game_cutoff_utc: string; poll_cutoff_utc: string | null; poll_release_id: string | null;
  input_hash: string; policy_version: string; model_version: string; calendar_policy_version: string;
  coverage_json: string; published_at_utc: string | null; publication_state: string;
};
type GameRevision = { game_id: string; game_revision: number; payload_hash: string; normalized_json: string;
  observed_at_utc: string; source: string | null };

/** Only persisted publication rows are read; never invoke the rating, selection, or provider engines here. */
export function readSnapshotOutput(year: number, key: string, revision?: number): object | null {
  const path = process.env.DATABASE_PATH;
  if (!path || !isAbsolute(path) || !existsSync(path)) return null;
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA query_only=ON");
    db.exec("PRAGMA busy_timeout=5000");
    return db.transaction(() => {
      assertSnapshotOutputSchema(db);
      const snapshot = db.query<SnapshotRow & { pointer_revision: number }, [number, string, number | null, number | null]>(`SELECT s.*, p.state AS publication_state,
        p.revision AS pointer_revision
        FROM snapshots s JOIN snapshot_publications p ON p.snapshot_key=s.snapshot_key
        WHERE s.season=? AND s.snapshot_key=? AND (s.revision=? OR (? IS NULL AND s.revision=p.revision))`)
        .get(year, key, revision ?? null, revision ?? null);
      if (!snapshot || snapshot.published_at_utc === null) return null;
      const games = db.query<GameRevision, [string, number]>(`SELECT sg.game_id, sg.game_revision, gr.payload_hash,
        gr.normalized_json, gr.observed_at_utc, ip.source FROM snapshot_games sg
        JOIN game_revisions gr ON gr.game_id=sg.game_id AND gr.revision=sg.game_revision
        LEFT JOIN ingestion_payloads ip ON ip.id=gr.payload_id
        WHERE sg.snapshot_key=? AND sg.snapshot_revision=? ORDER BY sg.game_id`)
        .all(key, snapshot.revision).map(({ normalized_json, ...row }) => {
          const normalized = JSON.parse(normalized_json) as Record<string, unknown>;
          return { id: row.game_id, revision: row.game_revision, source: row.source, sourceHash: row.payload_hash,
            observedAtUtc: row.observed_at_utc, week: normalized.week, kickoffUtc: normalized.kickoffUtc,
            homeTeamId: normalized.homeId, awayTeamId: normalized.awayId,
            homeScore: normalized.homeScore, awayScore: normalized.awayScore,
            applicationGameType: normalized.applicationGameType };
        });
      const rankings = db.query<{ teamId: string; name: string; abbreviation: string | null;
        wins: number; losses: number; ties: number; rating: number; residual: number; precisionMethod: string;
        colleyRank: number; adjustedRank: number | null; eligible: number; eligibilityReason: string | null;
        originalRoute: string; finalCategory: string }, [string, number]>(`SELECT r.team_id AS teamId,
        t.name, t.abbreviation, r.wins, r.losses, r.ties, r.rating, r.residual,
        r.precision_method AS precisionMethod, r.colley_rank AS colleyRank, r.adjusted_rank AS adjustedRank,
        r.eligible, r.eligibility_reason AS eligibilityReason, r.original_route AS originalRoute,
        r.final_category AS finalCategory FROM snapshot_rankings r JOIN teams t ON t.id=r.team_id
        WHERE r.snapshot_key=? AND r.snapshot_revision=? ORDER BY r.colley_rank, r.team_id`)
        .all(key, snapshot.revision).map(row => {
          const { wins, losses, ties, eligible, ...rest } = row;
          return { ...rest, membership: "fbs" as const, eligible: Boolean(eligible), record: { wins, losses, ties,
            percentageNumerator: 2 * wins + ties, percentageDenominator: 2 * (wins + losses + ties) } };
        });
      const events = db.query<{ sequence: number; details_json: string }, [string, number]>(`SELECT sequence, details_json
        FROM selection_events WHERE snapshot_key=? AND snapshot_revision=? ORDER BY sequence`).all(key, snapshot.revision)
        .map(row => ({ ...JSON.parse(row.details_json), sequence: row.sequence }));
      const slots = db.query<{ round: number; position: number; seed: number | null; teamAId: string | null;
        teamBId: string | null; sourceSlotA: string | null; sourceSlotB: string | null; isBye: number }, [string, number]>(`SELECT round, position, seed,
        team_a_id AS teamAId, team_b_id AS teamBId, source_slot_a AS sourceSlotA,
        source_slot_b AS sourceSlotB, is_bye AS isBye FROM bracket_slots
        WHERE snapshot_key=? AND snapshot_revision=? ORDER BY round, position`).all(key, snapshot.revision);
      const audit = db.query<{ graph_json: string; unapplied_claims_json: string }, [string, number]>(`SELECT graph_json, unapplied_claims_json
        FROM snapshot_h2h_audit WHERE snapshot_key=? AND snapshot_revision=?`).get(key, snapshot.revision);
      const pollAudit = db.query<{ metadata_json: string | null; entries_json: string }, [string, number]>(
        `SELECT metadata_json, entries_json FROM snapshot_poll_audit WHERE snapshot_key=? AND snapshot_revision=?`)
        .get(key, snapshot.revision);
      // Old publications predate the audit table's rows. Coverage is pinned, but entries and
      // missing timing fields are unknown; never consult today's poll_releases or poll_entries.
      const coverage = JSON.parse(snapshot.coverage_json) as { complete: boolean; reasons: string[];
        poll?: Record<string, unknown> | null };
      const poll = pollAudit ? { availability: "pinned" as const,
        metadata: pollAudit.metadata_json ? JSON.parse(pollAudit.metadata_json) as unknown : null,
        entries: JSON.parse(pollAudit.entries_json) as unknown, entriesAvailable: true } :
        snapshot.poll_release_id ? { availability: "coverage_only" as const,
          metadata: { releaseId: snapshot.poll_release_id, ...(coverage.poll ?? {}) },
          entries: null, entriesAvailable: false,
          note: "Poll entry ranks, names and unrecorded release timing are unavailable for this pre-012 revision." } :
          { availability: "none" as const, metadata: null, entries: null, entriesAvailable: false };
      const initialBid = rankings.filter(r => ["rating_bid", "colley_minimum_bid"].includes(r.originalRoute)).map(r => r.teamId);
      const initialPlayin = rankings.filter(r => ["rating_playin", "poll_playin"].includes(r.originalRoute)).map(r => r.teamId);
      const finalBid = rankings.filter(r => r.finalCategory === "bid").map(r => r.teamId);
      const finalPlayin = rankings.filter(r => r.finalCategory === "playin").map(r => r.teamId);
      const roundZero = slots.filter(row => row.round === 0);
      const pairs = roundZero.filter(row => row.teamBId !== null).map(row => ({ seed: row.seed,
        pairId: row.sourceSlotA, teamAId: row.teamAId, teamBId: row.teamBId }));
      const playinByes = roundZero.filter(row => row.teamBId === null &&
        finalPlayin.includes(row.teamAId as string)).map(row => ({ seed: row.seed, teamId: row.teamAId }));
      return {
        snapshot: { key, revision: snapshot.revision, season: year, week: snapshot.week, kind: snapshot.kind,
          gameCutoffUtc: snapshot.game_cutoff_utc, pollCutoffUtc: snapshot.poll_cutoff_utc,
          publishedAtUtc: snapshot.published_at_utc,
          publicationState: snapshot.revision === snapshot.pointer_revision ? snapshot.publication_state : "historical",
          inputHash: snapshot.input_hash, coverage },
        policy: { version: snapshot.policy_version, modelVersion: snapshot.model_version,
          calendarPolicyVersion: snapshot.calendar_policy_version, fbsOnlyRatings: true,
          eligibility: "at least .750 with at least one game", cycleFallback: "full FBS SCC; internal edges suppressed",
          outsiderAdmission: "outside to play-in before direct bid", playinBye: "highest adjusted-ranked",
          mainBracket: "fixed winner slots; highest seeds receive byes" },
        sources: { games, poll }, teams: rankings,
        selection: { initialBid, initialPlayin, finalBid, finalPlayin,
          adjustedOrder: rankings.filter(r => r.adjustedRank !== null)
            .sort((a, b) => a.adjustedRank! - b.adjustedRank!).map(r => r.teamId),
          swaps: events, headToHead: audit ? JSON.parse(audit.graph_json) : null,
          unappliedOutsiderBidClaims: audit ? JSON.parse(audit.unapplied_claims_json) : null,
          auditAvailable: Boolean(audit),
          counts: { initialBid: initialBid.length, initialPlayin: initialPlayin.length,
            bid: finalBid.length, playin: finalPlayin.length, selected: finalBid.length + finalPlayin.length,
            eligible: rankings.filter(r => r.eligible).length },
          shortFieldExplanation: finalBid.length + finalPlayin.length < 12 ?
            "Fewer than twelve eligible teams qualified by rating or the available contemporaneous poll; no unranked or ineligible top-up is allowed." : null,
          explanation: `Initial field: ${initialBid.length} bids, ${initialPlayin.length} play-ins. After ${events.length} head-to-head swaps: ${finalBid.length} bids, ${finalPlayin.length} play-ins. Ratings and original routes are unchanged by swaps.` },
        bracket: { playinPairs: pairs, playinByes, mainSlots: roundZero, roundMatchups: slots.filter(row => row.round > 0) },
      };
    }).deferred();
  } finally { db.close(); }
}

import { CholeskyDecomposition, Matrix } from "ml-matrix";
import Fraction from "fraction.js";
import type { Ratings, RecordResult, Snapshot } from "./types";

export function calculateRecords(snapshot: Snapshot): RecordResult[] {
  const records = new Map(snapshot.input.teams.filter(t => t.fbs).map(t => [t.id, { teamId: t.id, wins: 0, losses: 0, ties: 0, gamesPlayed: 0, eligible: false, reason: "" }]));
  for (const game of snapshot.games) {
    for (const [id, own, opponent] of [[game.home, game.homeScore!, game.awayScore!], [game.away, game.awayScore!, game.homeScore!]] as const) {
      const r = records.get(id);
      if (r) { r.gamesPlayed++; if (own > opponent) r.wins++; else if (own < opponent) r.losses++; else r.ties++; }
    }
  }
  for (const r of records.values()) {
    r.eligible = r.gamesPlayed > 0 && 4 * r.wins + 2 * r.ties >= 3 * r.gamesPlayed;
    r.reason = r.gamesPlayed === 0 ? "no completed games" : r.eligible ? "at least .750" : "below .750";
  }
  return [...records.values()].sort((a, b) => a.teamId.localeCompare(b.teamId));
}

/** The exact rational solve runs only when floating comparisons are numerically ambiguous. */
function exactSolve(coeff: number[][], rhs: number[]): Fraction[] {
  const n = rhs.length;
  const a = coeff.map((row, i) => [...row.map(v => new Fraction(v)), new Fraction(rhs[i] * 2).div(2)]);
  for (let k = 0; k < n; k++) {
    for (let i = k + 1; i < n; i++) {
      const m = a[i][k].div(a[k][k]);
      for (let j = k + 1; j <= n; j++) a[i][j] = a[i][j].sub(m.mul(a[k][j]));
      a[i][k] = new Fraction(0);
    }
  }
  const x = Array.from({ length: n }, () => new Fraction(0));
  for (let i = n - 1; i >= 0; i--) {
    let v = a[i][n];
    for (let j = i + 1; j < n; j++) v = v.sub(a[i][j].mul(x[j]));
    x[i] = v.div(a[i][i]);
  }
  return x;
}

export function calculateColley(snapshot: Snapshot, model: "fbs-only-1" = "fbs-only-1"): Ratings {
  if (model !== "fbs-only-1") throw new Error("Unsupported Colley model");
  const ids = snapshot.input.teams.filter(t => t.fbs).map(t => t.id).sort();
  const indices = new Map(ids.map((id, i) => [id, i]));
  const c: number[][] = ids.map((_, i) => ids.map((_, j) => i === j ? 2 : 0));
  const b = ids.map(() => 2); // twice the exact RHS; divide after the solve
  for (const game of snapshot.games) {
    const i = indices.get(game.home), j = indices.get(game.away);
    if (i === undefined || j === undefined) continue;
    c[i][i]++; c[j][j]++; c[i][j]--; c[j][i]--;
    const outcome = Math.sign(game.homeScore! - game.awayScore!);
    b[i] += outcome; b[j] -= outcome;
  }
  const n = ids.length;
  const values = n ? new CholeskyDecomposition(new Matrix(c)).solve(Matrix.columnVector(b.map(x => x / 2))).to1DArray() : [];
  const residual = Math.max(0, ...c.map((row, i) => Math.abs(row.reduce((sum, v, j) => sum + v * values[j], 0) - b[i] / 2)));
  if (residual > 1e-9) throw new Error(`Colley solver residual ${residual}`);
  let exact: Fraction[] | undefined;
  const precise = () => exact ??= exactSolve(c, b.map(x => x / 2));
  const compareValues = (i: number, j: number) => {
    const d = values[i] - values[j];
    if (Math.abs(d) > 1e-9) return Math.sign(d);
    return precise()[i].compare(precise()[j]);
  };
  const compare = (a: string, z: string) => {
    const i = indices.get(a), j = indices.get(z);
    if (i === undefined || j === undefined) throw new Error("Unknown FBS team");
    return -compareValues(i, j) || (a < z ? -1 : a > z ? 1 : 0);
  };
  const order = [...ids].sort(compare);
  const entries = order.map((teamId, i) => ({ teamId, rating: values[indices.get(teamId)!], rawRank: i + 1 }));
  const atLeast = (id: string, threshold: ".90" | ".85") => {
    const i = indices.get(id);
    if (i === undefined) throw new Error("Unknown FBS team");
    const target = threshold === ".90" ? 0.9 : 0.85;
    if (Math.abs(values[i] - target) > 1e-9) return values[i] > target;
    return precise()[i].compare(new Fraction(threshold)) >= 0;
  };
  return { entries, residual, model, compare, atLeast };
}

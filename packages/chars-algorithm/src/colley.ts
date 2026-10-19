import { colleyInputFingerprint, includedRegularGames, type SeasonGames } from "./eligibility";

type Fraction = { numerator: bigint; denominator: bigint };
const ZERO: Fraction = { numerator: 0n, denominator: 1n };
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
}
function fraction(numerator: bigint, denominator: bigint): Fraction {
  if (!denominator) throw new Error("Singular Colley matrix");
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function subtract(a: Fraction, b: Fraction): Fraction {
  return fraction(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
}
function compareFractions(a: Fraction, b: Fraction): number {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** Fraction-free elimination on Cx=2b; returns exact Colley ratings x/2. */
function exactRatings(matrix: readonly (readonly number[])[], twiceB: readonly number[]): Fraction[] {
  const n = matrix.length;
  const rows = matrix.map((row, i) => [...row.map(BigInt), BigInt(twiceB[i]!)]);
  let prior = 1n;
  for (let k = 0; k < n - 1; k++) {
    const pivot = rows[k]![k]!;
    if (pivot <= 0n) throw new Error("Colley matrix is not positive definite");
    for (let i = k + 1; i < n; i++) {
      const multiplier = rows[i]![k]!;
      for (let j = k + 1; j <= n; j++) {
        const value = rows[i]![j]! * pivot - multiplier * rows[k]![j]!;
        if (value % prior !== 0n) throw new Error("Nonintegral Bareiss division");
        rows[i]![j] = value / prior;
      }
      rows[i]![k] = 0n;
    }
    prior = pivot;
  }
  const result = Array<Fraction>(n);
  for (let i = n - 1; i >= 0; i--) {
    let value = fraction(rows[i]![n]!, 1n);
    for (let j = i + 1; j < n; j++) {
      const next = result[j]!;
      value = subtract(value, fraction(rows[i]![j]! * next.numerator, next.denominator));
    }
    result[i] = fraction(value.numerator, value.denominator * rows[i]![i]!);
  }
  return result.map(x => fraction(x.numerator, x.denominator * 2n));
}

export interface ColleyTeamRating {
  teamId: string;
  colleyRating: number;
  colleyRank: number;
  residual: number;
  /** Upper bound on absolute rating error from the original linear system. */
  errorBound: number;
  precisionMethod: "cholesky" | "cholesky+exact-comparison";
}

export interface ColleyResult {
  /** Canonical season, memberships and included outcomes used for these ratings. */
  inputFingerprint: string;
  /** Ordered by descending rating, then ascending stable ID for exact ties. */
  ratings: ColleyTeamRating[];
  /** Negative if a precedes b in Colley order. */
  compareTeamIds(a: string, b: string): number;
  /** Compare without decimal rounding; boundary is restricted to the selection policy thresholds. */
  meetsThreshold(teamId: string, threshold: "0.90" | "0.85"): boolean;
}

export function computeColley(input: SeasonGames): ColleyResult {
  const inputFingerprint = colleyInputFingerprint(input);
  const ids = input.teams.filter(team => team.membership === "fbs").map(team => team.teamId).sort();
  if (new Set(ids).size !== ids.length || ids.some(id => !id)) throw new Error("Duplicate/empty FBS team ID");
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const matrix: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j): number => i === j ? 2 : 0));
  const twiceB = Array(n).fill(2) as number[];
  for (const game of includedRegularGames(input)) {
    const home = index.get(game.homeTeamId), away = index.get(game.awayTeamId);
    if (home === undefined || away === undefined) continue;
    matrix[home]![home]!++;
    matrix[away]![away]!++;
    matrix[home]![away]!--;
    matrix[away]![home]!--;
    if (game.homeScore > game.awayScore) { twiceB[home]!++; twiceB[away]!--; }
    if (game.homeScore < game.awayScore) { twiceB[home]!--; twiceB[away]!++; }
  }
  for (let i = 0; i < n; i++) {
    if (matrix[i]!.reduce((sum, value) => sum + value, 0) !== 2) throw new Error("Colley row sum mismatch");
    for (let j = 0; j < i; j++) if (matrix[i]![j] !== matrix[j]![i]) throw new Error("Asymmetric Colley matrix");
  }
  const lower = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let value = matrix[i]![j]!;
      for (let k = 0; k < j; k++) value -= lower[i]![k]! * lower[j]![k]!;
      if (i === j) {
        if (!(value > 0)) throw new Error("Colley matrix is not positive definite");
        lower[i]![j] = Math.sqrt(value);
      } else lower[i]![j] = value / lower[j]![j]!;
    }
  }
  const y = Array<number>(n).fill(0), ratings = Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let value = twiceB[i]! / 2;
    for (let j = 0; j < i; j++) value -= lower[i]![j]! * y[j]!;
    y[i] = value / lower[i]![i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let value = y[i]!;
    for (let j = i + 1; j < n; j++) value -= lower[j]![i]! * ratings[j]!;
    ratings[i] = value / lower[i]![i]!;
  }
  const residuals = ratings.map((rating, i) => {
    let value = -twiceB[i]! / 2;
    for (let j = 0; j < n; j++) value += matrix[i]![j]! * ratings[j]!;
    return Math.abs(value);
  });
  const maxResidual = Math.max(0, ...residuals);
  const scale = Math.max(1, ...matrix.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)));
  if (maxResidual > 64 * Number.EPSILON * scale * Math.max(1, n)) throw new Error("Colley residual exceeds numerical tolerance");
  if (Math.abs(ratings.reduce((sum, value) => sum + value, 0) - n / 2) >
    64 * Number.EPSILON * Math.max(1, n) * scale) throw new Error("Colley mean invariant failed");

  // Each row is strictly diagonally dominant by 2, hence ||C^-1||_infinity <= 1/2.
  // Account for rounding in residual accumulation and the factorization when enclosing the solution.
  const error = maxResidual / 2 + 64 * Number.EPSILON * scale * Math.max(1, n);
  let exact: Fraction[] | undefined;
  const precise = () => { exact ??= exactRatings(matrix, twiceB); return exact; };
  if (n <= 3) precise();
  const position = (id: string) => {
    const at = index.get(id);
    if (at === undefined) throw new Error(`Unknown FBS team: ${id}`);
    return at;
  };
  const refined = new Set<number>();
  let result: ColleyTeamRating[] = [];
  const markRefined = (at: number) => {
    refined.add(at);
    const entry = result.find(item => item.teamId === ids[at]);
    if (entry) entry.precisionMethod = "cholesky+exact-comparison";
  };
  const compareTeamIds = (a: string, b: string) => {
    const i = position(a), j = position(b);
    if (i === j) return 0;
    const difference = ratings[i]! - ratings[j]!;
    if (Math.abs(difference) > 2 * error) return difference > 0 ? -1 : 1;
    markRefined(i); markRefined(j);
    const exactDifference = compareFractions(precise()[i]!, precise()[j]!);
    return exactDifference === 0 ? (a < b ? -1 : 1) : -exactDifference;
  };
  const meetsThreshold = (id: string, threshold: "0.90" | "0.85") => {
    const i = position(id);
    markRefined(i);
    const bound = threshold === "0.90" ? fraction(9n, 10n) : fraction(17n, 20n);
    return compareFractions(precise()[i]!, bound) >= 0;
  };
  const ordered = [...ids].sort(compareTeamIds);
  result = ordered.map((teamId, i) => {
    const at = position(teamId);
    return { teamId, colleyRating: exact ? Number(exact[at]!.numerator) / Number(exact[at]!.denominator) : ratings[at]!,
      colleyRank: i + 1, residual: residuals[at]!,
      errorBound: error, precisionMethod: refined.has(at) ? "cholesky+exact-comparison" : "cholesky" };
  });
  return { inputFingerprint, ratings: result, compareTeamIds, meetsThreshold };
}

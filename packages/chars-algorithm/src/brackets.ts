import { seedField, type SeedingResult } from "./seeding";
import type { SelectionInput } from "./selection";
import type { SnapshotIdentity } from "./index";

export interface PlayinPair {
  id: string;
  /** A is the better adjusted-ranked team; B is the worse. */
  teamAId: string;
  teamBId: string;
  teamAAdjustedRank: number;
  teamBAdjustedRank: number;
  winnerSlotId: string;
}

export interface MainSlot {
  id: string;
  seed: number;
  priorityAdjustedRank: number;
  source: "bid" | "playin_bye" | "playin_winner";
  /** Null until a hypothetical play-in winner exists; both alternatives retain this same seed. */
  teamId: string | null;
  teamAId: string;
  teamBId: string | null;
  label: string;
  playinPairId: string | null;
}

export type BracketEntry = { kind: "slot"; slotId: string } | { kind: "winner"; matchId: string };

export interface MainMatch {
  id: string;
  round: number;
  position: number;
  first: BracketEntry;
  second: BracketEntry | null;
  /** Byes advance their source slot directly; they are not hypothetical played games. */
  isBye: boolean;
}

export interface BracketResult {
  seeding: SeedingResult;
  playinPairs: PlayinPair[];
  playinByeTeamId: string | null;
  mainSlots: MainSlot[];
  bracketSize: number;
  seedPositions: number[];
  rounds: MainMatch[][];
  champion: BracketEntry | null;
  counts: { initialBid: number; initialPlayin: number; bid: number; playin: number;
    selected: number; mainSlots: number; byes: number };
  shortFieldExplanation: string | null;
  /** Fixed winner slots; no hypothetical winner is predicted and no reseeding occurs. */
  bracketPolicy: "fixed_winner_slots_highest_seeds_byes";
}

/** Starting at [1,2], mirror each existing position at each doubling. */
export function standardSeedOrder(size: number): number[] {
  if (!Number.isSafeInteger(size) || size < 0 || (size > 0 && !Number.isInteger(Math.log2(size)))) {
    throw new Error("Bracket size must be zero or a power of two");
  }
  if (size === 0) return [];
  if (size === 1) return [1];
  let seeds = [1, 2];
  for (let doubled = 4; doubled <= size; doubled *= 2) {
    seeds = seeds.flatMap(seed => [seed, doubled + 1 - seed]);
  }
  return seeds;
}

/** Build only from a freshly computed seeding order; category labels remain frozen. */
export function buildBracket(seeding: SeedingResult): BracketResult {
  const rank = new Map(seeding.teams.map(team => [team.teamId, team]));
  const byRank = (a: string, b: string): number => rank.get(a)!.adjustedRank - rank.get(b)!.adjustedRank;
  const bids = [...seeding.selection.bid].sort(byRank);
  const playin = [...seeding.selection.playin].sort(byRank);
  const playinByeTeamId = playin.length % 2 ? playin.shift()! : null;
  const playinPairs: PlayinPair[] = [];
  for (let i = 0; i < playin.length / 2; i++) {
    const teamAId = playin[i]!, teamBId = playin[playin.length - 1 - i]!;
    const id = `playin-${i + 1}`;
    playinPairs.push({ id, teamAId, teamBId,
      teamAAdjustedRank: rank.get(teamAId)!.adjustedRank,
      teamBAdjustedRank: rank.get(teamBId)!.adjustedRank,
      winnerSlotId: `slot-${id}` });
  }
  type SlotDraft = Omit<MainSlot, "seed">;
  const singleton = (teamId: string, source: "bid" | "playin_bye"): SlotDraft => ({
    id: `slot-${teamId}`, priorityAdjustedRank: rank.get(teamId)!.adjustedRank,
    source, teamId, teamAId: teamId, teamBId: null, label: teamId, playinPairId: null });
  const drafts: SlotDraft[] = [
    ...bids.map(id => singleton(id, "bid")),
    ...(playinByeTeamId ? [singleton(playinByeTeamId, "playin_bye")] : []),
    ...playinPairs.map(pair => ({ id: pair.winnerSlotId, priorityAdjustedRank: pair.teamAAdjustedRank,
      source: "playin_winner" as const, teamId: null, teamAId: pair.teamAId,
      teamBId: pair.teamBId, label: `${pair.teamAId} / ${pair.teamBId}`,
      playinPairId: pair.id }))
  ];
  drafts.sort((a, b) => a.priorityAdjustedRank - b.priorityAdjustedRank);
  const mainSlots: MainSlot[] = drafts.map((slot, index) => ({ ...slot, seed: index + 1 }));
  const count = mainSlots.length;
  const bracketSize = count < 2 ? count : 2 ** Math.ceil(Math.log2(count));
  const seedPositions = standardSeedOrder(bracketSize);
  const rounds: MainMatch[][] = [];
  const entryBySeed = new Map(mainSlots.map(slot => [slot.seed, { kind: "slot", slotId: slot.id } as BracketEntry]));
  let entries = seedPositions.map(seed => entryBySeed.get(seed) ?? null);
  while (entries.length > 1) {
    const round = rounds.length + 1;
    const matches: MainMatch[] = [];
    const next: (BracketEntry | null)[] = [];
    for (let position = 0; position < entries.length / 2; position++) {
      const first = entries[position * 2], second = entries[position * 2 + 1];
      if (!first && !second) throw new Error("Bracket contains an empty pairing");
      const id = `main-${round}-${position + 1}`;
      const isBye = !first || !second;
      matches.push({ id, round, position: position + 1, first: (first ?? second)!,
        second: isBye ? null : second!, isBye });
      next.push(isBye ? (first ?? second)! : { kind: "winner", matchId: id });
    }
    rounds.push(matches);
    entries = next;
  }
  const shortFieldExplanation = seeding.selection.shortField ?
    `Only ${seeding.selection.bid.length + seeding.selection.playin.length} eligible teams were selected: ` +
    "rating/minimum-bid routes and the available eligible contemporaneous poll entries did not reach 12; " +
    "no eligibility, poll, or parity invitations were fabricated." : null;
  return { seeding, playinPairs, playinByeTeamId, mainSlots, bracketSize, seedPositions,
    rounds, champion: entries[0] ?? null, bracketPolicy: "fixed_winner_slots_highest_seeds_byes",
    counts: { initialBid: seeding.selection.initialBid.length,
      initialPlayin: seeding.selection.initialPlayin.length,
      bid: bids.length, playin: seeding.selection.playin.length,
      selected: bids.length + seeding.selection.playin.length, mainSlots: count,
      byes: bracketSize - count }, shortFieldExplanation };
}

/** One pure entry point for snapshot-specific final selection, seeding and bracket construction. */
export function computePlayoff(input: SelectionInput, snapshot: SnapshotIdentity | null = null): BracketResult {
  return buildBracket(seedField(input, snapshot));
}

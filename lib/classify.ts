// Move classification — pure functions, no engine or React dependency.
//
// The engine gives us an objective evaluation before and after each move; we turn
// the *swing* into a human label (Lichess-style). This is the bridge between raw
// engine numbers and teaching language — and the data the LLM will narrate later.

export type Classification = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

export interface ClassifiedMove {
  ply: number;
  color: "w" | "b";
  san: string;
  uci: string;
  classification: Classification;
  /** Centipawns lost vs. the engine's best move, from the mover's perspective. */
  lossCp: number;
  /** The engine's best move at the position before this move, in SAN. */
  bestSan: string | null;
  // ---- Phase 3: data for the "show me" review animations ----
  /** Position (FEN) just before this move was played. */
  fenBefore: string;
  /** Engine's better line from fenBefore, as UCI moves (best move first). */
  bestLine: string[];
  /** What was actually played, then the engine's best continuation, as UCI moves. */
  playedLine: string[];
  /** White-perspective eval of the position before the move. */
  evalBeforeCp: number | null;
  evalBeforeMate: number | null;
  /** White-perspective eval after the move was played. */
  evalAfterCp: number | null;
  evalAfterMate: number | null;
}

/** Format a White-perspective score for display, e.g. "+0.3" or "+M4". */
export function formatEval(cp: number | null, mate: number | null): string {
  if (mate !== null) return `${mate > 0 ? "+" : "−"}M${Math.abs(mate)}`;
  const v = (cp ?? 0) / 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

const MATE_BASE = 100_000;

/**
 * Collapse a White-perspective score (cp or mate) into one comparable number so
 * losses can be computed uniformly. Mates sit far outside the cp range and are
 * ordered by distance (mate-in-1 is the most extreme).
 */
export function toComparable(whiteCp: number | null, whiteMate: number | null): number {
  if (whiteMate !== null) {
    return whiteMate > 0 ? MATE_BASE - whiteMate * 100 : -MATE_BASE - whiteMate * 100;
  }
  return Math.max(-10_000, Math.min(10_000, whiteCp ?? 0));
}

/** Classify a move from how many centipawns it lost vs. best. */
export function classify(lossCp: number, playedWasBest: boolean): Classification {
  if (playedWasBest || lossCp <= 15) return "best";
  if (lossCp < 50) return "good";
  if (lossCp < 120) return "inaccuracy";
  if (lossCp < 250) return "mistake";
  return "blunder";
}

/** Presentation metadata per classification (label, annotation symbol, styles). */
export const CLASS_META: Record<
  Classification,
  { label: string; symbol: string; text: string; badge: string; bar: string }
> = {
  best: {
    label: "Best",
    symbol: "★",
    text: "text-emerald-600 dark:text-emerald-400",
    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    bar: "bg-emerald-500",
  },
  good: {
    label: "Good",
    symbol: "",
    text: "text-neutral-700 dark:text-neutral-300",
    badge: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    bar: "bg-emerald-500",
  },
  inaccuracy: {
    label: "Inaccuracy",
    symbol: "?!",
    text: "text-amber-600 dark:text-amber-400",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    bar: "bg-amber-500",
  },
  mistake: {
    label: "Mistake",
    symbol: "?",
    text: "text-orange-600 dark:text-orange-400",
    badge: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    bar: "bg-orange-500",
  },
  blunder: {
    label: "Blunder",
    symbol: "??",
    text: "text-red-600 dark:text-red-400",
    badge: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    bar: "bg-red-500",
  },
};

/** How many of the 5 severity segments to fill, per classification. */
export const SEVERITY: Record<Classification, number> = {
  best: 0,
  good: 1,
  inaccuracy: 2,
  mistake: 3,
  blunder: 5,
};

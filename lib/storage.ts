// Persist the in-progress game to localStorage so a refresh can resume it.
// We store the position (FEN) + the classified move list + settings — enough to
// fully rebuild the UI without re-running the engine on every past move.
import type { ClassifiedMove } from "@/lib/classify";

const KEY = "chesscoach:game";
const VERSION = 1;

export interface SavedGame {
  version: number;
  fen: string;
  playerColor: "w" | "b";
  difficulty: string;
  moves: ClassifiedMove[];
  evalCp: number;
  evalMate: number | null;
  lastMove: { from: string; to: string } | null;
  updatedAt: number;
}

export function saveGame(game: Omit<SavedGame, "version">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, ...game }));
  } catch {
    /* storage full / unavailable — ignore */
  }
}

export function loadGame(): SavedGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedGame;
    if (parsed.version !== VERSION || !parsed.fen || !Array.isArray(parsed.moves)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearGame(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

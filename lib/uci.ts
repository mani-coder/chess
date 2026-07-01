import type { Square } from "chess.js";

/** Split a UCI move ("e2e4", "e7e8q") into chess.js move parts. */
export function uciToMove(uci: string) {
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    promotion: (uci.length > 4 ? uci[4] : "q") as "q" | "r" | "b" | "n",
  };
}

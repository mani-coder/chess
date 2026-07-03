// Turn a FEN into an explicit, plain-English list of every piece and its square.
// LLMs parse FEN unreliably and then hallucinate board facts ("the d6 pawn" when
// none exists). Handing them the ground-truth placement — plus, for a specific
// move, exactly what it attacks/defends — keeps the narration factual.
import { Chess, type Square } from "chess.js";

const NAME: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

/** e.g. "White: King e1, Queen d1, pawns a2 b2 c2… — Black: King e8, …" */
export function describeBoard(fen: string): string {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return "";
  }
  const byColor: Record<"w" | "b", string[]> = { w: [], b: [] };
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) byColor[cell.color].push(`${NAME[cell.type]} ${cell.square}`);
    }
  }
  const side = (c: "w" | "b") =>
    `${c === "w" ? "White" : "Black"}: ${byColor[c].join(", ") || "(none)"}`;
  return `${side("w")}\n${side("b")}`;
}

/**
 * For a specific SAN move on a position, list the concrete squares it lands on,
 * captures, and the enemy pieces it would attack from its destination — so the
 * model can describe consequences without guessing.
 */
export function describeMoveEffect(fen: string, san: string): string {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return "";
  }
  const legal = chess.moves({ verbose: true });
  const bare = san.replace(/[+#]/g, "");
  const mv = legal.find((m) => m.san.replace(/[+#]/g, "") === bare);
  if (!mv) return "";

  const facts: string[] = [`${san}: ${NAME[mv.piece]} ${mv.from}→${mv.to}`];
  if (mv.captured) facts.push(`captures the ${NAME[mv.captured]} on ${mv.to}`);

  // Make the move, then see what the moved piece attacks from its new square.
  try {
    chess.move({ from: mv.from as Square, to: mv.to as Square, promotion: "q" });
    const attacked: string[] = [];
    for (const row of chess.board()) {
      for (const cell of row) {
        if (cell && cell.color !== mv.color && chess.attackers(cell.square, mv.color).includes(mv.to as Square)) {
          attacked.push(`${NAME[cell.type]} ${cell.square}`);
        }
      }
    }
    if (attacked.length) facts.push(`from ${mv.to} it attacks: ${attacked.join(", ")}`);
    if (chess.inCheck()) facts.push("gives check");
  } catch {
    /* ignore — the base fact is enough */
  }
  return facts.join("; ");
}

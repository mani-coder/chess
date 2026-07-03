"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useEngine } from "@/hooks/useEngine";
import { EvalBar } from "@/components/EvalBar";
import { ReviewModal } from "@/components/ReviewModal";
import { uciToMove } from "@/lib/uci";
import {
  classify,
  toComparable,
  formatEval,
  CLASS_META,
  SEVERITY,
  type ClassifiedMove,
  type Classification,
} from "@/lib/classify";
import { fetchGuidance, type Level, type CoachGuidance, type CoachRequest } from "@/lib/llm";
import { saveGame, loadGame, clearGame, type SavedGame } from "@/lib/storage";

/** Difficulty presets: opponent skill level + per-move think time. */
const DIFFICULTIES = [
  { key: "beginner", label: "Beginner", skill: 1, movetime: 300 },
  { key: "casual", label: "Casual", skill: 5, movetime: 500 },
  { key: "intermediate", label: "Intermediate", skill: 10, movetime: 800 },
  { key: "advanced", label: "Advanced", skill: 15, movetime: 1000 },
  { key: "max", label: "Max", skill: 20, movetime: 1500 },
] as const;

/** The coach always analyzes at full strength so teaching is correct at any difficulty. */
const COACH_DEPTH = 14;

type PlayerColor = "w" | "b";

/** Coach's assessment of a position: eval + best line, normalized to White. */
interface EvalSnapshot {
  fen: string;
  comparable: number;
  bestUci: string | null;
  whiteCp: number | null;
  whiteMate: number | null;
  pv: string[];
}

/** Piece values, starting counts, and glyphs for the captured-piece trays. */
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START_COUNT: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const ORDER = ["q", "r", "b", "n", "p"] as const;

/** Derive captured pieces (by each side) and White's material lead from a board. */
function computeCaptured(game: Chess) {
  const counts = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } as Record<string, number>,
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } as Record<string, number>,
  };
  for (const row of game.board()) {
    for (const sq of row) {
      if (sq) counts[sq.color][sq.type]++;
    }
  }
  // Pieces of `color` that are missing = pieces the opponent captured.
  const missingOf = (color: "w" | "b") => {
    const out: string[] = [];
    for (const t of ORDER) {
      const missing = Math.max(0, START_COUNT[t] - counts[color][t]);
      for (let i = 0; i < missing; i++) out.push(t);
    }
    return out;
  };
  const material = (color: "w" | "b") =>
    ORDER.reduce((sum, t) => sum + counts[color][t] * PIECE_VALUE[t], 0);
  return {
    capturedByWhite: missingOf("b"), // black pieces White has taken
    capturedByBlack: missingOf("w"), // white pieces Black has taken
    whiteAdv: material("w") - material("b"),
  };
}

type BoardArrow = { startSquare: string; endSquare: string; color: string };
interface Illustration {
  squares: string[];
  arrows: BoardArrow[];
}

const HOVER_ARROW = "rgba(99, 102, 241, 0.9)";
// Matches SAN moves (Nf3, exd5, O-O, e8=Q+, Kc3) and bare squares (d4).
const CHESS_REF =
  /\b(O-O-O|O-O|(?:[KQRBN][a-h]?[1-8]?|[a-h])?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/g;

/**
 * Parse coach text into board highlights: resolve any SAN move against the current
 * position to draw a from→to arrow; otherwise highlight the referenced square.
 */
function illustratePoint(text: string, fen: string): Illustration {
  const squares = new Set<string>();
  const arrows: BoardArrow[] = [];
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { squares: [], arrows: [] };
  }
  const legal = chess.moves({ verbose: true });

  for (const match of text.matchAll(CHESS_REF)) {
    const token = match[1];
    const normalized = token.replace(/[+#]/g, "");
    const move = legal.find((mv) => mv.san.replace(/[+#]/g, "") === normalized);
    if (move) {
      arrows.push({ startSquare: move.from, endSquare: move.to, color: HOVER_ARROW });
      squares.add(move.to);
    } else {
      const square = token.match(/[a-h][1-8]/)?.[0];
      if (square) squares.add(square);
    }
  }
  return { squares: [...squares], arrows };
}

export function ChessGame() {
  // Two independent engines: the coach judges; the opponent plays.
  const coach = useEngine();
  const opponent = useEngine();
  const ready = coach.ready && opponent.ready;

  const gameRef = useRef(new Chess());
  const [fen, setFen] = useState(gameRef.current.fen());

  // Objective (coach) eval of the *current* position — the "before" for the next move.
  const curEvalRef = useRef<EvalSnapshot>({
    fen: gameRef.current.fen(),
    comparable: 20,
    bestUci: null,
    whiteCp: 0,
    whiteMate: null,
    pv: [],
  });

  const [playerColor, setPlayerColor] = useState<PlayerColor>("w");
  // Always-current copy of playerColor for async logic (state closures go stale
  // when a new game is started synchronously from the same event that sets it).
  const playerColorRef = useRef<PlayerColor>("w");
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTIES)[number]["key"]>("casual");
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState("Your move.");
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // tap-to-move source square
  const [moves, setMoves] = useState<ClassifiedMove[]>([]);
  const [assessment, setAssessment] = useState<ClassifiedMove | null>(null);
  const [reviewMove, setReviewMove] = useState<ClassifiedMove | null>(null);
  const [resumePrompt, setResumePrompt] = useState<SavedGame | null>(null); // saved game awaiting a decision
  const [hover, setHover] = useState<Illustration | null>(null); // coach-point board illustration
  const bootedRef = useRef(false);

  const illustrate = useCallback((text: string) => {
    setHover(illustratePoint(text, gameRef.current.fen()));
  }, []);
  const clearIllustrate = useCallback(() => setHover(null), []);

  const [evalCp, setEvalCp] = useState(0);
  const [evalMate, setEvalMate] = useState<number | null>(null);

  const preset = DIFFICULTIES.find((d) => d.key === difficulty)!;
  const orientation: "white" | "black" = playerColor === "w" ? "white" : "black";

  const describeStatus = useCallback((g: Chess) => {
    const me = playerColorRef.current;
    if (g.isCheckmate()) return g.turn() === me ? "Checkmate — you lost." : "Checkmate — you win!";
    if (g.isStalemate()) return "Draw — stalemate.";
    if (g.isInsufficientMaterial()) return "Draw — insufficient material.";
    if (g.isThreefoldRepetition()) return "Draw — threefold repetition.";
    if (g.isDraw()) return "Draw.";
    if (g.isCheck()) return g.turn() === me ? "You are in check." : "You gave check.";
    return g.turn() === me ? "Your move." : "Engine is thinking…";
  }, []);

  /** Full-strength coach analysis of a position, normalized to White's perspective. */
  const coachAnalyze = useCallback(
    async (position: string): Promise<EvalSnapshot> => {
      const engine = coach.engineRef.current;
      const stm = position.split(" ")[1] as PlayerColor;
      const sign = stm === "w" ? 1 : -1;
      if (!engine) {
        return { fen: position, comparable: 0, bestUci: null, whiteCp: 0, whiteMate: null, pv: [] };
      }
      const res = await engine.analyze(position, { depth: COACH_DEPTH });
      const whiteCp = res.scoreCp !== null ? sign * res.scoreCp : null;
      const whiteMate = res.mate !== null ? sign * res.mate : null;
      return {
        fen: position,
        comparable: toComparable(whiteCp, whiteMate),
        bestUci: res.bestMove,
        whiteCp,
        whiteMate,
        pv: res.pv,
      };
    },
    [coach.engineRef],
  );

  /** Classify the just-played move (before = curEvalRef, after = fresh coach analysis). */
  const classifyAndRecord = useCallback(
    async (fenBefore: string, uci: string, san: string, color: PlayerColor) => {
      const before = curEvalRef.current;

      let bestSan: string | null = null;
      if (before.bestUci) {
        try {
          bestSan = new Chess(fenBefore).move(uciToMove(before.bestUci)).san;
        } catch {
          /* engine's best occasionally un-mappable across edge cases; skip */
        }
      }

      const after = await coachAnalyze(gameRef.current.fen());
      setEvalCp(after.whiteCp ?? 0);
      setEvalMate(after.whiteMate);

      const sign = color === "w" ? 1 : -1;
      const loss = Math.max(0, sign * (before.comparable - after.comparable));
      const playedWasBest = !!before.bestUci && uci === before.bestUci;
      const cls = classify(loss, playedWasBest);
      const lossCp = Math.round(loss);

      // The better line is the coach's PV from fenBefore; the played line is the
      // move actually made followed by the engine's best continuation.
      const bestLine = before.pv.length ? before.pv : before.bestUci ? [before.bestUci] : [];
      const move: ClassifiedMove = {
        ply: 0,
        color,
        san,
        uci,
        classification: cls,
        lossCp,
        bestSan,
        fenBefore,
        bestLine,
        playedLine: [uci, ...after.pv],
        evalBeforeCp: before.whiteCp,
        evalBeforeMate: before.whiteMate,
        evalAfterCp: after.whiteCp,
        evalAfterMate: after.whiteMate,
      };

      setMoves((prev) => [...prev, { ...move, ply: prev.length + 1 }]);

      // This position's coach eval becomes the "before" for the next move.
      curEvalRef.current = after;

      if (color === playerColorRef.current) setAssessment(move);
    },
    [coachAnalyze],
  );

  /** Let the (skill-limited) opponent make its reply, then classify it. */
  const runEngineReply = useCallback(async () => {
    const engine = opponent.engineRef.current;
    const g = gameRef.current;
    if (!engine || g.isGameOver() || g.turn() === playerColorRef.current) return;

    const fenBefore = g.fen();
    const res = await engine.analyze(fenBefore, { movetime: preset.movetime });
    if (!res.bestMove || gameRef.current.fen() !== fenBefore) return;

    let mv;
    try {
      mv = g.move(uciToMove(res.bestMove));
    } catch {
      return;
    }
    setFen(g.fen());
    setLastMove({ from: mv.from, to: mv.to });
    setStatus(describeStatus(g));
    await classifyAndRecord(fenBefore, mv.lan, mv.san, mv.color);
  }, [opponent.engineRef, preset.movetime, classifyAndRecord, describeStatus]);

  /** Reset to a fresh game; if the player is Black, the engine opens. */
  const newGame = useCallback(
    async (color: PlayerColor) => {
      clearGame(); // abandon any saved game
      playerColorRef.current = color;
      gameRef.current = new Chess();
      setFen(gameRef.current.fen());
      setMoves([]);
      setLastMove(null);
      setSelected(null);
      setAssessment(null);
      setReviewMove(null);
      setEvalCp(0);
      setEvalMate(null);
      setThinking(false);

      const c = coach.engineRef.current;
      const o = opponent.engineRef.current;
      if (c) await c.newGame();
      if (o) {
        await o.newGame();
        await o.setSkillLevel(preset.skill);
      }

      const start = await coachAnalyze(gameRef.current.fen());
      curEvalRef.current = start;
      setEvalCp(start.whiteCp ?? 0);
      setEvalMate(start.whiteMate);
      setStatus(color === "w" ? "Your move." : "Engine is thinking…");

      if (color === "b") {
        setThinking(true);
        await runEngineReply();
        setThinking(false);
      }
    },
    [coach.engineRef, opponent.engineRef, preset.skill, coachAnalyze, runEngineReply],
  );

  // Coach runs at full strength always.
  useEffect(() => {
    if (coach.ready) void coach.engineRef.current?.setSkillLevel(20);
  }, [coach.ready, coach.engineRef]);

  // Opponent tracks the chosen difficulty (also applies mid-game).
  useEffect(() => {
    if (opponent.ready) void opponent.engineRef.current?.setSkillLevel(preset.skill);
  }, [opponent.ready, preset.skill, opponent.engineRef]);

  /** Rebuild the UI from a saved game and reseed the coach eval (engines ready). */
  const applySavedGame = useCallback(
    async (s: SavedGame) => {
      const color = s.playerColor;
      const preset = DIFFICULTIES.find((d) => d.key === s.difficulty) ?? DIFFICULTIES[1];
      playerColorRef.current = color;
      setPlayerColor(color);
      setDifficulty(preset.key);
      gameRef.current = new Chess(s.fen);
      setFen(s.fen);
      setMoves(s.moves);
      setLastMove(s.lastMove);
      setSelected(null);
      setReviewMove(null);
      setEvalCp(s.evalCp);
      setEvalMate(s.evalMate);
      // Restore the coach panel to the player's most recent move.
      const lastPlayerMove = [...s.moves].reverse().find((m) => m.color === color) ?? null;
      setAssessment(lastPlayerMove);
      setStatus(describeStatus(gameRef.current));

      await opponent.engineRef.current?.setSkillLevel(preset.skill);
      const snap = await coachAnalyze(gameRef.current.fen());
      curEvalRef.current = snap;

      // If it's the engine's turn in the restored position, let it move.
      if (!gameRef.current.isGameOver() && gameRef.current.turn() !== color) {
        setThinking(true);
        await runEngineReply();
        setThinking(false);
      }
    },
    [opponent.engineRef, coachAnalyze, runEngineReply, describeStatus],
  );

  // Boot once engines are ready: resume a saved game (via dialog) or start fresh.
  useEffect(() => {
    if (!ready || bootedRef.current) return;
    bootedRef.current = true;
    const saved = loadGame();
    if (saved && saved.moves.length > 0) {
      // Preview the saved position behind the dialog so the user can recognize it.
      // (Visual only — engines are seeded in applySavedGame if they choose Resume.)
      playerColorRef.current = saved.playerColor;
      setPlayerColor(saved.playerColor);
      const preset = DIFFICULTIES.find((d) => d.key === saved.difficulty);
      if (preset) setDifficulty(preset.key);
      gameRef.current = new Chess(saved.fen);
      setFen(saved.fen);
      setLastMove(saved.lastMove);
      setMoves(saved.moves);
      setEvalCp(saved.evalCp);
      setEvalMate(saved.evalMate);
      setResumePrompt(saved); // ask the user; don't fully start until they choose
    } else {
      void newGame(playerColor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Persist the game after every change (once booted and not awaiting a choice).
  useEffect(() => {
    if (!bootedRef.current || resumePrompt || moves.length === 0) return;
    saveGame({
      fen,
      playerColor,
      difficulty,
      moves,
      evalCp,
      evalMate,
      lastMove,
      updatedAt: Date.now(),
    });
  }, [fen, moves, playerColor, difficulty, evalCp, evalMate, lastMove, resumePrompt]);

  // Core move handler shared by drag-and-drop and tap-to-move.
  const tryMove = useCallback(
    (from: string, to: string): boolean => {
      if (thinking) return false;
      const g = gameRef.current;
      if (g.isGameOver() || g.turn() !== playerColorRef.current) return false;

      const fenBefore = g.fen();
      let mv;
      try {
        mv = g.move({ from: from as Square, to: to as Square, promotion: "q" });
      } catch {
        return false; // illegal → snap back / ignore
      }

      setSelected(null);
      setFen(g.fen());
      setLastMove({ from: mv.from, to: mv.to });
      setStatus(describeStatus(g));
      setThinking(true);

      void (async () => {
        await classifyAndRecord(fenBefore, mv.lan, mv.san, mv.color);
        if (!gameRef.current.isGameOver()) await runEngineReply();
        setThinking(false);
      })();

      return true;
    },
    [thinking, classifyAndRecord, runEngineReply, describeStatus],
  );

  const handleDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean =>
      targetSquare ? tryMove(sourceSquare, targetSquare) : false,
    [tryMove],
  );

  // Tap-to-move: tap a piece to select it, tap a destination to move there.
  const handleSquareClick = useCallback(
    ({ square, piece }: { square: string; piece: { pieceType: string } | null }) => {
      const g = gameRef.current;
      if (thinking || g.isGameOver() || g.turn() !== playerColorRef.current) return;
      const isOwnPiece = !!piece && piece.pieceType[0] === playerColorRef.current;

      if (selected) {
        if (square === selected) {
          setSelected(null); // tap the selected piece again → deselect
        } else if (tryMove(selected, square)) {
          // moved (tryMove clears selection)
        } else if (isOwnPiece) {
          setSelected(square); // switch selection to another of your pieces
        } else {
          setSelected(null); // tapped empty/illegal square → deselect
        }
        return;
      }
      if (isOwnPiece) setSelected(square);
    },
    [thinking, selected, tryMove],
  );

  const chooseColor = (color: PlayerColor) => {
    playerColorRef.current = color;
    setPlayerColor(color);
    void newGame(color);
  };

  const squareStyles: Record<string, React.CSSProperties> = {};
  if (lastMove) {
    squareStyles[lastMove.from] = { background: "rgba(255, 213, 79, 0.45)" };
    squareStyles[lastMove.to] = { background: "rgba(255, 213, 79, 0.55)" };
  }
  // Flag the king in danger: solid red on checkmate, a softer red on plain check.
  if (gameRef.current.isCheck()) {
    const inCheck = gameRef.current.turn();
    let kingSquare: string | undefined;
    for (const row of gameRef.current.board()) {
      for (const cell of row) {
        if (cell && cell.type === "k" && cell.color === inCheck) kingSquare = cell.square;
      }
    }
    if (kingSquare) {
      squareStyles[kingSquare] = gameRef.current.isCheckmate()
        ? { background: "rgba(220, 38, 38, 0.9)", boxShadow: "inset 0 0 0 3px #dc2626" }
        : { background: "rgba(220, 38, 38, 0.5)" };
    }
  }
  // Tap-to-move: highlight the selected piece and dot its legal destinations.
  if (selected) {
    squareStyles[selected] = { background: "rgba(255, 213, 79, 0.6)" };
    for (const m of gameRef.current.moves({ square: selected as Square, verbose: true })) {
      squareStyles[m.to] = m.captured
        ? { boxShadow: "inset 0 0 0 4px rgba(0,0,0,0.25)", borderRadius: "50%" }
        : {
            background:
              "radial-gradient(circle, rgba(0,0,0,0.25) 22%, transparent 24%)",
          };
    }
  }
  // Coach illustration: ring the squares referenced by the hovered guidance point.
  if (hover) {
    for (const sq of hover.squares) {
      squareStyles[sq] = { ...squareStyles[sq], boxShadow: "inset 0 0 0 4px rgba(99,102,241,0.9)" };
    }
  }

  const gameOver = gameRef.current.isGameOver();
  const canDrag =
    ready && !thinking && !gameOver && !resumePrompt && gameRef.current.turn() === playerColor;

  // Captured pieces + material lead (recomputed from the current board each render).
  const captured = computeCaptured(gameRef.current);
  const trayFor = (color: PlayerColor) =>
    color === "w"
      ? { pieces: captured.capturedByWhite, tone: "dark" as const, advantage: Math.max(0, captured.whiteAdv) }
      : { pieces: captured.capturedByBlack, tone: "light" as const, advantage: Math.max(0, -captured.whiteAdv) };
  const topColor: PlayerColor = orientation === "white" ? "b" : "w";
  const bottomColor: PlayerColor = orientation === "white" ? "w" : "b";
  const topTray = trayFor(topColor);
  const bottomTray = trayFor(bottomColor);

  // Beginner/Casual → simpler coaching language; harder presets → intermediate.
  const level: Level = difficulty === "beginner" || difficulty === "casual" ? "beginner" : "intermediate";
  const playerToMove =
    ready && !thinking && !gameOver && !resumePrompt && gameRef.current.turn() === playerColor;

  // Build the current-position guidance request (lazily, at ask time) from the
  // coach's analysis of the current position (stored in curEvalRef).
  const buildGuidanceRequest = (): CoachRequest => {
    const cur = curEvalRef.current;
    const sans: string[] = [];
    try {
      const tmp = new Chess(cur.fen);
      for (const u of cur.pv.slice(0, 8)) sans.push(tmp.move(uciToMove(u)).san);
    } catch {
      /* PV occasionally has an edge-case move; partial line is fine */
    }
    const sign = playerColor === "w" ? 1 : -1;
    return {
      fen: cur.fen,
      sideToMove: playerColor,
      evalForPlayer: formatEval(
        cur.whiteCp === null ? null : sign * cur.whiteCp,
        cur.whiteMate === null ? null : sign * cur.whiteMate,
      ),
      bestLineSan: sans,
      level,
    };
  };

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-4 sm:p-6 lg:h-screen lg:grid-cols-[1fr_22rem] lg:grid-rows-[auto_1fr] lg:gap-x-6 lg:gap-y-4 lg:overflow-hidden lg:p-6">
      {/* BOARD — mobile: 1st · desktop: top-left */}
      <section className="flex flex-col items-center lg:col-start-1 lg:row-start-1 lg:min-h-0">
        {/* Captured-piece trays + eval bar + board */}
        <div className="flex w-full max-w-[560px] flex-col gap-1.5">
          {/* Trays sit inset by the eval-bar width (w-7) + gap (gap-3) = 40px, to align with the board. */}
          <CapturedTray {...topTray} className="pl-10" />
          <div className="flex items-stretch justify-center gap-3">
            <EvalBar cp={evalCp} mate={evalMate} orientation={orientation} />
            {/* On large screens size by height so the board always fits the viewport. */}
            <div className="aspect-square w-full max-w-[520px] lg:h-[min(56vh,520px)] lg:w-auto">
              <Chessboard
                options={{
                  id: "coach-board",
                  position: fen,
                  boardOrientation: orientation,
                  onPieceDrop: handleDrop,
                  onSquareClick: handleSquareClick,
                  allowDragging: canDrag,
                  animationDurationInMs: 200,
                  arrows: hover?.arrows ?? [],
                  squareStyles,
                  darkSquareStyle: { backgroundColor: "#6f8f6a" },
                  lightSquareStyle: { backgroundColor: "#eff2e6" },
                }}
              />
            </div>
          </div>
          <CapturedTray {...bottomTray} className="pl-10" />
        </div>
      </section>

      {/* COACH / LLM — mobile: 2nd · desktop: right column, full height, scrolls internally */}
      <aside className="flex flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
        <div>
          <h1 className="text-xl font-bold">Chess Coach</h1>
          <p className="text-sm text-neutral-500">{ready ? status : "Loading engines…"}</p>
        </div>

        <CoachPanel assessment={assessment} onReview={setReviewMove} />

        <CoachHint
          buildRequest={buildGuidanceRequest}
          canAsk={playerToMove}
          onIllustrate={illustrate}
          onClear={clearIllustrate}
        />
      </aside>

      {/* SETTINGS — mobile: 3rd · desktop: bottom-left */}
      <section className="flex min-h-0 flex-col items-center lg:col-start-1 lg:row-start-2">
        <div className="flex w-full max-w-[560px] flex-col gap-3 lg:min-h-0 lg:flex-1">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[150px] flex-1 space-y-1">
              <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Difficulty
              </label>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}
                className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
              >
                {DIFFICULTIES.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label} (skill {d.skill})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Play as
              </label>
              <div className="flex gap-2">
                {(["w", "b"] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => chooseColor(c)}
                    className={`rounded-md border px-3 py-2 text-sm transition ${
                      playerColor === c
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                        : "border-neutral-300 dark:border-neutral-700"
                    }`}
                  >
                    {c === "w" ? "White" : "Black"}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => void newGame(playerColor)}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
            >
              New game
            </button>
          </div>

          <MoveList moves={moves} onSelect={setReviewMove} className="lg:min-h-0 lg:flex-1" />
        </div>
      </section>

      <ReviewModal
        move={reviewMove}
        playerColor={playerColor}
        level={level}
        onClose={() => setReviewMove(null)}
      />

      {resumePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900">
            <div>
              <h2 className="text-lg font-bold">Resume your game?</h2>
              <p className="mt-1 text-sm text-neutral-500">
                You have a game in progress — {Math.ceil(resumePrompt.moves.length / 2)} moves,
                playing as {resumePrompt.playerColor === "w" ? "White" : "Black"}. Continue where you
                left off?
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const saved = resumePrompt;
                  setResumePrompt(null);
                  void applySavedGame(saved);
                }}
                className="flex-1 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
              >
                Resume
              </button>
              <button
                onClick={() => {
                  setResumePrompt(null);
                  clearGame();
                  void newGame(playerColor);
                }}
                className="flex-1 rounded-md border border-neutral-300 px-4 py-2 text-sm font-semibold transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                New game
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shows the coach's verdict on the player's most recent move, with engine facts. */
function CoachPanel({
  assessment,
  onReview,
}: {
  assessment: ClassifiedMove | null;
  onReview: (m: ClassifiedMove) => void;
}) {
  if (!assessment) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-400 dark:border-neutral-700">
        Make a move — the coach will tell you how good it was and show you what was best.
      </div>
    );
  }

  const meta = CLASS_META[assessment.classification];
  const isBest = assessment.classification === "best";
  const bestText =
    !isBest && assessment.bestSan ? `The engine preferred ${assessment.bestSan}.` : "";

  return (
    <div className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-bold ${meta.badge}`}>{meta.label}</span>
        <span className="font-mono text-sm">{assessment.san}</span>
      </div>
      {isBest ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Nicely done — that was the engine&apos;s top choice.
        </p>
      ) : (
        <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <SeverityMeter classification={assessment.classification} />
          {bestText && <span>{bestText}</span>}
        </div>
      )}
      {assessment.bestLine.length > 0 && (
        <button
          onClick={() => onReview(assessment)}
          className="w-full rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-emerald-700"
        >
          {isBest ? "▶ Watch how it plays out" : "▶ Show me the better line"}
        </button>
      )}
    </div>
  );
}

/** On-demand positional coaching for the current position — guides thinking
 *  without revealing the engine's move. Hover/tap a line to see it on the board. */
function CoachHint({
  buildRequest,
  canAsk,
  onIllustrate,
  onClear,
}: {
  buildRequest: () => CoachRequest;
  canAsk: boolean;
  onIllustrate: (text: string) => void;
  onClear: () => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [guidance, setGuidance] = useState<CoachGuidance | null>(null);
  const [pinned, setPinned] = useState<string | null>(null); // tapped line (mobile) stays lit

  const ask = async () => {
    setState("loading");
    setGuidance(null);
    setPinned(null);
    onClear();
    try {
      setGuidance(await fetchGuidance(buildRequest()));
      setState("idle");
    } catch {
      setState("error");
    }
  };

  // Hover shows a line on the board; tap pins it (for touch); leaving reverts to the pin.
  const lineHandlers = (text: string) => ({
    onMouseEnter: () => onIllustrate(text),
    onMouseLeave: () => (pinned ? onIllustrate(pinned) : onClear()),
    onClick: () => {
      if (pinned === text) {
        setPinned(null);
        onClear();
      } else {
        setPinned(text);
        onIllustrate(text);
      }
    },
    title: "Hover or tap to see it on the board",
  });
  const pinRing = (text: string) => (pinned === text ? " ring-2 ring-indigo-400" : "");

  return (
    <div className="space-y-2 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <button
        onClick={ask}
        disabled={!canAsk || state === "loading"}
        className="w-full rounded-md bg-indigo-600 px-3 py-1.5 font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-40"
      >
        {state === "loading" ? "Thinking…" : "💡 Coach me — what should I think about?"}
      </button>
      {state === "loading" && (
        <p className="animate-pulse text-neutral-400">Thinking through the position…</p>
      )}
      {state === "error" && (
        <p className="text-neutral-400">Couldn&apos;t reach the coach. Try again.</p>
      )}
      {guidance && (
        <div className="space-y-2">
          <p
            {...lineHandlers(guidance.headline)}
            className={`-mx-1 cursor-pointer rounded px-1 font-semibold text-neutral-800 hover:bg-indigo-50 dark:text-neutral-200 dark:hover:bg-indigo-900/30${pinRing(
              guidance.headline,
            )}`}
          >
            {guidance.headline}
          </p>
          {guidance.points.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-400">
              {guidance.points.map((p, i) => (
                <li
                  key={i}
                  {...lineHandlers(p)}
                  className={`cursor-pointer rounded px-1 hover:bg-indigo-50 dark:hover:bg-indigo-900/30${pinRing(
                    p,
                  )}`}
                >
                  {p}
                </li>
              ))}
            </ul>
          )}
          {guidance.question && (
            <p
              {...lineHandlers(guidance.question)}
              className={`cursor-pointer rounded bg-indigo-50 px-2 py-1.5 italic text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300${pinRing(
                guidance.question,
              )}`}
            >
              {guidance.question}
            </p>
          )}
          <p className="text-xs text-neutral-400">Hover or tap a line to see it on the board.</p>
        </div>
      )}
    </div>
  );
}

/** A row of captured pieces plus the material lead, shown above/below the board. */
function CapturedTray({
  pieces,
  tone,
  advantage,
  className,
}: {
  pieces: string[];
  tone: "light" | "dark";
  advantage: number;
  className?: string;
}) {
  return (
    <div className={`flex h-5 items-center gap-px text-lg leading-none ${className ?? ""}`}>
      {pieces.map((p, i) => (
        <span key={i} className={tone === "light" ? "text-neutral-100" : "text-neutral-500"}>
          {GLYPH[p]}
        </span>
      ))}
      {advantage > 0 && (
        <span className="ml-1 text-xs font-semibold text-neutral-400">+{advantage}</span>
      )}
    </div>
  );
}

/** Small 5-segment bar showing how costly a move was (empty = fine, full = blunder). */
function SeverityMeter({ classification }: { classification: Classification }) {
  const filled = SEVERITY[classification];
  const bar = CLASS_META[classification].bar;
  return (
    <span
      className="inline-flex shrink-0 gap-0.5 align-middle"
      title={`Severity: ${CLASS_META[classification].label}`}
      aria-label={`Move severity ${filled} out of 5`}
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={`h-2.5 w-2.5 rounded-[2px] ${
            i < filled ? bar : "bg-neutral-200 dark:bg-neutral-700"
          }`}
        />
      ))}
    </span>
  );
}

/** Color-coded, paired move list. Clicking a move opens its review animation. */
function MoveList({
  moves,
  onSelect,
  className,
}: {
  moves: ClassifiedMove[];
  onSelect: (m: ClassifiedMove) => void;
  className?: string;
}) {
  const rows: { n: number; white?: ClassifiedMove; black?: ClassifiedMove }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ n: i / 2 + 1, white: moves[i], black: moves[i + 1] });
  }

  const cell = (m?: ClassifiedMove) => {
    if (!m) return <span className="w-20" />;
    const meta = CLASS_META[m.classification];
    return (
      <button
        onClick={() => onSelect(m)}
        className={`w-20 rounded text-left font-mono hover:bg-neutral-100 dark:hover:bg-neutral-800 ${meta.text}`}
        title={`${meta.label}${
          m.bestSan && m.classification !== "best" ? ` · best ${m.bestSan}` : ""
        } · click to review`}
      >
        {m.san}
        {meta.symbol && <span className="ml-0.5">{meta.symbol}</span>}
      </button>
    );
  };

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ""}`}>
      <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Moves</label>
      <div className="mt-2 max-h-64 min-h-0 flex-1 overflow-y-auto rounded-md border border-neutral-200 text-sm dark:border-neutral-800 lg:max-h-none">
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-neutral-400">No moves yet.</p>
        ) : (
          rows.map((r) => (
            <div
              key={r.n}
              className="flex gap-2 px-3 py-1 odd:bg-neutral-50 dark:odd:bg-neutral-900/40"
            >
              <span className="w-6 text-neutral-400">{r.n}.</span>
              {cell(r.white)}
              {cell(r.black)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

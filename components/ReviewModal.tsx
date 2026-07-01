"use client";

import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { uciToMove } from "@/lib/uci";
import { CLASS_META, formatEval, type ClassifiedMove } from "@/lib/classify";
import { fetchExplanation, type Level, type MoveExplanation } from "@/lib/llm";

interface LineStep {
  fen: string;
  san: string | null;
  from: string | null;
  to: string | null;
}

/** Replay a UCI line from a starting FEN into per-ply steps (step 0 = start). */
function buildLine(fenBefore: string, uci: string[], maxPlies = 8): LineStep[] {
  const g = new Chess(fenBefore);
  const steps: LineStep[] = [{ fen: fenBefore, san: null, from: null, to: null }];
  for (const u of uci.slice(0, maxPlies)) {
    let mv;
    try {
      mv = g.move(uciToMove(u));
    } catch {
      break;
    }
    steps.push({ fen: g.fen(), san: mv.san, from: mv.from, to: mv.to });
  }
  return steps;
}

type Mode = "best" | "played";

/** Auto-play speed multipliers to cycle through. */
const SPEEDS = [0.5, 1, 2] as const;
/** Base delay between plies at 1× (ms). */
const BASE_DELAY = 850;

export function ReviewModal({
  move,
  playerColor,
  level,
  onClose,
}: {
  move: ClassifiedMove | null;
  playerColor: "w" | "b";
  level: Level;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("best");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [explain, setExplain] = useState<MoveExplanation | null>(null);
  const [explainState, setExplainState] = useState<"idle" | "loading" | "error">("idle");

  // Reset whenever a different move is opened.
  useEffect(() => {
    setMode("best");
    setStep(0);
    setPlaying(false);
  }, [move]);

  const bestSteps = useMemo(() => (move ? buildLine(move.fenBefore, move.bestLine) : []), [move]);
  const playedSteps = useMemo(() => (move ? buildLine(move.fenBefore, move.playedLine) : []), [move]);
  const steps = mode === "best" ? bestSteps : playedSteps;

  // Clamp step if the active line is shorter (e.g. switching modes).
  useEffect(() => {
    setStep((s) => Math.min(s, Math.max(0, steps.length - 1)));
  }, [steps.length]);

  // Auto-play through the line.
  useEffect(() => {
    if (!playing) return;
    if (step >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => s + 1), BASE_DELAY / speed);
    return () => clearTimeout(t);
  }, [playing, step, steps.length, speed]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setStep((s) => Math.min(s + 1, steps.length - 1));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, steps.length]);

  // Fetch the LLM explanation whenever a move is opened (cached in lib/llm).
  useEffect(() => {
    if (!move) {
      setExplain(null);
      setExplainState("idle");
      return;
    }
    const sign = move.color === "w" ? 1 : -1;
    const persp = (cp: number | null, mate: number | null) =>
      formatEval(cp === null ? null : sign * cp, mate === null ? null : sign * mate);

    const controller = new AbortController();
    setExplain(null);
    setExplainState("loading");
    fetchExplanation(
      {
        fen: move.fenBefore,
        sideToMove: move.color,
        playedSan: move.san,
        bestSan: move.bestSan,
        classification: move.classification,
        betterLine: bestSteps.slice(1).map((s) => s.san ?? "").filter(Boolean),
        playedLine: playedSteps.slice(1).map((s) => s.san ?? "").filter(Boolean),
        evalBefore: persp(move.evalBeforeCp, move.evalBeforeMate),
        evalAfter: persp(move.evalAfterCp, move.evalAfterMate),
        level,
      },
      controller.signal,
    )
      .then((r) => {
        setExplain(r);
        setExplainState("idle");
      })
      .catch(() => {
        if (!controller.signal.aborted) setExplainState("error");
      });
    return () => controller.abort();
  }, [move, level, bestSteps, playedSteps]);

  if (!move) return null;

  const orientation: "white" | "black" = move.color === "w" ? "white" : "black";
  const cur = steps[step] ?? steps[0];
  const next = steps[step + 1];
  const meta = CLASS_META[move.classification];

  const arrowColor = mode === "best" ? "rgba(34,197,94,0.9)" : "rgba(59,130,246,0.9)";
  const arrows =
    next && next.from && next.to
      ? [{ startSquare: next.from, endSquare: next.to, color: arrowColor }]
      : [];
  const squareStyles: Record<string, React.CSSProperties> =
    cur.from && cur.to
      ? {
          [cur.from]: { background: "rgba(255,213,79,0.45)" },
          [cur.to]: { background: "rgba(255,213,79,0.55)" },
        }
      : {};

  // Show evals from the mover's perspective so "higher = better for the side that
  // moved". White-perspective numbers are confusing when the mover is Black.
  const moverSign = move.color === "w" ? 1 : -1;
  const persp = (cp: number | null, mate: number | null) =>
    formatEval(cp === null ? null : moverSign * cp, mate === null ? null : moverSign * mate);
  const bestEval = persp(move.evalBeforeCp, move.evalBeforeMate);
  const playedEval = persp(move.evalAfterCp, move.evalAfterMate);

  const isPlayerMove = move.color === playerColor;
  const moverNoun = isPlayerMove ? "you" : "the engine";
  const playedLabel = isPlayerMove ? "Your move" : "Engine move";

  const lineSans = steps.slice(1).map((s) => s.san ?? "");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex w-full max-w-3xl flex-col gap-4 rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900 sm:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Board */}
        <div className="w-full sm:w-[360px]">
          <div className="aspect-square w-full">
            <Chessboard
              options={{
                id: "review-board",
                position: cur.fen,
                boardOrientation: orientation,
                allowDragging: false,
                allowDrawingArrows: false,
                clearArrowsOnPositionChange: false,
                arrows,
                animationDurationInMs: 250,
                squareStyles,
                darkSquareStyle: { backgroundColor: "#6f8f6a" },
                lightSquareStyle: { backgroundColor: "#eff2e6" },
              }}
            />
          </div>
        </div>

        {/* Side panel */}
        <div className="flex flex-1 flex-col gap-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-bold ${meta.badge}`}>{meta.label}</span>
              <span className="font-mono text-sm">{move.san}</span>
            </div>
            <button
              onClick={onClose}
              className="rounded p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Mode toggle */}
          <div className="flex overflow-hidden rounded-md border border-neutral-300 text-sm dark:border-neutral-700">
            <button
              onClick={() => setMode("best")}
              className={`flex-1 px-3 py-1.5 ${
                mode === "best"
                  ? "bg-emerald-600 text-white"
                  : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              Better line ({bestEval})
            </button>
            <button
              onClick={() => setMode("played")}
              className={`flex-1 px-3 py-1.5 ${
                mode === "played"
                  ? "bg-blue-600 text-white"
                  : "text-neutral-600 dark:text-neutral-300"
              }`}
            >
              {playedLabel} ({playedEval})
            </button>
          </div>

          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {mode === "best"
              ? move.classification === "best"
                ? `That was the engine's top choice — here it is played out (${bestEval} for ${moverNoun}).`
                : `The engine preferred ${move.bestSan} — it leaves ${moverNoun} at ${bestEval} instead of ${playedEval}. Step through to see why.`
              : `Here's how the game likely continues after ${move.san} (${playedEval} for ${moverNoun}).`}
          </p>
          <p className="text-xs text-neutral-400">
            Scores are from {moverNoun === "you" ? "your" : "the engine's"} point of view — higher is
            better for {moverNoun}.
          </p>

          {/* LLM explanation + reusable principle */}
          <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Coach
            </div>
            {explainState === "loading" && (
              <p className="animate-pulse text-sm text-neutral-400">Thinking through the position…</p>
            )}
            {explainState === "error" && (
              <p className="text-sm text-neutral-400">Explanation unavailable right now.</p>
            )}
            {explain && (
              <div className="space-y-2">
                <p className="text-sm text-neutral-700 dark:text-neutral-300">{explain.explanation}</p>
                {explain.principle && (
                  <p className="rounded bg-emerald-50 px-2 py-1.5 text-sm text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                    <span className="font-semibold">Principle:</span> {explain.principle}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* SAN line with clickable steps */}
          <div className="flex flex-wrap gap-1 text-sm">
            {lineSans.length === 0 ? (
              <span className="text-neutral-400">No continuation available.</span>
            ) : (
              lineSans.map((san, i) => (
                <button
                  key={i}
                  onClick={() => setStep(i + 1)}
                  className={`rounded px-1.5 py-0.5 font-mono ${
                    step === i + 1
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  }`}
                >
                  {san}
                </button>
              ))
            )}
          </div>

          {/* Step controls */}
          <div className="mt-auto flex items-center gap-2">
            <button
              onClick={() => {
                setPlaying(false);
                setStep(0);
              }}
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
              title="Start"
            >
              ⏮
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                setStep((s) => Math.max(0, s - 1));
              }}
              disabled={step === 0}
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-40 dark:border-neutral-700"
              title="Previous"
            >
              ◀
            </button>
            <button
              onClick={() => setPlaying((p) => !p)}
              disabled={steps.length <= 1}
              className="flex-1 rounded-md bg-neutral-900 px-3 py-1 text-sm font-semibold text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
            >
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                setStep((s) => Math.min(steps.length - 1, s + 1));
              }}
              disabled={step >= steps.length - 1}
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:opacity-40 dark:border-neutral-700"
              title="Next"
            >
              ▶
            </button>
            <button
              onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
              className="w-10 rounded-md border border-neutral-300 px-2 py-1 text-sm tabular-nums dark:border-neutral-700"
              title="Playback speed"
            >
              {speed}×
            </button>
            <span className="w-10 text-right text-xs text-neutral-500">
              {step}/{steps.length - 1}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

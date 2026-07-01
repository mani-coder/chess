"use client";

/** Convert a White-perspective centipawn score into a 0–1 win probability. */
function cpToWhiteProb(cp: number): number {
  return 1 / (1 + Math.pow(10, -cp / 400));
}

interface EvalBarProps {
  /** Centipawn score from White's perspective (positive = White better). */
  cp: number;
  /** Mate-in-N from White's perspective (positive = White mates). null otherwise. */
  mate: number | null;
  /** Board orientation, so White's slice sits on the correct side. */
  orientation: "white" | "black";
}

export function EvalBar({ cp, mate, orientation }: EvalBarProps) {
  const prob = mate !== null ? (mate > 0 ? 1 : 0) : cpToWhiteProb(cp);
  const whitePct = Math.round(prob * 100);

  const label =
    mate !== null
      ? `M${Math.abs(mate)}`
      : `${cp >= 0 ? "+" : "−"}${Math.abs(cp / 100).toFixed(1)}`;

  const whiteOnBottom = orientation === "white";

  return (
    <div
      className="relative w-7 self-stretch overflow-hidden rounded bg-neutral-800 text-[10px] font-semibold"
      title="Engine evaluation (White's perspective)"
    >
      <div
        className="absolute inset-x-0 bg-neutral-100 transition-[height] duration-300 ease-out"
        style={{ height: `${whitePct}%`, [whiteOnBottom ? "bottom" : "top"]: 0 }}
      />
      {/* Label pinned to whichever side White occupies. */}
      <span
        className="absolute inset-x-0 text-center text-neutral-900"
        style={{ [whiteOnBottom ? "bottom" : "top"]: 2 }}
      >
        {whitePct >= 50 ? label : ""}
      </span>
      <span
        className="absolute inset-x-0 text-center text-neutral-100"
        style={{ [whiteOnBottom ? "top" : "bottom"]: 2 }}
      >
        {whitePct < 50 ? label : ""}
      </span>
    </div>
  );
}

// Client-side helpers for the LLM coaching endpoints. These only call our own
// API routes (the DeepSeek key stays server-side). Results are cached in-memory
// for the session so re-opening the same move / re-asking on the same position
// is instant and free.

export type Level = "beginner" | "intermediate";

export interface MoveExplanation {
  explanation: string;
  principle: string;
}

export interface CoachGuidance {
  headline: string;
  points: string[];
  question: string;
}

export interface ExplainRequest {
  fen: string;
  sideToMove: "w" | "b";
  playedSan: string;
  bestSan: string | null;
  classification: string;
  betterLine: string[];
  playedLine: string[];
  evalBefore: string;
  evalAfter: string;
  level: Level;
}

export interface CoachRequest {
  fen: string;
  sideToMove: "w" | "b";
  evalForPlayer: string;
  bestLineSan: string[];
  level: Level;
}

const explainCache = new Map<string, MoveExplanation>();
const coachCache = new Map<string, CoachGuidance>();

export async function fetchExplanation(
  req: ExplainRequest,
  signal?: AbortSignal,
): Promise<MoveExplanation> {
  const key = `${req.fen}|${req.playedSan}|${req.bestSan}|${req.level}`;
  const hit = explainCache.get(key);
  if (hit) return hit;

  const res = await fetch("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? `explain ${res.status}`);

  const out: MoveExplanation = {
    explanation: data.explanation ?? "",
    principle: data.principle ?? "",
  };
  explainCache.set(key, out);
  return out;
}

export async function fetchGuidance(
  req: CoachRequest,
  signal?: AbortSignal,
): Promise<CoachGuidance> {
  const key = `${req.fen}|${req.level}`;
  const hit = coachCache.get(key);
  if (hit) return hit;

  const res = await fetch("/api/coach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? `coach ${res.status}`);

  const out: CoachGuidance = {
    headline: data.headline ?? "",
    points: Array.isArray(data.points) ? data.points : [],
    question: data.question ?? "",
  };
  coachCache.set(key, out);
  return out;
}

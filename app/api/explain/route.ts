import { NextResponse } from "next/server";
import { callLLMJSON, levelInstruction } from "@/lib/llm-provider";
import { describeBoard, describeMoveEffect } from "@/lib/board-facts";

// Reasoning models (e.g. Kimi) can take 10-15s; keep the function alive long enough.
export const maxDuration = 60;

interface ExplainRequest {
  fen: string;
  sideToMove: "w" | "b";
  playedSan: string;
  bestSan: string | null;
  classification: string;
  betterLine: string[];
  playedLine: string[];
  evalBefore: string; // player-perspective, e.g. "+0.7"
  evalAfter: string; // player-perspective, e.g. "+0.5"
  level: "beginner" | "intermediate";
}

// In-memory cache (per server instance) so repeated opens of the same move are free.
const cache = new Map<string, { explanation: string; principle: string }>();

export async function POST(req: Request) {
  let body: ExplainRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const sig = `${body.fen}|${body.playedSan}|${body.bestSan}|${body.level}`;
  const cached = cache.get(sig);
  if (cached) return NextResponse.json(cached);

  const side = body.sideToMove === "w" ? "White" : "Black";
  const system = `You are a friendly, concise chess coach. Explain WHY the engine's move is stronger, grounded ONLY in the facts provided. ${levelInstruction(body.level)}
STRICT RULES:
- Only mention pieces and pawns that appear in the "Board" list below. NEVER invent a piece, pawn, or square that is not listed — if you are unsure a piece exists, do not mention it.
- Do not invent evaluations, moves, or lines beyond what is given.
- If the player already played the best move, affirm it briefly and explain the idea behind it.
Respond in JSON with exactly these fields:
"explanation": 2-4 sentences on why the better move is stronger and what the played move gave up, referencing concrete squares/pieces from the board and the given lines.
"principle": one short, reusable takeaway — a general principle the player can carry into other games.`;

  const bestEffect = body.bestSan ? describeMoveEffect(body.fen, body.bestSan) : "";
  const playedEffect = describeMoveEffect(body.fen, body.playedSan);

  const user = [
    `Board (ground truth — only reference these pieces):`,
    describeBoard(body.fen),
    `It is ${side} to move — this is the player.`,
    `Player played: ${body.playedSan} (engine classified it: ${body.classification}), leaving the player at ${body.evalAfter}.`,
    playedEffect ? `Played-move facts: ${playedEffect}` : "",
    body.bestSan
      ? `Engine's best move: ${body.bestSan}, leaving the player at ${body.evalBefore}.`
      : "",
    bestEffect ? `Best-move facts: ${bestEffect}` : "",
    body.betterLine.length ? `Engine's better line: ${body.betterLine.join(" ")}` : "",
    body.playedLine.length
      ? `Likely continuation after the played move: ${body.playedLine.join(" ")}`
      : "",
    `Scores are from the player's point of view; higher is better for the player.`,
    `Respond in JSON.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const out = await callLLMJSON(system, user);
    const result = {
      explanation: String(out.explanation ?? "No explanation available."),
      principle: String(out.principle ?? ""),
    };
    cache.set(sig, result);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

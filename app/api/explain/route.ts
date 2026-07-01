import { NextResponse } from "next/server";
import { callLLMJSON, levelInstruction } from "@/lib/llm-provider";

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
  const system = `You are a friendly, concise chess coach. Explain WHY the engine's move is stronger, grounded ONLY in the facts provided. Never invent evaluations, moves, or lines beyond what is given. ${levelInstruction(body.level)}
If the player already played the best move, affirm it briefly and explain the idea behind it.
Respond in JSON with exactly these fields:
"explanation": 2-4 sentences on why the better move is stronger and what the played move gave up, referencing the given lines concretely and in plain terms.
"principle": one short, reusable takeaway — a general principle the player can carry into other games.`;

  const user = [
    `Position (FEN): ${body.fen}`,
    `It is ${side} to move — this is the player.`,
    `Player played: ${body.playedSan} (engine classified it: ${body.classification}), leaving the player at ${body.evalAfter}.`,
    body.bestSan
      ? `Engine's best move: ${body.bestSan}, leaving the player at ${body.evalBefore}.`
      : "",
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

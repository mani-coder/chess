import { NextResponse } from "next/server";
import { callLLMJSON, levelInstruction } from "@/lib/llm-provider";
import { describeBoard } from "@/lib/board-facts";

// Reasoning models (e.g. Kimi) can take 10-15s; keep the function alive long enough.
export const maxDuration = 60;

interface CoachRequest {
  fen: string;
  sideToMove: "w" | "b";
  evalForPlayer: string; // player-perspective, e.g. "+0.4"
  bestLineSan: string[]; // engine's best line — used to inform guidance, NOT revealed
  level: "beginner" | "intermediate";
}

const cache = new Map<string, { headline: string; points: string[]; question: string }>();

export async function POST(req: Request) {
  let body: CoachRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const sig = `${body.fen}|${body.level}`;
  const cached = cache.get(sig);
  if (cached) return NextResponse.json(cached);

  const side = body.sideToMove === "w" ? "White" : "Black";
  const system = `You are a patient chess coach who helps a player THINK for themselves — you never spoon-feed the move. You are given the engine's evaluation and its best line for the current position; the player is to move.
CRITICAL RULES:
- Do NOT tell the player which move to play, and do NOT name any move from the engine's line. Guide their thinking: what to notice, which strategic ideas or plans matter, what to weigh. Use the engine's line only to keep your guidance sound — express it as strategy, never as the move.
- Only mention pieces and pawns that appear in the "Board" list below. NEVER invent a piece, pawn, or square that is not listed. Refer to concrete squares (e.g. "your knight on d5") so the player can find them.
${levelInstruction(body.level)}
Respond in JSON with exactly these fields:
"headline": one short sentence naming the single most important thing to focus on right now.
"points": an array of 2-3 short, position-specific strategic ideas or things to evaluate (king safety, undeveloped pieces, weak squares, targets, pawn breaks, etc.).
"question": one guiding question that nudges the player to find a strong move themselves.`;

  const user = [
    `Board (ground truth — only reference these pieces):`,
    describeBoard(body.fen),
    `It is ${side} to move — this is the player.`,
    `Current evaluation from the player's point of view: ${body.evalForPlayer} (higher is better for the player).`,
    body.bestLineSan.length
      ? `Engine's best line (for your understanding only — DO NOT reveal or name these moves): ${body.bestLineSan.join(" ")}`
      : "",
    `Respond in JSON.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const out = await callLLMJSON(system, user);
    const result = {
      headline: String(out.headline ?? "Look at the whole board before committing."),
      points: Array.isArray(out.points) ? out.points.map(String).slice(0, 3) : [],
      question: String(out.question ?? ""),
    };
    cache.set(sig, result);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

// Server-only DeepSeek client. The API key never leaves the server.
// DeepSeek exposes an OpenAI-compatible chat-completions endpoint.

const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";

/**
 * Call DeepSeek in JSON mode and return the parsed object. Throws on missing key,
 * HTTP errors, timeouts, or unparseable output — callers should catch.
 */
export async function callDeepSeekJSON(
  system: string,
  user: string,
  maxTokens = 450,
): Promise<Record<string, unknown>> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("Missing DEEPSEEK_API_KEY");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.5,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`DeepSeek ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content);
}

/** Level-appropriate instruction snippet shared by both coaching routes. */
export function levelInstruction(level: string): string {
  return level === "intermediate"
    ? "The player is intermediate. You may use standard chess terms (outpost, tempo, file, diagonal, initiative), but stay concise."
    : "The player is a beginner. Use simple, everyday language and briefly explain any chess term you use.";
}

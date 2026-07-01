// Server-only, provider-agnostic LLM client. Any OpenAI-compatible chat API works
// (DeepSeek, NVIDIA NIM, Moonshot/Kimi, OpenRouter, …). Switch providers with env
// vars only — no code change:
//
//   LLM_PROVIDER   deepseek | nvidia | moonshot | openrouter   (default: deepseek)
//   LLM_API_KEY    explicit key override. Otherwise the active provider's own key
//                  var is used: DEEPSEEK_API_KEY / NVIDIA_API_KEY /
//                  KIMI_API_KEY (or MOONSHOT_API_KEY) / OPENROUTER_API_KEY.
//   LLM_MODEL      model id override        (sensible default per provider)
//   LLM_BASE_URL   base URL override        (optional; overrides the preset)
//   LLM_TEMPERATURE  sampling temperature   (default 0.5; some models require 1)
//   LLM_MAX_TOKENS   completion token cap   (raise for reasoning models like Kimi)
//   LLM_JSON_MODE  "false" to skip response_format if a provider rejects it
//   LLM_EXTRA_BODY JSON merged into the request body — for provider-specific
//                  params, e.g. '{"chat_template_kwargs":{"thinking":false}}'

interface ProviderPreset {
  baseUrl: string;
  defaultModel: string;
}

const PRESETS: Record<string, ProviderPreset> = {
  deepseek: { baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", defaultModel: "moonshotai/kimi-k2-instruct" },
  // moonshot-v1-auto is fast & non-reasoning (ideal for narration). The kimi-k2.x
  // models are reasoning models — much slower (10-30s), set them explicitly if wanted.
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", defaultModel: "moonshot-v1-auto" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", defaultModel: "moonshotai/kimi-k2" },
};

// Per-provider key env vars, so all keys can live in env and you flip with LLM_PROVIDER.
const KEY_ENV: Record<string, string[]> = {
  deepseek: ["DEEPSEEK_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  moonshot: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

function resolveConfig() {
  const provider = (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase();
  const preset = PRESETS[provider];
  const providerKey = (KEY_ENV[provider] ?? []).map((name) => process.env[name]).find(Boolean);
  return {
    provider,
    baseUrl: process.env.LLM_BASE_URL ?? preset?.baseUrl,
    model: process.env.LLM_MODEL ?? preset?.defaultModel,
    apiKey: process.env.LLM_API_KEY ?? providerKey ?? process.env.DEEPSEEK_API_KEY,
    temperature: process.env.LLM_TEMPERATURE ? Number(process.env.LLM_TEMPERATURE) : 0.5,
    maxTokensEnv: process.env.LLM_MAX_TOKENS ? parseInt(process.env.LLM_MAX_TOKENS, 10) : null,
    jsonMode: (process.env.LLM_JSON_MODE ?? "true").toLowerCase() !== "false",
    extraBody: parseExtraBody(process.env.LLM_EXTRA_BODY),
  };
}

function parseExtraBody(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("[llm] LLM_EXTRA_BODY is not valid JSON — ignoring");
    return {};
  }
}

/**
 * Call the configured LLM and return the parsed JSON object. Throws on missing
 * config, HTTP errors, timeouts, or unparseable output — callers should catch.
 */
export async function callLLMJSON(
  system: string,
  user: string,
  maxTokens = 800,
): Promise<Record<string, unknown>> {
  const { provider, baseUrl, model, apiKey, temperature, maxTokensEnv, jsonMode, extraBody } =
    resolveConfig();
  if (!apiKey) throw new Error(`Missing API key for provider "${provider}"`);
  if (!baseUrl) throw new Error(`Unknown LLM_PROVIDER "${provider}" and no LLM_BASE_URL set`);
  if (!model) throw new Error("No LLM_MODEL set for this provider");

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokensEnv ?? maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...extraBody,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  return extractJSON(content);
}

/** Tolerant JSON parse — handles ```json fences and stray prose around the object. */
function extractJSON(content: string): Record<string, unknown> {
  let s = String(content).trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to substring extraction */
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      /* give up below */
    }
  }
  throw new Error("Could not parse JSON from model output");
}

/** Level-appropriate instruction snippet shared by both coaching routes. */
export function levelInstruction(level: string): string {
  return level === "intermediate"
    ? "The player is intermediate. You may use standard chess terms (outpost, tempo, file, diagonal, initiative), but stay concise."
    : "The player is a beginner. Use simple, everyday language and briefly explain any chess term you use.";
}

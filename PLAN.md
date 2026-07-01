# Chess Coach — Project Plan

An interactive site that teaches chess by **showing**, not just telling. You play
against a bot; after your moves the coach explains *why* a move was good or bad and
**animates the better line** so you can see the causal chain (e.g. *why* taking the
center actually helps).

## Core architecture principle

> **Stockfish decides. The LLM narrates.**

LLMs (DeepSeek, Claude, etc.) are unreliable at *evaluating* chess positions — they
hallucinate evals and illegal moves. So the objective judgement is always done by a
real engine, and the LLM only turns the engine's structured output into human
teaching language.

```
Browser (Next.js / React / TypeScript)
├─ react-chessboard   → board UI, animations, arrows, square highlights
├─ chess.js           → move legality, game state, PGN, history
├─ Stockfish 18 WASM  → evaluation, best move, principal variation   [FREE, on-device]
│    (single-threaded lite build, runs in a Web Worker)
└─ Web Worker         → keeps the engine off the UI thread
        │  (only for notable moves, later phases)
        ▼
Next.js API route  →  DeepSeek  →  natural-language teaching text
        │
        ▼
Cache (position hash → explanation)   [cuts token cost hard]
```

## Tech stack (pinned, latest stable as of 2026-06)

| Concern        | Choice                        | Version  |
|----------------|-------------------------------|----------|
| Framework      | Next.js (App Router)          | 16.2.9   |
| UI             | React / React DOM             | 19.2.4   |
| Language       | TypeScript                    | 6.0.3    |
| Board UI       | react-chessboard              | 5.10.0   |
| Rules/state    | chess.js                      | 1.4.0    |
| Engine         | stockfish (WASM)              | 18.0.8   |
| Styling        | Tailwind CSS                  | v4       |

`chessground` was evaluated but is deprecated on npm; `react-chessboard` is React-native,
actively maintained, and supports the custom arrows + square styles the "show me" feature needs.

## Engine build choice

Stockfish 18 ships several WASM builds. Phase 1 uses **`stockfish-18-lite-single`**
(single-threaded, smaller NNUE net):
- No `SharedArrayBuffer` → **no COOP/COEP cross-origin-isolation headers required**.
- Plenty strong for teaching at any human level.

Upgrade path: switch to the multi-threaded full build for deeper/faster analysis by
serving with `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` headers (via `next.config`).

Engine files are copied to `public/stockfish/` (the loader finds its `.wasm` by
replacing `.js`→`.wasm` on its own script URL).

## Adaptivity (all levels)

Two independent dials:
- **Opponent strength** — Stockfish `Skill Level` (0–20) + per-move time budget.
- **Explanation depth** — parameter passed to the LLM (beginner vs. intermediate register).
  Same engine data, different narration.

## Build phases

- [x] **Phase 0 — Scaffold.** Next.js + libs installed, engine files served.
- [x] **Phase 1 — Playable board.** Human vs. Stockfish, difficulty presets, eval bar,
      move list, color choice. **No LLM.**
- [x] **Phase 2 — Move classification.** Dual engine (full-strength coach judges, skill-limited
      opponent plays). Before/after eval per move → best / good / inaccuracy / mistake / blunder
      (pure thresholds). Color-coded move list, coach panel showing loss + engine's best move.
- [x] **Phase 3 — "Show me" animations.** Review modal animates the engine's better line
      (the coach PV) vs. your played move + its continuation, with move arrows, last-move
      highlights, step controls (◀ ▶ ⏮ / auto-play / arrow keys), clickable move-list SANs,
      and eval contrast per line. *The differentiator.* Still no LLM.
- [x] **Phase 4 — DeepSeek narration.** Two server API routes (key stays server-side):
      `/api/explain` narrates why the better move wins + a reusable principle (in the review
      modal); `/api/coach` gives on-demand positional guidance that trains thinking WITHOUT
      revealing the move. Engine facts in → plain language out. Per-position caching (client +
      server). Beginner/intermediate depth derived from difficulty.
- [ ] **Phase 5 — Adaptivity & polish.** Auto-tune bot strength + explanation depth from
      recent accuracy, game history, lessons/puzzle mode.

## Cost control

- Stockfish on-device → $0 for the expensive part (evaluation).
- Call the LLM only on notable moves, not every move.
- Cache explanations by position hash (openings repeat constantly across users).
- Batch end-of-game summaries into one call.

## Project layout

```
app/            Next.js routes
  page.tsx      home — renders <ChessGame />
components/
  ChessGame.tsx main game: board + engine loop + controls
  EvalBar.tsx   vertical evaluation bar
hooks/
  useEngine.ts  engine lifecycle as a React hook
lib/
  engine.ts     StockfishEngine — UCI wrapper over the Web Worker
public/stockfish/  engine .js + .wasm (served statically)
```

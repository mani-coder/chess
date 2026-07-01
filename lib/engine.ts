// StockfishEngine — a thin UCI wrapper around the Stockfish 18 WASM build running
// in a Web Worker.
//
// Design principle for the whole app: *Stockfish decides, the LLM narrates.* This
// class is the single source of objective truth about a position. Everything else
// (move classification, "show me" animations, and later the LLM explanations) only
// consumes the structured results it returns here.

/** One evaluation result for a position. */
export interface AnalysisResult {
  /** Best move in UCI long algebraic form, e.g. "e2e4" or "e7e8q". null if none. */
  bestMove: string | null;
  /** Engine's expected reply (ponder move), if reported. */
  ponder: string | null;
  /** Centipawn score from the side-to-move's perspective. null when a mate is seen. */
  scoreCp: number | null;
  /** Mate-in-N from the side-to-move's perspective (positive = side to move mates). */
  mate: number | null;
  /** Principal variation (the best line) as UCI moves. */
  pv: string[];
  /** Search depth reached. */
  depth: number;
}

export interface AnalyzeOptions {
  /** Fixed search depth (used when movetime is not given). */
  depth?: number;
  /** Search time budget in milliseconds. Takes precedence over depth. */
  movetime?: number;
}

const DEFAULT_SCRIPT = "/stockfish/stockfish-18-lite-single.js";

export class StockfishEngine {
  private worker: Worker;
  private ready: Promise<void>;
  /** Current one-shot line handler; parsing routes every worker line here. */
  private onLine: ((line: string) => void) | null = null;
  /** Serializes engine operations so searches never overlap. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(scriptUrl: string = DEFAULT_SCRIPT) {
    this.worker = new Worker(scriptUrl);
    this.worker.onmessage = (e: MessageEvent) => {
      const data: unknown =
        typeof e.data === "string" ? e.data : (e.data && (e.data as { data?: unknown }).data);
      if (typeof data !== "string") return;
      for (const line of data.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && this.onLine) this.onLine(trimmed);
      }
    };
    this.ready = this.handshake();
  }

  /** UCI handshake: uci → uciok, then isready → readyok. */
  private handshake(): Promise<void> {
    return new Promise((resolve) => {
      this.onLine = (line) => {
        if (line === "uciok") {
          this.send("isready");
        } else if (line === "readyok") {
          this.onLine = null;
          resolve();
        }
      };
      this.send("uci");
    });
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  /** Run an operation exclusively, after any queued operation completes. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // Keep the chain alive even if this op rejects.
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private waitReady(): Promise<void> {
    return new Promise((resolve) => {
      this.onLine = (line) => {
        if (line === "readyok") {
          this.onLine = null;
          resolve();
        }
      };
      this.send("isready");
    });
  }

  /** Start a fresh game (clears the engine's internal state / hash). */
  newGame(): Promise<void> {
    return this.run(async () => {
      await this.ready;
      this.send("ucinewgame");
      await this.waitReady();
    });
  }

  /** Set playing strength, 0 (weakest) to 20 (full strength). */
  setSkillLevel(level: number): Promise<void> {
    return this.run(async () => {
      await this.ready;
      const lvl = Math.max(0, Math.min(20, Math.round(level)));
      this.send(`setoption name Skill Level value ${lvl}`);
    });
  }

  /**
   * Analyze a position (given as a FEN) and resolve with the engine's assessment.
   * Scores are from the side-to-move's perspective — normalize to White outside.
   */
  analyze(fen: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    return this.run(async () => {
      await this.ready;
      return new Promise<AnalysisResult>((resolve) => {
        const result: AnalysisResult = {
          bestMove: null,
          ponder: null,
          scoreCp: null,
          mate: null,
          pv: [],
          depth: 0,
        };
        this.onLine = (line) => {
          if (line.startsWith("info")) {
            this.parseInfo(line, result);
          } else if (line.startsWith("bestmove")) {
            const parts = line.split(/\s+/);
            result.bestMove = parts[1] && parts[1] !== "(none)" ? parts[1] : null;
            const pIdx = parts.indexOf("ponder");
            result.ponder = pIdx >= 0 ? parts[pIdx + 1] ?? null : null;
            this.onLine = null;
            resolve(result);
          }
        };
        this.send(`position fen ${fen}`);
        this.send(opts.movetime ? `go movetime ${opts.movetime}` : `go depth ${opts.depth ?? 12}`);
      });
    });
  }

  /** Parse a UCI `info` line into the running result (primary line only). */
  private parseInfo(line: string, result: AnalysisResult) {
    const t = line.split(/\s+/);
    const mpv = t.indexOf("multipv");
    if (mpv >= 0 && t[mpv + 1] !== "1") return; // only track the top line

    const d = t.indexOf("depth");
    if (d >= 0) result.depth = parseInt(t[d + 1], 10) || result.depth;

    const s = t.indexOf("score");
    if (s >= 0) {
      const type = t[s + 1];
      const val = parseInt(t[s + 2], 10);
      if (type === "cp") {
        result.scoreCp = val;
        result.mate = null;
      } else if (type === "mate") {
        result.mate = val;
        result.scoreCp = null;
      }
    }

    const pv = t.indexOf("pv");
    if (pv >= 0) result.pv = t.slice(pv + 1);
  }

  /** Tear down the worker. */
  dispose() {
    try {
      this.send("quit");
    } catch {
      /* worker may already be gone */
    }
    this.worker.terminate();
    this.onLine = null;
  }
}

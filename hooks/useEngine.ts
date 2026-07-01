"use client";

import { useEffect, useRef, useState } from "react";
import { StockfishEngine } from "@/lib/engine";

/**
 * Owns a single StockfishEngine instance for the component's lifetime.
 * Returns the engine (null until mounted) and a `ready` flag that flips true
 * once the UCI handshake + ucinewgame have completed.
 */
export function useEngine() {
  const engineRef = useRef<StockfishEngine | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const engine = new StockfishEngine();
    engineRef.current = engine;
    let cancelled = false;

    engine.newGame().then(() => {
      if (!cancelled) setReady(true);
    });

    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
      setReady(false);
    };
  }, []);

  return { engineRef, ready };
}

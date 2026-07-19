"use client";

import { useEffect, useRef } from "react";

export interface BarcodeScannerOptions {
  /** Called with the scanned code when a complete scan is detected. */
  onScan: (code: string) => void;
  /** Minimum code length to count as a scan (filters stray Enter presses). */
  minLength?: number;
  /**
   * Maximum milliseconds between consecutive keystrokes for them to be
   * attributed to a scanner. Human typing is slower; keyboard-wedge scanners
   * emit the whole code in a burst.
   */
  maxInterKeyMs?: number;
  enabled?: boolean;
}

/**
 * Keyboard-wedge barcode scanner interception.
 *
 * USB/Bluetooth scanners in keyboard-wedge mode type the code as rapid
 * keystrokes terminated by Enter. This hook watches `keydown` in the capture
 * phase, accumulates printable characters arriving faster than
 * `maxInterKeyMs`, and — when Enter terminates a buffer of at least
 * `minLength` — swallows the Enter (so forms don't submit) and invokes
 * `onScan` with the code. Any slow (human-speed) keystroke resets the
 * buffer, so normal typing — including inside inputs — is never intercepted.
 */
export function useBarcodeScanner({
  onScan,
  minLength = 5,
  maxInterKeyMs = 50,
  enabled = true,
}: BarcodeScannerOptions): void {
  // Keep the latest callback in a ref so the listener isn't re-bound (and the
  // in-flight buffer isn't lost) when the caller re-renders.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled) return;

    let buffer = "";
    let lastKeyAt = 0;

    function handleKeyDown(event: KeyboardEvent) {
      const now = performance.now();

      if (event.key === "Enter") {
        if (buffer.length >= minLength && now - lastKeyAt <= maxInterKeyMs) {
          const code = buffer;
          buffer = "";
          event.preventDefault();
          event.stopPropagation();
          onScanRef.current(code);
        } else {
          buffer = "";
        }
        return;
      }

      // Only printable single characters participate; ignore chords.
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (now - lastKeyAt > maxInterKeyMs) {
        // Too slow to be a scanner burst — start a fresh buffer.
        buffer = event.key;
      } else {
        buffer += event.key;
      }
      lastKeyAt = now;
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled, minLength, maxInterKeyMs]);
}

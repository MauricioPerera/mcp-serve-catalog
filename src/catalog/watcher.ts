/**
 * Polls the catalog for changes and fires callbacks. Implementation is
 * mtime-based on the manifest file (robust across both layouts — any
 * regeneration updates the manifest).
 *
 * Polling is intentional: webhooks are an integration concern, not a
 * protocol concern. Operators wanting push-triggered invalidation can
 * call `reader.invalidate()` manually or via a thin /admin endpoint.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogLayout } from "./reader.js";

export type ChangeListener = () => void;

export class CatalogWatcher {
  private readonly manifestPath: string;
  private readonly intervalMs: number;
  private readonly listeners: ChangeListener[] = [];
  private lastMtime = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(layout: CatalogLayout, intervalMs: number) {
    this.manifestPath = path.join(layout.indexDir, "manifest.json");
    this.intervalMs = intervalMs;
    this.captureBaseline();
  }

  /** Register a callback fired when any catalog change is detected. */
  onChange(listener: ChangeListener): void {
    this.listeners.push(listener);
  }

  /**
   * Start polling. No-op if interval is 0 (explicitly disabled) or the
   * watcher is already running.
   */
  start(): void {
    if (this.intervalMs <= 0 || this.timer !== null) return;
    this.timer = setInterval(() => this.checkOnce(), this.intervalMs);
    // unref so the timer doesn't keep the process alive alone
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force a check immediately. Used by tests + /admin/reload paths. */
  checkOnce(): void {
    let current: number;
    try {
      current = fs.statSync(this.manifestPath).mtimeMs;
    } catch {
      return; // manifest disappeared; nothing to do (a future generation will set it)
    }
    if (current !== this.lastMtime) {
      this.lastMtime = current;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          /* swallow listener errors; polling must continue */
        }
      }
    }
  }

  private captureBaseline(): void {
    try {
      this.lastMtime = fs.statSync(this.manifestPath).mtimeMs;
    } catch {
      this.lastMtime = 0;
    }
  }
}

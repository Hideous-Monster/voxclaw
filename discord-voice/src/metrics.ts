/**
 * Metrics — Structured observability for the voice pipeline.
 *
 * Commit 9: counters, gauges, histograms (p50/p95/p99) + optional HTTP health endpoint.
 */

import * as http from "http";
import { Logger } from "./types.js";

// ── Metrics store ───────────────────────────────────────────────────

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  private startTime = Date.now();
  private healthServer: http.Server | null = null;

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Record a timing sample. Keeps last 1000 samples. */
  timing(name: string, ms: number): void {
    let arr = this.histograms.get(name);
    if (!arr) {
      arr = [];
      this.histograms.set(name, arr);
    }
    arr.push(ms);
    if (arr.length > 1000) arr.shift();
  }

  /** Returns all metrics as flat JSON. */
  snapshot(): Record<string, number> {
    const result: Record<string, number> = {};

    for (const [k, v] of this.counters) result[k] = v;
    for (const [k, v] of this.gauges) result[k] = v;

    for (const [k, arr] of this.histograms) {
      if (arr.length === 0) continue;
      const sorted = [...arr].sort((a, b) => a - b);
      const p = (pct: number) =>
        sorted[Math.min(Math.floor((pct / 100) * sorted.length), sorted.length - 1)];
      result[`${k}_count`] = arr.length;
      result[`${k}_p50`] = p(50);
      result[`${k}_p95`] = p(95);
      result[`${k}_p99`] = p(99);
    }

    return result;
  }

  /** Start an HTTP health endpoint on the given port. No-op if already running. */
  startHealthServer(port: number, log: Logger): void {
    if (this.healthServer) return;

    this.healthServer = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
        const snap = this.snapshot();
        const body = JSON.stringify({
          status: "ok",
          uptime: uptimeSec,
          currentSession: {
            duration: this.gauges.get("voice.session.duration_sec") ?? 0,
            metrics: snap,
          },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.healthServer.listen(port, () => {
      log.info(`[discord-voice] Health server listening on :${port}`);
    });

    this.healthServer.on("error", (err: Error) => {
      log.error(`[discord-voice] Health server error: ${err.message}`);
    });
  }

  stopHealthServer(): void {
    if (this.healthServer) {
      this.healthServer.close();
      this.healthServer = null;
    }
  }
}

/** Global singleton. */
export const metrics = new Metrics();

/**
 * TTS Cache — LRU buffer cache for synthesised audio.
 *
 * Commit 6: LRU eviction, stats, random-greeting helpers.
 * Commit 7: preWarm from phrase files with concurrency=5 semaphore.
 */

import { createHash } from "crypto";
import OpenAI from "openai";
import { synthesise } from "./tts.js";
import { DiscordVoiceConfig, Logger } from "./types.js";
import { metrics } from "./metrics.js";

// ── Types ───────────────────────────────────────────────────────────

type PhraseLabel = "greetings" | "check-ins";

interface CacheEntry {
  buffer: Buffer;
  lastUsed: number;
  size: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ── TtsCache ────────────────────────────────────────────────────────

export class TtsCache {
  private store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private totalBytes = 0;

  /** Keys that belong to each phrase label, for getRandomGreeting() */
  private labelKeys = new Map<PhraseLabel, Set<string>>([
    ["greetings", new Set()],
    ["check-ins", new Set()],
  ]);

  /** Last key returned per label — to avoid repeating */
  private lastKey = new Map<PhraseLabel, string>();

  /** Hash of (provider+model+voice+instructions) — used for cache invalidation on re-warm. */
  private configHash = "";

  // ── Key generation ────────────────────────────────────────────────

  buildKey(config: DiscordVoiceConfig, text: string): string {
    const raw = JSON.stringify({
      provider: config.tts.provider,
      model: config.tts.model,
      voice: config.tts.voice,
      instructions: config.tts.instructions ?? "",
      text,
    });
    return sha256(raw).slice(0, 12);
  }

  private buildConfigHash(config: DiscordVoiceConfig): string {
    return sha256(
      JSON.stringify({
        provider: config.tts.provider,
        model: config.tts.model,
        voice: config.tts.voice,
        instructions: config.tts.instructions ?? "",
      })
    ).slice(0, 16);
  }

  // ── Cache operations ──────────────────────────────────────────────

  get(key: string): Buffer | null {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      metrics.increment("voice.tts.cache_misses");
      return null;
    }
    entry.lastUsed = Date.now();
    this.hits++;
    metrics.increment("voice.tts.cache_hits");
    return entry.buffer;
  }

  set(key: string, buffer: Buffer, maxSizeMb = 50): void {
    const size = buffer.length;

    // If key already exists, remove its old size first
    const existing = this.store.get(key);
    if (existing) {
      this.totalBytes -= existing.size;
    }

    this.store.set(key, { buffer, lastUsed: Date.now(), size });
    this.totalBytes += size;

    // Evict LRU until under budget
    const maxBytes = maxSizeMb * 1024 * 1024;
    while (this.totalBytes > maxBytes && this.store.size > 0) {
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, v] of this.store) {
        if (v.lastUsed < oldestTime) {
          oldestTime = v.lastUsed;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      const evicted = this.store.get(oldestKey)!;
      this.totalBytes -= evicted.size;
      this.store.delete(oldestKey);
      // Remove from label sets too
      for (const set of this.labelKeys.values()) {
        set.delete(oldestKey);
      }
    }

    metrics.gauge("voice.tts.cache_size_bytes", this.totalBytes);
  }

  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
    for (const set of this.labelKeys.values()) set.clear();
    metrics.gauge("voice.tts.cache_size_bytes", 0);
  }

  stats(): { entries: number; sizeBytes: number; hits: number; misses: number } {
    return {
      entries: this.store.size,
      sizeBytes: this.totalBytes,
      hits: this.hits,
      misses: this.misses,
    };
  }

  // ── Phrase helpers ─────────────────────────────────────────────────

  /**
   * Associate a cache key with a phrase label ('greetings' | 'check-ins').
   * Called during preWarm so getRandomGreeting() knows what to pick from.
   */
  registerPhraseKey(key: string, label: PhraseLabel): void {
    this.labelKeys.get(label)?.add(key);
  }

  /**
   * Pick a random cached entry from the given phrase set.
   * Never returns the same key twice in a row.
   * Returns null if the set is empty or nothing is cached.
   */
  getRandomGreeting(label: PhraseLabel): Buffer | null {
    const keySet = this.labelKeys.get(label);
    if (!keySet || keySet.size === 0) return null;

    // Build list of keys with valid cache entries
    const available: string[] = [];
    for (const k of keySet) {
      if (this.store.has(k)) available.push(k);
    }
    if (available.length === 0) return null;

    const last = this.lastKey.get(label);

    // Exclude the last key if there are alternatives
    let candidates = available;
    if (last && available.length > 1) {
      candidates = available.filter((k) => k !== last);
    }

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    this.lastKey.set(label, chosen);

    const entry = this.store.get(chosen);
    if (!entry) return null;

    // Update lastUsed (counts as a hit)
    entry.lastUsed = Date.now();
    this.hits++;
    metrics.increment("voice.tts.cache_hits");
    return entry.buffer;
  }

  // ── Pre-warming ────────────────────────────────────────────────────

  /**
   * Synthesise all phrases and cache them, with concurrency=5.
   * If the voice config hash has changed since the last warm, clears first.
   */
  async preWarm(
    phrases: string[],
    label: PhraseLabel,
    config: DiscordVoiceConfig,
    client: OpenAI,
    log: Logger
  ): Promise<void> {
    const newHash = this.buildConfigHash(config);
    if (this.configHash && this.configHash !== newHash) {
      log.info("[discord-voice] TTS config changed — clearing cache before pre-warm");
      this.clear();
    }
    this.configHash = newHash;

    const maxSizeMb = config.cache?.tts?.maxSizeMb ?? 50;
    const concurrency = 5;
    let index = 0;
    let completed = 0;
    let errors = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = index++;
        if (i >= phrases.length) break;
        const phrase = phrases[i];
        const key = this.buildKey(config, phrase);

        // Skip if already cached
        if (this.store.has(key)) {
          this.registerPhraseKey(key, label);
          completed++;
          continue;
        }

        try {
          const buffer = await synthesise(phrase, config, client, log);
          this.set(key, buffer, maxSizeMb);
          this.registerPhraseKey(key, label);
          completed++;
        } catch (err: any) {
          errors++;
          log.warn(
            `[discord-voice] preWarm TTS failed for "${phrase.slice(0, 40)}": ${err?.message}`
          );
        }
      }
    };

    // Spawn concurrency=5 workers
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(concurrency, phrases.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    log.info(
      `[discord-voice] Pre-warm complete (${label}): ${completed}/${phrases.length} cached` +
        (errors > 0 ? `, ${errors} errors` : "")
    );
  }
}

/** Global singleton. */
export const ttsCache = new TtsCache();

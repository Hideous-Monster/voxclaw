/**
 * TTS Cache — LRU buffer cache for synthesised audio.
 *
 * Commit 6: LRU eviction, stats, random-greeting helpers.
 * Commit 7: preWarm from phrase files with concurrency=5 semaphore.
 * Commit 8: Baked phrases persisted to disk as OGG Opus files.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { DiscordVoiceConfig, Logger } from "./types.js";
import { metrics } from "./metrics.js";

// ── Types ───────────────────────────────────────────────────────────

type PhraseLabel = "greetings" | "check-ins";

interface CacheEntry {
  buffer: Buffer;
  lastUsed: number;
  size: number;
}

interface BakedManifest {
  configHash: string;
  entries: Record<string, string>; // filename → phrase text
}

// ── Helpers ─────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const OPENAI_TTS_MAX_CHARS = 4096;

/**
 * Synthesise text to an OGG Opus buffer (for disk baking).
 * Uses response_format "opus" which returns an OGG Opus byte stream
 * directly compatible with Discord/ffmpeg without transcoding.
 */
async function synthesiseBaked(
  text: string,
  config: DiscordVoiceConfig,
  client: OpenAI,
  log: Logger
): Promise<Buffer> {
  let input = text;
  if (input.length > OPENAI_TTS_MAX_CHARS) {
    log.warn(
      `[discord-voice] TTS baked input too long (${input.length} chars), truncating to ${OPENAI_TTS_MAX_CHARS}`
    );
    input = input.slice(0, OPENAI_TTS_MAX_CHARS - 3) + "...";
  }

  const response = await client.audio.speech.create({
    model: config.tts.model,
    voice: config.tts.voice as any,
    input,
    response_format: "opus",
    ...(config.tts.instructions && { instructions: config.tts.instructions }),
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
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

  /**
   * Tracks which cache keys hold OGG Opus buffers (baked from disk).
   * On-the-fly synthesised buffers are MP3 and NOT in this set.
   */
  private bakedOggKeys = new Set<string>();

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

  /** Returns true if the cached buffer for this key is an OGG Opus byte stream (baked). */
  isBakedOgg(key: string): boolean {
    return this.bakedOggKeys.has(key);
  }

  private getBakedDir(config: DiscordVoiceConfig): string {
    return (
      config.cache?.tts?.bakedPhrasesDir ??
      path.resolve(__dirname, "../phrases/baked")
    );
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
    this.bakedOggKeys.clear();
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
   * `isOggOpus` is true when the buffer is a baked OGG Opus byte stream.
   */
  getRandomGreeting(label: PhraseLabel): { buffer: Buffer; isOggOpus: boolean } | null {
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
    return { buffer: entry.buffer, isOggOpus: this.bakedOggKeys.has(chosen) };
  }

  // ── Pre-warming ────────────────────────────────────────────────────

  /**
   * Synthesise all phrases, persist them to disk as OGG Opus files, and
   * cache them in memory. On subsequent startups, loads from disk if the
   * voice config hash hasn't changed — no TTS API calls.
   *
   * Concurrency limit of 5 applies to synthesis. Disk writes are synchronous
   * per phrase (write then continue). Partial bakes synthesise only the
   * missing phrases.
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
    const bakedDir = this.getBakedDir(config);
    const manifestPath = path.join(bakedDir, "manifest.json");

    // Ensure baked dir exists
    fs.mkdirSync(bakedDir, { recursive: true });

    // ── Load manifest ────────────────────────────────────────────────
    let manifest: BakedManifest = { configHash: "", entries: {} };
    let manifestLoaded = false;
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      manifest = JSON.parse(raw) as BakedManifest;
      manifestLoaded = true;
    } catch {
      // No manifest or corrupt — start fresh
    }

    const manifestValid = manifestLoaded && manifest.configHash === newHash;

    // If stale (loaded but hash mismatch), wipe the baked directory
    if (manifestLoaded && !manifestValid) {
      log.info("[discord-voice] Baked phrases config changed — clearing baked files");
      try {
        for (const f of fs.readdirSync(bakedDir)) {
          try {
            fs.unlinkSync(path.join(bakedDir, f));
          } catch (e: any) {
            log.warn(`[discord-voice] Could not delete baked file ${f}: ${e?.message}`);
          }
        }
      } catch (e: any) {
        log.warn(`[discord-voice] Could not read baked dir for cleanup: ${e?.message}`);
      }
      manifest = { configHash: newHash, entries: {} };
    } else if (!manifestLoaded) {
      manifest = { configHash: newHash, entries: {} };
    }

    // ── Partition phrases into cached vs needs-synthesis ─────────────
    const phraseFilename = (phrase: string): string => {
      const hash = sha256(phrase).slice(0, 12);
      return `${label}-${hash}.ogg`;
    };

    let diskLoaded = 0;
    const toSynthesize: Array<{ phrase: string; filename: string }> = [];

    for (const phrase of phrases) {
      const filename = phraseFilename(phrase);
      const filepath = path.join(bakedDir, filename);

      if (manifestValid && manifest.entries[filename] === phrase) {
        // Try loading from disk
        try {
          const buffer = fs.readFileSync(filepath);
          const key = this.buildKey(config, phrase);
          this.set(key, buffer, maxSizeMb);
          this.bakedOggKeys.add(key);
          this.registerPhraseKey(key, label);
          diskLoaded++;
        } catch (err: any) {
          log.warn(
            `[discord-voice] Baked file unreadable (${filename}): ${err?.message} — re-synthesising`
          );
          toSynthesize.push({ phrase, filename });
        }
      } else {
        toSynthesize.push({ phrase, filename });
      }
    }

    if (diskLoaded > 0) {
      log.info(`[discord-voice] Loaded ${diskLoaded} baked phrases from disk (${label})`);
    }

    // ── Synthesise missing phrases with concurrency=5 ────────────────
    let index = 0;
    let synthesised = 0;
    let errors = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = index++;
        if (i >= toSynthesize.length) break;
        const { phrase, filename } = toSynthesize[i];
        const key = this.buildKey(config, phrase);

        // Skip if already cached (e.g. from a parallel preWarm call)
        if (this.store.has(key)) {
          this.registerPhraseKey(key, label);
          this.bakedOggKeys.add(key);
          manifest.entries[filename] = phrase;
          synthesised++;
          continue;
        }

        try {
          const buffer = await synthesiseBaked(phrase, config, client, log);

          // Write to disk synchronously (write then continue)
          const filepath = path.join(bakedDir, filename);
          try {
            fs.writeFileSync(filepath, buffer);
            manifest.entries[filename] = phrase;
          } catch (writeErr: any) {
            log.warn(
              `[discord-voice] Failed to write baked file (${filename}): ${writeErr?.message}`
            );
            // Still cache in memory even if disk write failed
          }

          this.set(key, buffer, maxSizeMb);
          this.bakedOggKeys.add(key);
          this.registerPhraseKey(key, label);
          synthesised++;
        } catch (err: any) {
          errors++;
          log.warn(
            `[discord-voice] preWarm TTS failed for "${phrase.slice(0, 40)}": ${err?.message}`
          );
        }
      }
    };

    if (toSynthesize.length > 0) {
      const workers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(5, toSynthesize.length); w++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      // Persist updated manifest
      try {
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ configHash: newHash, entries: manifest.entries }, null, 2)
        );
      } catch (err: any) {
        log.warn(`[discord-voice] Failed to write baked manifest: ${err?.message}`);
      }
    }

    const total = diskLoaded + synthesised;
    log.info(
      `[discord-voice] Pre-warm complete (${label}): ${total}/${phrases.length} cached` +
        (synthesised > 0 ? `, ${synthesised} newly synthesised` : "") +
        (errors > 0 ? `, ${errors} errors` : "")
    );
  }

/** Global singleton. */
export const ttsCache = new TtsCache();

/**
 * Audio Pipeline — The Conductor (Phase 2: Streaming + Phase 3: Cache + Observability)
 *
 * The pipeline is sentence-level rather than utterance-level:
 *
 *   1. User speaks → PCM buffer collected
 *   2. Whisper transcribes the utterance
 *   3. Completions streams back sentence-by-sentence (SSE)
 *   4. Each sentence is synthesised to audio immediately
 *   5. Audio chunks are queued for sequential playback
 *
 * Phase 3 additions:
 *   - Commit 5: onBotSpeech callback fired when audio playback starts
 *   - Commit 6: TTS LRU cache — check before calling TTS API
 *   - Commit 7: Pre-warm phrase files on connect
 *   - Commit 9: Metrics instrumentation (STT, TTS, LLM, e2e latency)
 */

import {
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from "@discordjs/voice";
import OpenAI from "openai";
import * as path from "path";
import * as fs from "fs";
import { Readable } from "stream";
import { transcribe } from "./stt.js";
import { streamFromAgent } from "./completions.js";
import { synthesise } from "./tts.js";
import { DiscordVoiceConfig, Logger } from "./types.js";
import { ttsCache } from "./tts-cache.js";
import { metrics } from "./metrics.js";

export class AudioPipeline {
  private player: AudioPlayer;
  private openai: OpenAI;
  private processing = false;
  private utteranceQueue: Buffer[] = [];

  // Audio chunks ready for playback (from TTS). Played sequentially.
  // Each entry carries a StreamType so OGG Opus baked buffers are decoded
  // correctly (StreamType.OggOpus) vs on-the-fly MP3 (StreamType.Arbitrary).
  private audioQueue: Array<{ buffer: Buffer; streamType: StreamType }> = [];
  private playingAudio = false;

  // Abort controller for the current streaming completion
  private currentAbort: AbortController | null = null;

  // Commit 5: callback fired when the first audio chunk of a response starts playing
  private onBotSpeech?: () => void;

  // Commit 9: e2e latency tracking — timestamp when user utterance was dequeued
  private utteranceStartAt = 0;
  private e2eRecorded = false;

  // Commit 8: last transcript for retry on bot stall
  lastTranscript: string | null = null;

  constructor(
    private config: DiscordVoiceConfig,
    private log: Logger,
    options?: { onBotSpeech?: () => void }
  ) {
    this.onBotSpeech = options?.onBotSpeech;

    this.openai = new OpenAI({
      apiKey: config.stt.apiKey ?? config.tts.apiKey ?? process.env.OPENAI_API_KEY,
    });

    this.player = createAudioPlayer();

    this.player.on("error", (err) => {
      this.log.error("[discord-voice] Audio player error:", err.message);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playNextAudioChunk();
    });

    // Load baked phrase OGG files from disk (no TTS calls — run bake-phrases first)
    this.loadBakedPhrases();
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  /**
   * Queue a PCM buffer (one complete utterance) for processing.
   */
  enqueue(pcmBuffer: Buffer): void {
    this.utteranceQueue.push(pcmBuffer);
    if (!this.processing) {
      this.processNextUtterance();
    }
  }

  /**
   * Interrupt: user started speaking. Kill everything in progress.
   */
  interrupt(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }

    this.audioQueue.length = 0;
    this.utteranceQueue.length = 0;
    this.playingAudio = false;
    this.e2eRecorded = false;

    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.log.debug("[discord-voice] Interrupted — killing playback + stream");
      this.player.stop(true);
    }

    this.processing = false;
  }

  /** Hard stop */
  stop(): void {
    this.interrupt();
  }

  // ── Utterance processing ────────────────────────────────────────

  private async processNextUtterance(): Promise<void> {
    const pcmBuffer = this.utteranceQueue.shift();
    if (!pcmBuffer) {
      this.processing = false;
      return;
    }

    this.processing = true;
    this.utteranceStartAt = Date.now();
    this.e2eRecorded = false;

    try {
      // ── STT ───────────────────────────────────────────────────
      this.log.debug("[discord-voice] Transcribing...");
      const sttStart = Date.now();
      metrics.increment("voice.stt.requests");
      const transcript = await transcribe(pcmBuffer, this.config, this.openai, this.log);
      metrics.timing("voice.stt.latency_ms", Date.now() - sttStart);

      if (!transcript) {
        this.log.debug("[discord-voice] Empty transcript, skipping");
        this.processing = false;
        this.processNextUtterance();
        return;
      }

      // Noise filter
      const NOISE_PATTERNS = [
        /^(you|the|a|um|uh|hmm|oh|ah|bye|thank you|thanks)\.?$/i,
        /^\W+$/,
      ];
      const wordCount = transcript.split(/\s+/).length;
      const isNoise = wordCount <= 2 && NOISE_PATTERNS.some((p) => p.test(transcript));
      if (isNoise) {
        this.log.debug(`[discord-voice] Filtered noise: "${transcript}"`);
        this.processing = false;
        this.processNextUtterance();
        return;
      }

      this.log.info(`[discord-voice] 🎤 "${transcript}"`);
      this.lastTranscript = transcript;

      // ── Streaming completions + chunked TTS ───────────────────
      this.currentAbort = new AbortController();

      const llmStart = Date.now();
      try {
        const fullText = await streamFromAgent(
          transcript,
          this.config,
          this.log,
          (sentence) => {
            this.synthesiseAndQueue(sentence);
          },
          this.currentAbort.signal
        );

        metrics.timing("voice.llm.latency_ms", Date.now() - llmStart);

        const preview = fullText.length > 120 ? fullText.slice(0, 120) + "…" : fullText;
        this.log.info(`[discord-voice] 🗣️ "${preview}"`);
      } catch (err: any) {
        if (err?.name === "AbortError") {
          this.log.debug("[discord-voice] Completion stream aborted (interrupted)");
        } else {
          metrics.increment("voice.llm.errors");
          throw err;
        }
      }

      this.currentAbort = null;

      await this.waitForPlaybackComplete();

      this.processing = false;
      this.processNextUtterance();
    } catch (err: any) {
      this.log.error("[discord-voice] Pipeline error:", err?.message ?? err);
      this.processing = false;
      this.currentAbort = null;
      setTimeout(() => this.processNextUtterance(), 1000);
    }
  }

  // ── TTS + audio queue ───────────────────────────────────────────

  /**
   * Synthesise a sentence to audio and add it to the playback queue.
   * Checks TTS cache first; falls back to TTS API on miss.
   */
  private synthesiseAndQueue(sentence: string): void {
    this.synthesiseAsync(sentence).catch((err) => {
      this.log.error(
        `[discord-voice] TTS error for "${sentence.slice(0, 50)}": ${err?.message}`
      );
    });
  }

  async synthesiseAsync(sentence: string): Promise<Buffer> {
    this.log.debug(`[discord-voice] TTS: "${sentence.slice(0, 60)}..."`);

    const key = ttsCache.buildKey(this.config, sentence);
    const cached = ttsCache.get(key);

    let mp3Buffer: Buffer;

    if (cached) {
      mp3Buffer = cached;
    } else {
      const ttsStart = Date.now();
      metrics.increment("voice.tts.requests");
      mp3Buffer = await synthesise(sentence, this.config, this.openai, this.log);
      metrics.timing("voice.tts.latency_ms", Date.now() - ttsStart);

      const maxSizeMb = this.config.cache?.tts?.maxSizeMb ?? 50;
      if (this.config.cache?.tts?.enabled !== false) {
        ttsCache.set(key, mp3Buffer, maxSizeMb);
      }
    }

    this.audioQueue.push({ buffer: mp3Buffer, streamType: StreamType.Arbitrary });

    if (!this.playingAudio) {
      this.playNextAudioChunk();
    }

    return mp3Buffer;
  }

  private playNextAudioChunk(): void {
    const entry = this.audioQueue.shift();
    if (!entry) {
      this.playingAudio = false;
      return;
    }

    this.playingAudio = true;

    // Commit 5: notify VoiceManager that bot is speaking
    this.onBotSpeech?.();

    // Commit 9: record e2e latency on first chunk of each utterance
    if (!this.e2eRecorded && this.utteranceStartAt > 0) {
      metrics.timing("voice.pipeline.e2e_latency_ms", Date.now() - this.utteranceStartAt);
      this.e2eRecorded = true;
    }

    // Baked OGG Opus buffers must use StreamType.OggOpus so @discordjs/voice
    // does not try to re-decode them as raw PCM/Arbitrary.
    const resource = createAudioResource(Readable.from(entry.buffer), {
      inputType: entry.streamType,
    });
    this.player.play(resource);
  }

  /**
   * Wait for all queued audio to finish playing.
   * Resolves immediately if nothing is playing/queued.
   */
  private waitForPlaybackComplete(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.playingAudio && this.audioQueue.length === 0) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  // ── Load baked phrases from disk (no TTS calls) ──────────────────

  private loadBakedPhrases(): void {
    const bakedDir = path.resolve(__dirname, "../phrases/baked");
    ttsCache.loadBakedOnly(bakedDir, "greetings", this.log);
    ttsCache.loadBakedOnly(bakedDir, "check-ins", this.log);
  }
}

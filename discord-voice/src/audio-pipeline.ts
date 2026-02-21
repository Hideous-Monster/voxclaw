/**
 * Audio Pipeline — The Conductor (Phase 2: Streaming + Phase 3: Cache + Observability)
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
  private utteranceQueue: Array<{ pcm: Buffer; uttId: string }> = [];

  private audioQueue: Array<{ buffer: Buffer; streamType: StreamType }> = [];
  private playingAudio = false;

  private currentAbort: AbortController | null = null;
  private onBotSpeech?: () => void;

  private utteranceStartAt = 0;
  private e2eRecorded = false;
  private currentUttId: string | null = null;

  lastTranscript: string | null = null;

  constructor(
    private config: DiscordVoiceConfig,
    private log: Logger,
    options?: { onBotSpeech?: () => void; instanceId?: string }
  ) {
    this.onBotSpeech = options?.onBotSpeech;
    this.instanceId = options?.instanceId ?? "unknown";

    this.openai = new OpenAI({
      apiKey: config.stt.apiKey ?? config.tts.apiKey ?? process.env.OPENAI_API_KEY,
    });

    this.player = createAudioPlayer();

    this.player.on("error", (err) => {
      this.log.error(`[dv:${this.instanceId}] Audio player error:`, err.message);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playNextAudioChunk();
      if (!this.playingAudio && this.audioQueue.length === 0 && this.currentUttId) {
        this.log.info(JSON.stringify({ event: "PLAYBACK_DONE", uttId: this.currentUttId }));
      }
    });

    // Load baked phrase OGG files from disk (no TTS calls — run bake-phrases first)
    this.loadBakedPhrases();
  }

  private instanceId: string;

  getPlayer(): AudioPlayer {
    return this.player;
  }

  enqueue(item: { pcm: Buffer; uttId: string }): void {
    this.utteranceQueue.push(item);
    this.log.info(
      JSON.stringify({
        event: "UTTERANCE_RECEIVED",
        uttId: item.uttId,
        queueDepth: this.utteranceQueue.length,
      })
    );
    if (!this.processing) {
      this.processNextUtterance();
    }
  }

  interrupt(): void {
    this.log.info(JSON.stringify({ event: "INTERRUPT", uttId: this.currentUttId }));

    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }

    this.audioQueue.length = 0;
    this.utteranceQueue.length = 0;
    this.playingAudio = false;
    this.e2eRecorded = false;

    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.log.debug(`[dv:${this.instanceId}] Interrupted — killing playback + stream`);
      this.player.stop(true);
    }

    this.processing = false;
  }

  stop(): void {
    this.interrupt();
  }

  private async processNextUtterance(): Promise<void> {
    const item = this.utteranceQueue.shift();
    if (!item) {
      this.processing = false;
      this.currentUttId = null;
      return;
    }

    const { pcm: pcmBuffer, uttId } = item;
    this.currentUttId = uttId;

    this.processing = true;
    this.utteranceStartAt = Date.now();
    this.e2eRecorded = false;

    try {
      this.log.info(JSON.stringify({ event: "STT_START", uttId }));
      const sttStart = Date.now();
      metrics.increment("voice.stt.requests");
      const transcript = await transcribe(pcmBuffer, this.config, this.openai, this.log);
      const sttDurationMs = Date.now() - sttStart;
      metrics.timing("voice.stt.latency_ms", sttDurationMs);
      this.log.info(
        JSON.stringify({
          event: "STT_DONE",
          uttId,
          transcript: transcript ?? "",
          durationMs: sttDurationMs,
        })
      );

      if (!transcript) {
        this.log.info(JSON.stringify({ event: "UTTERANCE_FILTERED", uttId, reason: "empty" }));
        this.processing = false;
        this.processNextUtterance();
        return;
      }

      if (this.config.vad.noiseFilterEnabled !== false) {
        const NOISE_PATTERNS = [
          /^(um|uh|hmm|oh|ah|huh)\.?$/i,
          /^\W+$/,
        ];
        const wordCount = transcript.split(/\s+/).length;
        const isNoise = wordCount <= 2 && NOISE_PATTERNS.some((p) => p.test(transcript));
        if (isNoise) {
          this.log.info(
            JSON.stringify({
              event: "UTTERANCE_FILTERED",
              uttId,
              reason: "noise",
              transcript,
            })
          );
          this.processing = false;
          this.processNextUtterance();
          return;
        }
      }

      this.log.info(`[dv:${this.instanceId}] 🎤 "${transcript}"`);
      this.lastTranscript = transcript;

      this.currentAbort = new AbortController();

      const llmStart = Date.now();
      this.log.info(JSON.stringify({ event: "LLM_START", uttId }));
      try {
        const fullText = await streamFromAgent(
          transcript,
          this.config,
          uttId,
          this.instanceId,
          this.log,
          (sentence) => {
            this.synthesiseAndQueue(sentence);
          },
          this.currentAbort.signal
        );

        const llmDurationMs = Date.now() - llmStart;
        metrics.timing("voice.llm.latency_ms", llmDurationMs);
        this.log.info(
          JSON.stringify({
            event: "LLM_DONE",
            uttId,
            durationMs: llmDurationMs,
            charCount: fullText.length,
          })
        );

        const preview = fullText.length > 120 ? fullText.slice(0, 120) + "…" : fullText;
        this.log.info(`[dv:${this.instanceId}] 🗣️ "${preview}"`);
      } catch (err: any) {
        if (err?.name === "AbortError") {
          this.log.debug(`[dv:${this.instanceId}] Completion stream aborted (interrupted)`);
        } else {
          metrics.increment("voice.llm.errors");
          throw err;
        }
      }

      this.currentAbort = null;

      await this.waitForPlaybackComplete();
      this.log.info(
        JSON.stringify({ event: "UTTERANCE_COMPLETE", uttId, e2eMs: Date.now() - this.utteranceStartAt })
      );

      this.processing = false;
      this.processNextUtterance();
    } catch (err: any) {
      this.log.error(`[dv:${this.instanceId}] Pipeline error:`, err?.message ?? err);
      this.processing = false;
      this.currentAbort = null;
      setTimeout(() => this.processNextUtterance(), 1000);
    }
  }

  private synthesiseAndQueue(sentence: string): void {
    this.synthesiseAsync(sentence).catch((err) => {
      this.log.error(`[dv:${this.instanceId}] TTS error for "${sentence.slice(0, 50)}": ${err?.message}`);
    });
  }

  async synthesiseAsync(sentence: string): Promise<Buffer> {
    const key = ttsCache.buildKey(this.config, sentence);
    const cached = ttsCache.get(key);
    const sentencePreview = sentence.slice(0, 60);
    const uttId = this.currentUttId;

    this.log.info(
      JSON.stringify({ event: "TTS_START", uttId, sentence: sentencePreview, cached: Boolean(cached) })
    );

    const ttsStart = Date.now();
    let mp3Buffer: Buffer;

    if (cached) {
      mp3Buffer = cached;
    } else {
      metrics.increment("voice.tts.requests");
      mp3Buffer = await synthesise(sentence, this.config, this.openai, this.log);
      metrics.timing("voice.tts.latency_ms", Date.now() - ttsStart);

      const maxSizeMb = this.config.cache?.tts?.maxSizeMb ?? 50;
      if (this.config.cache?.tts?.enabled !== false) {
        ttsCache.set(key, mp3Buffer, maxSizeMb);
      }
    }

    this.log.info(
      JSON.stringify({
        event: "TTS_DONE",
        uttId,
        durationMs: Date.now() - ttsStart,
        cached: Boolean(cached),
      })
    );

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
    if (this.currentUttId) {
      this.log.info(JSON.stringify({ event: "PLAYBACK_START", uttId: this.currentUttId }));
    }

    this.onBotSpeech?.();

    if (!this.e2eRecorded && this.utteranceStartAt > 0) {
      metrics.timing("voice.pipeline.e2e_latency_ms", Date.now() - this.utteranceStartAt);
      this.e2eRecorded = true;
    }

    const resource = createAudioResource(Readable.from(entry.buffer), {
      inputType: entry.streamType,
    });
    this.player.play(resource);
  }

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

/**
 * Audio Pipeline — The Conductor (Phase 2: Streaming)
 *
 * The pipeline is now sentence-level rather than utterance-level:
 *
 *   1. User speaks → PCM buffer collected
 *   2. Whisper transcribes the utterance
 *   3. Completions streams back sentence-by-sentence (SSE)
 *   4. Each sentence is synthesised to audio immediately
 *   5. Audio chunks are queued for sequential playback
 *
 * The key insight: step 4 starts while step 3 is still running.
 * The first sentence of Carla's response starts playing within ~1-2s
 * of the LLM starting to generate, instead of waiting for the entire
 * response to complete.
 *
 * Interruption: when the user speaks during playback, everything stops —
 * current audio, pending TTS, the streaming completion — and the new
 * utterance takes priority.
 */

import {
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from "@discordjs/voice";
import OpenAI from "openai";
import { Readable } from "stream";
import { transcribe } from "./stt.js";
import { streamFromAgent, sendToAgent } from "./completions.js";
import { synthesise } from "./tts.js";
import { DiscordVoiceConfig, Logger } from "./types.js";

export class AudioPipeline {
  private player: AudioPlayer;
  private openai: OpenAI;
  private processing = false;
  private utteranceQueue: Buffer[] = [];

  // Audio chunks ready for playback (from TTS). Played sequentially.
  private audioQueue: Buffer[] = [];
  private playingAudio = false;

  // Abort controller for the current streaming completion — lets us
  // cancel mid-stream when the user interrupts.
  private currentAbort: AbortController | null = null;

  constructor(
    private config: DiscordVoiceConfig,
    private log: Logger
  ) {
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
    // Cancel the streaming completion if one is running
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }

    // Clear all queues
    this.audioQueue.length = 0;
    this.utteranceQueue.length = 0;
    this.playingAudio = false;

    // Stop playback
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

    try {
      // ── STT ───────────────────────────────────────────────────
      this.log.debug("[discord-voice] Transcribing...");
      const transcript = await transcribe(pcmBuffer, this.config, this.openai, this.log);

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
      const isNoise = wordCount <= 2 && NOISE_PATTERNS.some(p => p.test(transcript));
      if (isNoise) {
        this.log.debug(`[discord-voice] Filtered noise: "${transcript}"`);
        this.processing = false;
        this.processNextUtterance();
        return;
      }

      this.log.info(`[discord-voice] 🎤 "${transcript}"`);

      // ── Streaming completions + chunked TTS ───────────────────
      this.currentAbort = new AbortController();

      try {
        const fullText = await streamFromAgent(
          transcript,
          this.config,
          this.log,
          (sentence) => {
            // Each sentence fires TTS in the background and queues the audio
            this.synthesiseAndQueue(sentence);
          },
          this.currentAbort.signal
        );

        const preview = fullText.length > 120 ? fullText.slice(0, 120) + "…" : fullText;
        this.log.info(`[discord-voice] 🗣️ "${preview}"`);
      } catch (err: any) {
        if (err?.name === "AbortError") {
          this.log.debug("[discord-voice] Completion stream aborted (interrupted)");
        } else {
          throw err;
        }
      }

      this.currentAbort = null;

      // Wait for all audio to finish playing before processing next utterance
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
   * Runs in the background — doesn't block the streaming completion.
   */
  private synthesiseAndQueue(sentence: string): void {
    // Fire and forget — errors are logged but don't crash the pipeline
    this.synthesiseAsync(sentence).catch(err => {
      this.log.error(`[discord-voice] TTS error for "${sentence.slice(0, 50)}": ${err?.message}`);
    });
  }

  private async synthesiseAsync(sentence: string): Promise<void> {
    this.log.debug(`[discord-voice] TTS: "${sentence.slice(0, 60)}..."`);
    const mp3Buffer = await synthesise(sentence, this.config, this.openai, this.log);
    this.audioQueue.push(mp3Buffer);

    // If nothing is currently playing, start
    if (!this.playingAudio) {
      this.playNextAudioChunk();
    }
  }

  private playNextAudioChunk(): void {
    const mp3 = this.audioQueue.shift();
    if (!mp3) {
      this.playingAudio = false;
      return;
    }

    this.playingAudio = true;
    const resource = createAudioResource(Readable.from(mp3), {
      inputType: StreamType.Arbitrary,
    });
    this.player.play(resource);
    // When this chunk finishes, AudioPlayerStatus.Idle fires → playNextAudioChunk()
  }

  /**
   * Wait for all queued audio to finish playing.
   * Resolves immediately if nothing is playing/queued.
   */
  private waitForPlaybackComplete(): Promise<void> {
    return new Promise(resolve => {
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
}

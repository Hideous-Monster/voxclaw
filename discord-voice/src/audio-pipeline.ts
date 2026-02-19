/**
 * Audio Pipeline — The Conductor
 *
 * Wires STT → completions → TTS → playback. Sequential, one utterance
 * at a time. If Lemon speaks while Carla is responding, the new utterance
 * queues and plays after the current response finishes.
 *
 * Phase 2 adds interruption: Lemon speaks → current playback stops →
 * new utterance is processed immediately.
 *
 * The pipeline owns the OpenAI client (shared between STT and TTS)
 * and the Discord AudioPlayer. Everything else is stateless functions.
 */

import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from "@discordjs/voice";
import OpenAI from "openai";
import { Readable } from "stream";
import { transcribe } from "./stt.js";
import { sendToAgent } from "./completions.js";
import { synthesise } from "./tts.js";
import { DiscordVoiceConfig, Logger } from "./types.js";

export class AudioPipeline {
  private player: AudioPlayer;
  private openai: OpenAI;
  private processing = false;
  private queue: Buffer[] = [];

  constructor(
    private config: DiscordVoiceConfig,
    private log: Logger
  ) {
    // Single OpenAI client shared between STT and TTS — same API key,
    // no reason to create two connections.
    this.openai = new OpenAI({
      apiKey: config.stt.apiKey ?? config.tts.apiKey ?? process.env.OPENAI_API_KEY,
    });

    this.player = createAudioPlayer();

    this.player.on("error", (err) => {
      this.log.error("[discord-voice] Audio player error:", err.message);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.processNext();
    });
  }

  /** The AudioPlayer that should be subscribed to the voice connection */
  getPlayer(): AudioPlayer {
    return this.player;
  }

  /**
   * Queue a PCM buffer (one complete utterance) for processing.
   * If the pipeline is idle, processing starts immediately.
   */
  enqueue(pcmBuffer: Buffer): void {
    this.queue.push(pcmBuffer);
    if (!this.processing) {
      this.processNext();
    }
  }

  private async processNext(): Promise<void> {
    const pcmBuffer = this.queue.shift();
    if (!pcmBuffer) {
      this.processing = false;
      return;
    }

    this.processing = true;

    try {
      // ── Step 1: Speech → Text ─────────────────────────────────
      this.log.debug("[discord-voice] Transcribing...");
      const transcript = await transcribe(pcmBuffer, this.config, this.openai, this.log);

      if (!transcript) {
        this.log.debug("[discord-voice] Empty transcript, skipping");
        this.processing = false;
        this.processNext();
        return;
      }

      // Filter out noise: single words, very short utterances, common
      // Whisper hallucinations on silence/noise
      const NOISE_PATTERNS = [
        /^(you|the|a|um|uh|hmm|oh|ah|bye|thank you|thanks)\.?$/i,
        /^\W+$/, // just punctuation
      ];
      const wordCount = transcript.split(/\s+/).length;
      const isNoise = wordCount <= 2 && NOISE_PATTERNS.some(p => p.test(transcript));
      if (isNoise) {
        this.log.debug(`[discord-voice] Filtered noise: "${transcript}"`);
        this.processing = false;
        this.processNext();
        return;
      }

      this.log.info(`[discord-voice] 🎤 "${transcript}"`);

      // ── Step 2: Text → Carla ──────────────────────────────────
      this.log.debug("[discord-voice] Thinking...");
      const { text: response } = await sendToAgent(transcript, this.config);

      // Log a preview, not the full response (can be long)
      const preview = response.length > 120 ? response.slice(0, 120) + "…" : response;
      this.log.info(`[discord-voice] 🗣️ "${preview}"`);

      // ── Step 3: Carla → Voice ─────────────────────────────────
      this.log.debug("[discord-voice] Synthesising...");
      const mp3Buffer = await synthesise(response, this.config, this.openai, this.log);

      // ── Step 4: Play ──────────────────────────────────────────
      const resource = createAudioResource(Readable.from(mp3Buffer), {
        inputType: StreamType.Arbitrary,
      });
      this.player.play(resource);
      // Pipeline resumes when player emits Idle → processNext()

    } catch (err: any) {
      this.log.error("[discord-voice] Pipeline error:", err?.message ?? err);
      this.processing = false;
      // Brief pause before retrying the queue (don't tight-loop on errors)
      setTimeout(() => this.processNext(), 1000);
    }
  }

  /** Interrupt: stop current playback but keep the pipeline alive for the next utterance */
  interrupt(): void {
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.log.debug("[discord-voice] Interrupted — stopping playback");
      this.queue.length = 0;
      this.player.stop(true);
      this.processing = false;
    }
  }

  /** Hard stop: kill playback, drop the queue, reset state */
  stop(): void {
    this.queue.length = 0;
    this.processing = false;
    this.player.stop(true);
  }
}

/**
 * Audio Pipeline — The Conductor
 *
 * Wires together STT → completions → TTS → playback.
 * One utterance at a time, sequential. No interruption in Phase 1.
 *
 * Flow:
 *   1. Receive PCM buffer from voice-manager (one utterance)
 *   2. Transcribe via Whisper
 *   3. Send to OpenClaw for Carla's response
 *   4. Synthesise response audio
 *   5. Play back in the voice channel
 *   6. Profit
 */

import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from "@discordjs/voice";
import { Readable } from "stream";
import { transcribe } from "./stt.js";
import { sendToAgent } from "./completions.js";
import { synthesise } from "./tts.js";
import { DiscordVoiceConfig } from "./types.js";

export type Logger = {
  info: (msg: string, ...args: any[]) => void;
  warn: (msg: string, ...args: any[]) => void;
  error: (msg: string, ...args: any[]) => void;
  debug: (msg: string, ...args: any[]) => void;
};

export class AudioPipeline {
  private player: AudioPlayer;
  private processing = false;
  private queue: Buffer[] = [];

  constructor(
    private config: DiscordVoiceConfig,
    private log: Logger
  ) {
    this.player = createAudioPlayer();

    this.player.on("error", (err) => {
      this.log.error("[discord-voice] Audio player error:", err.message);
    });

    // When playback finishes, process the next item in the queue
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.processNext();
    });
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  /** Queue a PCM buffer for processing */
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
      // Step 1: Transcribe
      this.log.debug("[discord-voice] Transcribing audio...");
      const transcript = await transcribe(pcmBuffer, this.config);

      if (!transcript) {
        this.log.debug("[discord-voice] Empty transcript, skipping");
        this.processing = false;
        this.processNext();
        return;
      }

      this.log.info(`[discord-voice] Transcript: "${transcript}"`);

      // Step 2: Ask Carla
      this.log.debug("[discord-voice] Sending to OpenClaw...");
      const { text: response } = await sendToAgent(transcript, this.config);

      this.log.info(`[discord-voice] Response: "${response.slice(0, 100)}..."`);

      // Step 3: Synthesise speech
      this.log.debug("[discord-voice] Synthesising TTS...");
      const audioBuffer = await synthesise(response, this.config);

      // Step 4: Play it back
      const resource = this.createResource(audioBuffer);
      this.player.play(resource);
      // Pipeline continues when player emits Idle (see constructor)

    } catch (err: any) {
      this.log.error("[discord-voice] Pipeline error:", err?.message ?? err);
      this.processing = false;
      // Don't get stuck — keep processing the queue
      setTimeout(() => this.processNext(), 500);
    }
  }

  private createResource(mp3Buffer: Buffer): AudioResource {
    const stream = Readable.from(mp3Buffer);
    return createAudioResource(stream, {
      inputType: StreamType.Arbitrary, // Let @discordjs/voice probe the format
    });
  }

  /** Stop everything and clear the queue */
  stop(): void {
    this.queue = [];
    this.processing = false;
    this.player.stop(true);
  }
}

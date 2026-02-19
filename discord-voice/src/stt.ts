/**
 * Speech-to-Text via OpenAI Whisper
 *
 * Takes raw PCM audio (48kHz, stereo, 16-bit signed LE) from the Discord
 * voice receiver, wraps it in a WAV container, and sends it to Whisper.
 *
 * The WAV header is hand-built because we don't need a library for 44 bytes
 * of boilerplate. Discord's audio format is fixed, so all the values are
 * constants.
 *
 * Future: Deepgram Nova-2 for streaming STT (lower latency). Whisper
 * is batch-only, so we wait for the full utterance before transcribing.
 */

import OpenAI from "openai";
import { DiscordVoiceConfig, Logger } from "./types.js";

// Discord voice: 48kHz, stereo, 16-bit signed LE
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BYTE_RATE = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;

/**
 * Build a WAV header for raw PCM data. The format is fixed (Discord's output)
 * so we don't need to parameterise any of it.
 */
function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTE_RATE, 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Transcribe a PCM audio buffer via OpenAI Whisper.
 *
 * Returns the transcription text, or empty string if the audio is too
 * short to be real speech (noise, mic bumps, etc).
 */
export async function transcribe(
  pcmBuffer: Buffer,
  config: DiscordVoiceConfig,
  client: OpenAI,
  log: Logger
): Promise<string> {
  if (pcmBuffer.length === 0) return "";

  // Minimum bytes for config.vad.minSpeechMs of 48kHz stereo 16-bit PCM
  const minBytes = (config.vad.minSpeechMs / 1000) * BYTE_RATE;
  if (pcmBuffer.length < minBytes) {
    log.debug(`[discord-voice] Audio too short (${pcmBuffer.length} bytes < ${minBytes} min), skipping`);
    return "";
  }

  const wavBuffer = pcmToWav(pcmBuffer);
  const file = new File([wavBuffer], "audio.wav", { type: "audio/wav" });

  try {
    const response = await client.audio.transcriptions.create({
      file,
      model: config.stt.model,
      language: "en", // TODO Phase 2: make configurable
    });

    return response.text.trim();
  } catch (err: any) {
    log.error("[discord-voice] Whisper transcription failed:", err?.message ?? err);
    return "";
  }
}

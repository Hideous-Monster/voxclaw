/**
 * Speech-to-Text via OpenAI Whisper
 *
 * Takes a Buffer of raw PCM audio (48kHz, stereo, 16-bit signed LE)
 * from the Discord voice receiver, wraps it in a WAV header,
 * and ships it off to Whisper.
 *
 * Phase 2 could add streaming STT for lower latency — Deepgram Nova-2
 * is great for that. For now, Whisper batch is solid and cheap.
 */

import OpenAI from "openai";
import { Readable } from "stream";
import { DiscordVoiceConfig } from "./types.js";

let openaiClient: OpenAI | null = null;

function getClient(config: DiscordVoiceConfig): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.stt.apiKey ?? process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

/**
 * Wraps raw PCM data in a WAV container so Whisper knows what it's eating.
 * Discord gives us 48kHz stereo 16-bit signed little-endian PCM.
 */
function pcmToWav(pcmBuffer: Buffer): Buffer {
  const sampleRate = 48000;
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");

  // fmt chunk
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16); // chunk size
  wav.writeUInt16LE(1, 20); // PCM format
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);

  return wav;
}

/**
 * Transcribe a buffer of PCM audio to text via Whisper.
 * Returns empty string if the audio is too short or empty.
 */
export async function transcribe(
  pcmBuffer: Buffer,
  config: DiscordVoiceConfig
): Promise<string> {
  if (pcmBuffer.length === 0) return "";

  // Rough minimum: 200ms of 48kHz stereo 16-bit = ~38400 bytes
  const minBytes =
    (config.vad.minSpeechMs / 1000) * 48000 * 2 * 2;
  if (pcmBuffer.length < minBytes) return "";

  const client = getClient(config);
  const wavBuffer = pcmToWav(pcmBuffer);

  // OpenAI SDK expects a File-like object. We create a readable stream
  // with a .name property so it knows the format.
  const file = new File([wavBuffer], "audio.wav", { type: "audio/wav" });

  const response = await client.audio.transcriptions.create({
    file,
    model: config.stt.model,
    language: "en", // Phase 2: make configurable, Lemon speaks English anyway
  });

  return response.text.trim();
}

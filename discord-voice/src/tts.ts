/**
 * Text-to-Speech — Carla's Voice
 *
 * Phase 1: OpenAI TTS (gpt-4o-mini-tts) — fast, cheap, decent quality.
 * Phase 2: ElevenLabs — better voice, more Carla-like. Charlotte (British)
 *   or a custom voice. Worth the extra cost for daily driving sessions.
 *
 * Returns a Buffer of MP3 audio that can be streamed into a Discord
 * AudioResource via Readable.from().
 */

import OpenAI from "openai";
import { DiscordVoiceConfig } from "./types.js";

let openaiClient: OpenAI | null = null;

function getClient(config: DiscordVoiceConfig): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.tts.apiKey ?? process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

/**
 * Synthesise text to MP3 audio using OpenAI TTS.
 * Returns the raw MP3 buffer.
 */
export async function synthesise(
  text: string,
  config: DiscordVoiceConfig
): Promise<Buffer> {
  if (config.tts.provider === "elevenlabs") {
    // Phase 2: ElevenLabs integration
    // For now, fall through to OpenAI even if misconfigured
    // TODO: implement ElevenLabs TTS
    throw new Error(
      "ElevenLabs TTS not yet implemented — coming in Phase 2. Use provider: 'openai' for now."
    );
  }

  const client = getClient(config);

  const response = await client.audio.speech.create({
    model: config.tts.model as "gpt-4o-mini-tts" | "tts-1" | "tts-1-hd",
    voice: config.tts.voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
    input: text,
    response_format: "mp3",
  });

  // The SDK returns a Response-like object; we need the raw bytes
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

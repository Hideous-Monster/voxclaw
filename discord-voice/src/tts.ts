/**
 * Text-to-Speech — Carla's Voice
 *
 * Phase 1: OpenAI TTS (gpt-4o-mini-tts). Fast, cheap, decent quality.
 * Phase 2: ElevenLabs. Better voice, more personality — worth the premium
 *   for daily driving sessions. Charlotte with a leather jacket attitude.
 *
 * Returns an MP3 buffer ready to be wrapped in a Discord AudioResource.
 */

import OpenAI from "openai";
import { DiscordVoiceConfig, Logger } from "./types.js";

/** OpenAI TTS has a 4096 character limit per request */
const OPENAI_TTS_MAX_CHARS = 4096;

/**
 * Synthesise text to an MP3 buffer.
 * Throws if the provider is unsupported or the API call fails.
 */
export async function synthesise(
  text: string,
  config: DiscordVoiceConfig,
  client: OpenAI,
  log: Logger
): Promise<Buffer> {
  if (config.tts.provider === "elevenlabs") {
    throw new Error(
      "ElevenLabs TTS is Phase 2. Set tts.provider to 'openai' for now."
    );
  }

  // Truncate if needed — OpenAI TTS has a hard character limit.
  // For voice responses this shouldn't happen often (the voice agent
  // should be concise), but better truncated than crashed.
  let input = text;
  if (input.length > OPENAI_TTS_MAX_CHARS) {
    log.warn(
      `[discord-voice] TTS input too long (${input.length} chars), truncating to ${OPENAI_TTS_MAX_CHARS}`
    );
    input = input.slice(0, OPENAI_TTS_MAX_CHARS - 3) + "...";
  }

  const response = await client.audio.speech.create({
    model: config.tts.model,
    voice: config.tts.voice as any,
    input,
    response_format: "mp3",
    ...(config.tts.instructions && { instructions: config.tts.instructions }),
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

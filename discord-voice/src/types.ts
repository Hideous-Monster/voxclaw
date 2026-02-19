/**
 * Types & Defaults
 *
 * Central type definitions for the Discord voice plugin.
 * Config shape mirrors the JSON Schema in openclaw.plugin.json.
 */

// ── Logger interface ────────────────────────────────────────────────
// Used by every module. Lives here so nobody has to import from an
// unrelated file just for a log function.

export interface Logger {
  info: (msg: string, ...args: any[]) => void;
  warn: (msg: string, ...args: any[]) => void;
  error: (msg: string, ...args: any[]) => void;
  debug: (msg: string, ...args: any[]) => void;
}

// ── Plugin config ───────────────────────────────────────────────────

export interface DiscordVoiceConfig {
  /** Discord user ID to watch — when they join the voice channel, we follow */
  watchUserId: string;
  /** Discord voice channel ID to join */
  voiceChannelId: string;
  /** Auto-join when the watched user enters the channel */
  autoJoin: boolean;
  /** OpenClaw gateway base URL (e.g. http://localhost:18789) */
  gatewayUrl: string;
  /** OpenClaw gateway auth token */
  gatewayToken: string;
  /** Session key for persistent voice memory across calls */
  sessionKey: string;
  /** Agent ID to route completions to (e.g. "voice" for a faster model) */
  agentId: string;

  stt: {
    provider: "openai";
    apiKey?: string;
    model: string;
  };

  tts: {
    provider: "openai" | "elevenlabs";
    apiKey?: string;
    model: string;
    voice: string;
    voiceId?: string;  // ElevenLabs (Phase 2)
    modelId?: string;  // ElevenLabs (Phase 2)
  };

  vad: {
    /** Milliseconds of silence before we consider an utterance complete */
    silenceThresholdMs: number;
    /** Minimum speech duration to bother transcribing (filters coughs, mic bumps) */
    minSpeechMs: number;
    /** Maximum single utterance duration in seconds (safety cap) */
    maxUtteranceSec: number;
  };
}

// ── Defaults ────────────────────────────────────────────────────────

export const CONFIG_DEFAULTS: Partial<DiscordVoiceConfig> = {
  autoJoin: true,
  sessionKey: "voice:default",
  agentId: "voice",
  stt: {
    provider: "openai",
    model: "whisper-1",
  },
  tts: {
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: "alloy",
  },
  vad: {
    silenceThresholdMs: 800,
    minSpeechMs: 200,
    maxUtteranceSec: 120,
  },
};

// ── OpenClaw Plugin API (loose typing) ──────────────────────────────
// The real types live in openclaw/plugin-sdk. We type just what we use
// so the plugin compiles standalone without depending on the full SDK.

export interface OpenClawPluginApi {
  config: Record<string, any>;
  registerGatewayMethod: (name: string, handler: (...args: any[]) => any) => void;
  logger?: Logger;
}

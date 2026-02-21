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
  /** Model to use for completions (e.g. "anthropic/claude-sonnet-4-6"). Falls back to Sonnet 4.6. */
  model?: string;

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
    instructions?: string;  // Style instructions for gpt-4o-mini-tts
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
    /** When false, skip noise filtering entirely. Default: true */
    noiseFilterEnabled?: boolean;
  };

  resilience?: {
    maxReconnectAttempts?: number;
    reconnectBackoffMs?: number;
    reconnectBackoffMaxMs?: number;
    idleDisconnectMin?: number;
    graceAnnounceSec?: number;
    userLeftGraceSec?: number;
  };

  heartbeat?: {
    intervalMs?: number;
    silencePromptSec?: number;
    botStallThresholdSec?: number;
    initiative?: 'passive' | 'normal' | 'active';
  };

  cache?: {
    tts?: {
      enabled?: boolean;
      maxSizeMb?: number;
      preWarmOnConnect?: boolean;
      /** Override the directory where baked OGG phrase files are stored. */
      bakedPhrasesDir?: string;
    };
  };

  observability?: {
    metricsLogIntervalSec?: number;
    healthPort?: number;
  };
}

// ── Defaults ────────────────────────────────────────────────────────

export const CONFIG_DEFAULTS: Partial<DiscordVoiceConfig> & {
  resilience: Required<NonNullable<DiscordVoiceConfig['resilience']>>;
  heartbeat: Required<NonNullable<DiscordVoiceConfig['heartbeat']>>;
  cache: Required<NonNullable<DiscordVoiceConfig['cache']>> & {
    tts: Required<Pick<NonNullable<NonNullable<DiscordVoiceConfig['cache']>['tts']>, 'enabled' | 'maxSizeMb' | 'preWarmOnConnect'>>;
  };
  observability: Required<Pick<NonNullable<DiscordVoiceConfig['observability']>, 'metricsLogIntervalSec'>>;
} = {
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
    voice: "nova",
    instructions: "Speak with a sharp, confident, slightly sardonic tone. You're direct and don't waste words — like a rock musician who happens to be brilliant at engineering. Warm underneath the edge, but never saccharine.",
  },
  vad: {
    silenceThresholdMs: 500,
    minSpeechMs: 200,
    maxUtteranceSec: 120,
    noiseFilterEnabled: true,
  },
  resilience: {
    maxReconnectAttempts: 5,
    reconnectBackoffMs: 1000,
    reconnectBackoffMaxMs: 30000,
    idleDisconnectMin: 10,
    graceAnnounceSec: 30,
    userLeftGraceSec: 60,
  },
  heartbeat: {
    intervalMs: 15000,
    silencePromptSec: 60,
    botStallThresholdSec: 45,
    initiative: 'normal',
  },
  cache: {
    tts: {
      enabled: true,
      maxSizeMb: 50,
      preWarmOnConnect: true,
    },
  },
  observability: {
    metricsLogIntervalSec: 60,
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

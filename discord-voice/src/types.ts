// The shape of our plugin config, as validated by openclaw.plugin.json's configSchema
export interface DiscordVoiceConfig {
  watchUserId: string;
  voiceChannelId: string;
  autoJoin: boolean;
  gatewayUrl: string;
  gatewayToken: string;
  sessionKey: string;
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
    // Phase 2: ElevenLabs-specific
    voiceId?: string;
    modelId?: string;
  };
  vad: {
    silenceThresholdMs: number;
    minSpeechMs: number;
  };
}

// Sensible defaults — OpenClaw merges these with user config
export const CONFIG_DEFAULTS: Partial<DiscordVoiceConfig> = {
  autoJoin: true,
  sessionKey: "voice:lemon",
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
  },
};

// OpenClaw plugin API — typed loosely since we don't have the SDK types.
// In a proper upstream contribution this would import from "openclaw/plugin-sdk".
export interface OpenClawPluginApi {
  config: {
    plugins?: {
      entries?: {
        "discord-voice"?: {
          config?: Partial<DiscordVoiceConfig>;
        };
      };
    };
    channels?: {
      discord?: {
        token?: string;
      };
    };
  };
  registerGatewayMethod: (name: string, handler: (...args: any[]) => any) => void;
  logger?: {
    info: (msg: string, ...args: any[]) => void;
    warn: (msg: string, ...args: any[]) => void;
    error: (msg: string, ...args: any[]) => void;
    debug: (msg: string, ...args: any[]) => void;
  };
}

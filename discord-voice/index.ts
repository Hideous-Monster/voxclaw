/**
 * Discord Voice Plugin for OpenClaw
 *
 * Hands-free voice conversations with Carla in a Discord voice channel.
 * Join the channel, start talking. She listens, thinks, and talks back.
 *
 * Phase 1: Whisper STT → OpenClaw → OpenAI TTS (this)
 * Phase 2: ElevenLabs TTS, VAD interruption, audio cues
 * Phase 3: Wake words, conversation summaries, multi-user
 *
 * @see https://github.com/Hideous-Monster/voxclaw/issues/4
 */

import { DiscordVoiceConfig, OpenClawPluginApi, CONFIG_DEFAULTS, Logger } from "./src/types.js";
import { VoiceManager } from "./src/voice-manager.js";

function buildLogger(api: OpenClawPluginApi): Logger {
  return {
    info: (msg, ...args) => (api.logger?.info ?? console.info)(msg, ...args),
    warn: (msg, ...args) => (api.logger?.warn ?? console.warn)(msg, ...args),
    error: (msg, ...args) => (api.logger?.error ?? console.error)(msg, ...args),
    debug: (msg, ...args) => (api.logger?.debug ?? console.debug)(msg, ...args),
  };
}

function resolveConfig(raw: Partial<DiscordVoiceConfig> | undefined): DiscordVoiceConfig {
  return {
    ...CONFIG_DEFAULTS,
    ...raw,
    stt: { ...CONFIG_DEFAULTS.stt, ...raw?.stt },
    tts: { ...CONFIG_DEFAULTS.tts, ...raw?.tts },
    vad: { ...CONFIG_DEFAULTS.vad, ...raw?.vad },
  } as DiscordVoiceConfig;
}

export default function register(api: OpenClawPluginApi): void {
  const log = buildLogger(api);
  const rawConfig =
    api.config?.plugins?.entries?.["openclaw-discord-voice"]?.config ??
    api.config?.plugins?.entries?.["discord-voice"]?.config;
  const config = resolveConfig(rawConfig);

  // ── Resolve Discord bot token ─────────────────────────────────
  // Prefer explicit plugin config, fall back to OpenClaw's Discord
  // channel token, then env var. We document this precedence in the
  // README so nobody is surprised.
  const botToken =
    (rawConfig as any)?.botToken ??
    api.config?.channels?.discord?.token ??
    process.env.DISCORD_BOT_TOKEN;

  // ── Validate required config ──────────────────────────────────
  const missing: string[] = [];
  if (!botToken) missing.push("Discord bot token (channels.discord.token or DISCORD_BOT_TOKEN)");
  if (!config.watchUserId) missing.push("watchUserId");
  if (!config.voiceChannelId) missing.push("voiceChannelId");
  if (!config.gatewayUrl) missing.push("gatewayUrl");
  if (!config.gatewayToken) missing.push("gatewayToken");

  if (missing.length > 0) {
    log.error(
      `[discord-voice] Missing required config: ${missing.join(", ")}. ` +
        "Plugin will not start."
    );
    return;
  }

  // ── Start ─────────────────────────────────────────────────────
  const manager = new VoiceManager(config, botToken!, log);

  // Gateway RPC methods for manual control
  api.registerGatewayMethod("discord-voice.status", () => ({
    running: true,
    watchUserId: config.watchUserId,
    voiceChannelId: config.voiceChannelId,
    agentId: config.agentId,
    sessionKey: config.sessionKey,
  }));

  api.registerGatewayMethod("discord-voice.stop", async () => {
    await manager.stop();
    return { stopped: true };
  });

  log.info("[discord-voice] Starting voice plugin...");
  manager.start().catch((err) => {
    log.error("[discord-voice] Failed to start:", err?.message ?? err);
  });
}

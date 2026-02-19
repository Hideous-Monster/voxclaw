/**
 * Discord Voice Plugin for OpenClaw
 *
 * Carla, but in your Discord voice channel. Hands-free conversations
 * for the commute, the workshop, the beach walk — whatever you're doing
 * that's more important than sitting at a keyboard.
 *
 * Phase 1: Basic voice loop (STT → completions → TTS)
 * Phase 2: ElevenLabs TTS, VAD interruption, audio cues
 * Phase 3: Wake words, conversation summaries, multi-user
 *
 * @see /workspace/plans/discord-voice-plugin.md
 * @see https://github.com/Hideous-Monster/voxclaw/issues/4
 */

import { DiscordVoiceConfig, OpenClawPluginApi, CONFIG_DEFAULTS } from "./src/types.js";
import { VoiceManager } from "./src/voice-manager.js";

export default function register(api: OpenClawPluginApi): void {
  const rawConfig = api.config?.plugins?.entries?.["discord-voice"]?.config;

  // Merge defaults with user config
  const config: DiscordVoiceConfig = {
    ...CONFIG_DEFAULTS,
    ...rawConfig,
    stt: { ...CONFIG_DEFAULTS.stt, ...rawConfig?.stt },
    tts: { ...CONFIG_DEFAULTS.tts, ...rawConfig?.tts },
    vad: { ...CONFIG_DEFAULTS.vad, ...rawConfig?.vad },
  } as DiscordVoiceConfig;

  // Build a logger — use the plugin API's logger if available, fall back to console
  const log = {
    info: (msg: string, ...args: any[]) =>
      api.logger?.info(msg, ...args) ?? console.info(msg, ...args),
    warn: (msg: string, ...args: any[]) =>
      api.logger?.warn(msg, ...args) ?? console.warn(msg, ...args),
    error: (msg: string, ...args: any[]) =>
      api.logger?.error(msg, ...args) ?? console.error(msg, ...args),
    debug: (msg: string, ...args: any[]) =>
      api.logger?.debug(msg, ...args) ?? console.debug(msg, ...args),
  };

  // Resolve the Discord bot token:
  // 1. From our own plugin config (if a separate bot is configured)
  // 2. From the main Discord channel config (share the existing bot)
  // 3. From the DISCORD_BOT_TOKEN env var
  const botToken =
    (rawConfig as any)?.botToken ??
    api.config?.channels?.discord?.token ??
    process.env.DISCORD_BOT_TOKEN;

  if (!botToken) {
    log.error(
      "[discord-voice] No Discord bot token found. " +
        "Set channels.discord.token in openclaw.json or DISCORD_BOT_TOKEN env var."
    );
    return;
  }

  if (!config.watchUserId || !config.voiceChannelId) {
    log.warn(
      "[discord-voice] watchUserId and voiceChannelId are required. " +
        "Plugin will not start until they are configured."
    );
    return;
  }

  if (!config.gatewayUrl || !config.gatewayToken) {
    log.error(
      "[discord-voice] gatewayUrl and gatewayToken are required. " +
        "Point them at your OpenClaw gateway."
    );
    return;
  }

  const manager = new VoiceManager(config, botToken, log);

  // Register a gateway RPC method so we can poke the plugin manually if needed
  api.registerGatewayMethod("discord-voice.status", () => ({
    running: true,
    config: {
      watchUserId: config.watchUserId,
      voiceChannelId: config.voiceChannelId,
      agentId: config.agentId,
      sessionKey: config.sessionKey,
    },
  }));

  api.registerGatewayMethod("discord-voice.stop", async () => {
    await manager.stop();
    return { stopped: true };
  });

  // 🚀 Blast off
  log.info("[discord-voice] Starting Discord voice plugin...");
  manager.start().catch((err) => {
    log.error("[discord-voice] Failed to start voice manager:", err?.message ?? err);
  });
}

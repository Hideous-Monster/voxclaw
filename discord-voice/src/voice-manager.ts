/**
 * Voice Manager — The Bouncer
 *
 * Watches for a target user in a Discord voice channel. When they join,
 * we follow. When they leave, we leave. When they speak, we listen.
 *
 * IMPORTANT: This creates its own Discord.js Client. The stock OpenClaw
 * Discord channel also runs a Client with the same bot token. Discord
 * allows multiple gateway connections per bot (up to the shard limit),
 * so this works — but the voice manager only cares about voice states
 * and doesn't handle text messages (that's OpenClaw's job).
 *
 * If OpenClaw's plugin API ever exposes the existing Discord client,
 * we should switch to that. For now, a second connection is the only
 * way to get voice support without forking core.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  VoiceChannel,
  VoiceState,
} from "discord.js";
import {
  EndBehaviorType,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";
import { OpusEncoder } from "@discordjs/opus";
import { DiscordVoiceConfig, Logger } from "./types.js";
import { AudioPipeline } from "./audio-pipeline.js";

// Discord voice: 48kHz stereo 16-bit
const BYTES_PER_SECOND = 48_000 * 2 * 2;

export class VoiceManager {
  private client: Client;
  private connection: VoiceConnection | null = null;
  private pipeline: AudioPipeline | null = null;
  private guildId: string | null = null;
  private listening = false;

  constructor(
    private config: DiscordVoiceConfig,
    private botToken: string,
    private log: Logger
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });
  }

  async start(): Promise<void> {
    this.client.once(Events.ClientReady, (c) => {
      this.log.info(`[discord-voice] Connected as ${c.user.tag}`);
      this.checkIfUserAlreadyInChannel();
    });

    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      this.onVoiceStateUpdate(oldState, newState);
    });

    this.client.on(Events.Error, (err) => {
      this.log.error("[discord-voice] Discord client error:", err.message);
    });

    await this.client.login(this.botToken);
  }

  async stop(): Promise<void> {
    this.leaveChannel();
    this.client.destroy();
    this.log.info("[discord-voice] Voice manager stopped");
  }

  // ── Voice state tracking ────────────────────────────────────────

  /**
   * On startup, check if the watched user is already in the voice channel.
   * Handles the case where the bot restarts while someone is in a call.
   */
  private async checkIfUserAlreadyInChannel(): Promise<void> {
    if (!this.config.autoJoin) return;

    try {
      const channel = await this.client.channels.fetch(this.config.voiceChannelId);
      if (!channel?.isVoiceBased()) return;

      const voiceChannel = channel as VoiceChannel;
      const member = voiceChannel.members.get(this.config.watchUserId);
      if (member) {
        this.log.info("[discord-voice] User already in voice channel on startup — joining");
        await this.joinChannel(voiceChannel);
      }
    } catch (err: any) {
      this.log.warn("[discord-voice] Could not check initial voice state:", err?.message);
    }
  }

  private onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    // Only care about the watched user
    if ((newState.member?.id ?? oldState.member?.id) !== this.config.watchUserId) return;
    if (!this.config.autoJoin) return;

    const wasInOurChannel = oldState.channelId === this.config.voiceChannelId;
    const isInOurChannel = newState.channelId === this.config.voiceChannelId;

    if (!wasInOurChannel && isInOurChannel) {
      // Joined our channel
      this.log.info(`[discord-voice] ${newState.member?.displayName ?? "User"} joined — following`);
      this.joinChannel(newState.channel as VoiceChannel);
    } else if (wasInOurChannel && !isInOurChannel) {
      // Left our channel (or moved to a different one)
      this.log.info(`[discord-voice] ${oldState.member?.displayName ?? "User"} left — leaving`);
      this.leaveChannel();
    }
  }

  // ── Voice connection ────────────────────────────────────────────

  private async joinChannel(channel: VoiceChannel): Promise<void> {
    if (!channel.guild) return;

    // Already connected?
    if (getVoiceConnection(channel.guild.id)) {
      this.log.debug("[discord-voice] Already in voice channel");
      return;
    }

    this.guildId = channel.guild.id;
    this.pipeline = new AudioPipeline(this.config, this.log);

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // We need to hear
      selfMute: false,
    });

    this.connection.subscribe(this.pipeline.getPlayer());

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
      this.log.info("[discord-voice] Voice connection ready");
      this.startListening();
    } catch (err: any) {
      this.log.error("[discord-voice] Failed to join voice channel:", err?.message);
      this.leaveChannel();
    }
  }

  private leaveChannel(): void {
    this.listening = false;
    this.pipeline?.stop();
    this.pipeline = null;

    if (this.guildId) {
      getVoiceConnection(this.guildId)?.destroy();
    }

    this.connection = null;
    this.guildId = null;
  }

  // ── Audio capture ───────────────────────────────────────────────

  private startListening(): void {
    if (!this.connection || !this.pipeline || this.listening) return;
    this.listening = true;

    const receiver = this.connection.receiver;
    const decoder = new OpusEncoder(48_000, 2);
    const maxBytes = this.config.vad.maxUtteranceSec * BYTES_PER_SECOND;

    // The speaking event fires once per utterance start. We subscribe to
    // the audio stream with AfterSilence end behavior — Discord handles
    // the silence detection for us.
    receiver.speaking.on("start", (userId) => {
      if (userId !== this.config.watchUserId) return;

      this.log.debug("[discord-voice] Speech detected, capturing");

      const stream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.config.vad.silenceThresholdMs,
        },
      });

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      stream.on("data", (packet: Buffer) => {
        // Safety cap: don't buffer more than maxUtteranceSec of audio
        if (totalBytes >= maxBytes) return;

        try {
          const pcm = decoder.decode(packet);
          chunks.push(pcm);
          totalBytes += pcm.length;
        } catch {
          // Opus decode can fail on silence/comfort-noise packets — ignore
        }
      });

      stream.once("end", () => {
        if (chunks.length === 0 || !this.pipeline) return;

        const pcm = Buffer.concat(chunks);
        const durationSec = (pcm.length / BYTES_PER_SECOND).toFixed(1);
        this.log.debug(`[discord-voice] Utterance: ${durationSec}s (${pcm.length} bytes)`);
        this.pipeline.enqueue(pcm);
      });

      stream.once("error", (err) => {
        this.log.error("[discord-voice] Audio stream error:", err.message);
      });
    });
  }
}

/**
 * Voice Manager — The Bouncer
 *
 * Watches a Discord voice channel. When the target user (Lemon) shows up,
 * we join. When they leave, we leave. Simple as.
 *
 * Also handles the actual audio capture: subscribes to the user's audio
 * stream, collects Opus packets, decodes them to PCM, and hands off
 * complete utterances to the AudioPipeline.
 */

import {
  Client,
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
import { DiscordVoiceConfig } from "./types.js";
import { AudioPipeline, Logger } from "./audio-pipeline.js";

export class VoiceManager {
  private client: Client | null = null;
  private connection: VoiceConnection | null = null;
  private pipeline: AudioPipeline | null = null;
  private guildId: string | null = null;

  constructor(
    private config: DiscordVoiceConfig,
    private botToken: string,
    private log: Logger
  ) {}

  async start(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
      ],
    });

    this.client.on("ready", () => {
      this.log.info(`[discord-voice] Bot ready as ${this.client!.user?.tag}`);
    });

    this.client.on("voiceStateUpdate", (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState);
    });

    await this.client.login(this.botToken);
  }

  async stop(): Promise<void> {
    this.pipeline?.stop();
    this.connection?.destroy();
    this.client?.destroy();
  }

  private handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    if (newState.member?.id !== this.config.watchUserId) return;

    const joinedChannel = !oldState.channelId && newState.channelId;
    const leftChannel = oldState.channelId && !newState.channelId;
    const changedChannel = oldState.channelId !== newState.channelId && newState.channelId;

    if (
      this.config.autoJoin &&
      (joinedChannel || changedChannel) &&
      newState.channelId === this.config.voiceChannelId
    ) {
      this.log.info(
        `[discord-voice] ${newState.member?.displayName} joined voice — joining channel`
      );
      this.joinChannel(newState.channel as VoiceChannel);
    } else if (leftChannel || (changedChannel && oldState.channelId === this.config.voiceChannelId)) {
      this.log.info(
        `[discord-voice] ${newState.member?.displayName} left voice — leaving channel`
      );
      this.leaveChannel();
    }
  }

  private async joinChannel(channel: VoiceChannel): Promise<void> {
    if (!channel.guild) return;

    this.guildId = channel.guild.id;

    // If we're already connected, no need to re-join
    const existing = getVoiceConnection(channel.guild.id);
    if (existing) {
      this.log.debug("[discord-voice] Already in voice channel");
      return;
    }

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // We need to hear Lemon
      selfMute: false,
    });

    this.pipeline = new AudioPipeline(this.config, this.log);
    this.connection.subscribe(this.pipeline.getPlayer());

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
      this.log.info("[discord-voice] Connected to voice channel");
      this.startListening();
    } catch (err) {
      this.log.error("[discord-voice] Failed to connect to voice channel:", err);
      this.connection.destroy();
      this.connection = null;
    }
  }

  private leaveChannel(): void {
    this.pipeline?.stop();
    this.pipeline = null;

    if (this.guildId) {
      const conn = getVoiceConnection(this.guildId);
      conn?.destroy();
    }

    this.connection = null;
    this.guildId = null;
    this.log.info("[discord-voice] Left voice channel");
  }

  private startListening(): void {
    if (!this.connection || !this.pipeline) return;

    const receiver = this.connection.receiver;

    // Listen for Lemon speaking
    receiver.speaking.on("start", (userId) => {
      if (userId !== this.config.watchUserId) return;

      this.log.debug("[discord-voice] Speech started, subscribing to audio stream");

      const audioStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.config.vad.silenceThresholdMs,
        },
      });

      // Opus packets from Discord — 48kHz stereo
      const encoder = new OpusEncoder(48000, 2);
      const pcmChunks: Buffer[] = [];

      audioStream.on("data", (opusPacket: Buffer) => {
        try {
          // Decode Opus → raw PCM (16-bit signed LE, interleaved stereo)
          const pcm = encoder.decode(opusPacket);
          pcmChunks.push(pcm);
        } catch (err: any) {
          this.log.debug("[discord-voice] Opus decode error (likely silence packet):", err?.message);
        }
      });

      audioStream.on("end", () => {
        if (pcmChunks.length === 0 || !this.pipeline) return;

        const pcmBuffer = Buffer.concat(pcmChunks);
        this.log.debug(
          `[discord-voice] Utterance complete: ${pcmBuffer.length} bytes PCM (~${
            Math.round(pcmBuffer.length / 48000 / 2 / 2 * 100) / 100
          }s)`
        );

        // Hand off to the pipeline — it handles the rest
        this.pipeline.enqueue(pcmBuffer);
      });

      audioStream.on("error", (err) => {
        this.log.error("[discord-voice] Audio stream error:", err.message);
      });
    });
  }
}

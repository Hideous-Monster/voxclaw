/**
 * Voice Manager — The Bouncer
 *
 * Watches for a target user in a Discord voice channel. When they join,
 * we follow. When they leave, we leave. When they speak, we listen.
 *
 * Phase 3 additions:
 *   Commit 3: Auto-reconnect with exponential backoff on disconnect.
 *   Commit 4: Graceful Opus frame error handling (codec desync).
 *   Commit 5: Idle timeout with grace period announcement + user-left grace.
 *   Commit 8: VoiceHeartbeat wired up (idle timer migrated, stall/desync/silence).
 *   Commit 9: Metrics instrumentation.
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
  StreamType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  createAudioResource,
} from "@discordjs/voice";
import { OpusEncoder } from "@discordjs/opus";
import { Readable } from "stream";
import crypto from "crypto";
import { DiscordVoiceConfig, Logger, CONFIG_DEFAULTS } from "./types.js";
import { AudioPipeline } from "./audio-pipeline.js";
import { VoiceHeartbeat } from "./heartbeat.js";
import { ttsCache } from "./tts-cache.js";
import { metrics } from "./metrics.js";

// Discord voice: 48kHz stereo 16-bit
const BYTES_PER_SECOND = 48_000 * 2 * 2;

// Maximum consecutive Opus decode failures before warning/reset
const OPUS_WARN_THRESHOLD = 20;
const OPUS_RESET_THRESHOLD = 50;

export class VoiceManager {
  private instanceId = crypto.randomBytes(4).toString("hex");
  private uttCounter = 0;
  private client: Client;
  private connection: VoiceConnection | null = null;
  private pipeline: AudioPipeline | null = null;
  private guildId: string | null = null;
  private listening = false;
  private speakingHandler: ((userId: string) => void) | null = null;

  // Commit 3: prevent concurrent reconnect loops
  private reconnecting = false;
  // Guard against concurrent joinChannel calls (can fire from multiple subsystems)
  private joining = false;

  // Commit 5: speech timestamps (also used by heartbeat)
  private lastUserSpeechAt = 0;
  private lastBotSpeechAt = 0;

  // Commit 5: user-left grace timer
  private userLeftTimer: NodeJS.Timeout | null = null;

  // Commit 8: heartbeat
  private heartbeat: VoiceHeartbeat | null = null;
  private botStallRetried = false;

  // Commit 9: session start + metrics log timer
  private sessionStartAt = 0;
  private metricsLogTimer: NodeJS.Timeout | null = null;

  // Resolved config
  private get resCfg(): Required<NonNullable<DiscordVoiceConfig["resilience"]>> {
    return { ...CONFIG_DEFAULTS.resilience, ...this.config.resilience };
  }

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
      this.log.info(`[dv:${this.instanceId}] Connected as ${c.user.tag}`);
      this.checkIfUserAlreadyInChannel();
    });

    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      this.onVoiceStateUpdate(oldState, newState);
    });

    this.client.on(Events.Error, (err) => {
      this.log.error("[dv:${this.instanceId}] Discord client error:", err.message);
    });

    // Commit 9: start health server if configured
    if (this.config.observability?.healthPort) {
      metrics.startHealthServer(this.config.observability.healthPort, this.log);
    }

    await this.client.login(this.botToken);
  }

  async stop(): Promise<void> {
    this.leaveChannel();
    metrics.stopHealthServer();
    this.client.destroy();
    this.log.info("[dv:${this.instanceId}] Voice manager stopped");
  }

  // ── Voice state tracking ────────────────────────────────────────

  private async checkIfUserAlreadyInChannel(): Promise<void> {
    if (!this.config.autoJoin) return;

    try {
      const channel = await this.client.channels.fetch(this.config.voiceChannelId);
      if (!channel?.isVoiceBased()) return;

      const voiceChannel = channel as VoiceChannel;
      const member = voiceChannel.members.get(this.config.watchUserId);
      if (member) {
        this.log.info("[dv:${this.instanceId}] User already in voice channel on startup — joining");
        await this.joinChannel(voiceChannel);
      }
    } catch (err: any) {
      this.log.warn("[dv:${this.instanceId}] Could not check initial voice state:", err?.message);
    }
  }

  private onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    if ((newState.member?.id ?? oldState.member?.id) !== this.config.watchUserId) return;
    if (!this.config.autoJoin) return;

    const wasInOurChannel = oldState.channelId === this.config.voiceChannelId;
    const isInOurChannel = newState.channelId === this.config.voiceChannelId;

    if (!wasInOurChannel && isInOurChannel) {
      // User rejoined — cancel any user-left grace timer
      if (this.userLeftTimer) {
        clearTimeout(this.userLeftTimer);
        this.userLeftTimer = null;
        this.log.debug("[dv:${this.instanceId}] User rejoined — cancelled user-left timer");
      }
      this.log.info(`[dv:${this.instanceId}] ${newState.member?.displayName ?? "User"} joined — following`);
      this.joinChannel(newState.channel as VoiceChannel);
    } else if (wasInOurChannel && !isInOurChannel) {
      // User left — start grace timer (Commit 5)
      this.log.info(
        `[dv:${this.instanceId}] ${oldState.member?.displayName ?? "User"} left — starting ${this.resCfg.userLeftGraceSec}s grace timer`
      );
      if (this.userLeftTimer) clearTimeout(this.userLeftTimer);
      this.userLeftTimer = setTimeout(() => {
        this.userLeftTimer = null;
        this.log.info("[dv:${this.instanceId}] User-left grace expired — leaving channel");
        this.leaveChannel();
      }, this.resCfg.userLeftGraceSec * 1000);
    }
  }

  // ── Voice connection ────────────────────────────────────────────

  private async joinChannel(channel: VoiceChannel): Promise<void> {
    if (!channel.guild) return;

    if (this.joining) {
      this.log.debug("[dv:${this.instanceId}] Join already in progress — ignoring duplicate call");
      return;
    }

    if (getVoiceConnection(channel.guild.id)) {
      this.log.debug("[dv:${this.instanceId}] Already in voice channel");
      return;
    }

    this.joining = true;

    this.guildId = channel.guild.id;

    // Commit 5/8: bot speech callback → update timestamp + heartbeat
    this.pipeline = new AudioPipeline(this.config, this.log, {
      onBotSpeech: () => {
        this.lastBotSpeechAt = Date.now();
        this.heartbeat?.reportBotSpeech();
      },
    });

    this.log.info(`[dv:${this.instanceId}] Joining channel ${channel.id} in guild ${channel.guild.id}`);

    try {
      this.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      this.connection.on("stateChange", (oldState, newState) => {
        this.log.debug(
          `[dv:${this.instanceId}] Connection state: ${oldState.status} → ${newState.status}`
        );
      });

      this.connection.on("error", (err) => {
        this.log.error(`[dv:${this.instanceId}] Connection error: ${err?.message ?? err}`);
      });

      this.connection.subscribe(this.pipeline.getPlayer());

      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
      this.log.info("[dv:${this.instanceId}] Voice connection ready");

      // Commit 3: attach disconnect handler AFTER initial Ready — avoids
      // firing reconnect during the normal Connecting→Signalling→Ready sequence
      this.connection.on("stateChange", (_old, newState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
          this.handleDisconnect();
        }
      });

      // Commit 8: start heartbeat
      this.heartbeat = new VoiceHeartbeat(this.config, this.log, {
        onSilencePrompt: () => this.handleSilencePrompt(),
        onGraceAnnounce: () => this.handleGraceAnnounce(),
        onBotStall: () => this.handleBotStall(),
        onDesync: () => this.handleAudioDesync(),
        onIdleTimeout: () => this.leaveChannel(),
      });
      this.heartbeat.start();

      // Commit 9: session metrics + log timer
      this.sessionStartAt = Date.now();
      metrics.increment("voice.session.count");

      const metricsIntervalMs =
        (this.config.observability?.metricsLogIntervalSec ??
          CONFIG_DEFAULTS.observability.metricsLogIntervalSec) * 1000;
      this.metricsLogTimer = setInterval(() => {
        this.log.info(
          `[dv:${this.instanceId}] 📊 metrics: ${JSON.stringify(metrics.snapshot())}`
        );
      }, metricsIntervalMs);

      this.startListening();
      this.joining = false;
    } catch (err: any) {
      this.joining = false;
      this.log.error(`[dv:${this.instanceId}] Failed to join: ${err?.message ?? err} (${typeof err})`);
      if (err?.stack) this.log.error(`[dv:${this.instanceId}] Stack: ${err.stack}`);
      this.leaveChannel();
    }
  }

  private leaveChannel(): void {
    this.joining = false;

    // Remove speaking listener
    if (this.speakingHandler && this.connection) {
      this.connection.receiver.speaking.removeListener("start", this.speakingHandler);
      this.speakingHandler = null;
    }

    this.listening = false;
    this.pipeline?.stop();
    this.pipeline = null;

    // Commit 5: clear user-left timer
    if (this.userLeftTimer) {
      clearTimeout(this.userLeftTimer);
      this.userLeftTimer = null;
    }

    // Commit 8: stop heartbeat
    this.heartbeat?.stop();
    this.heartbeat = null;

    // Commit 9: stop metrics log timer
    if (this.metricsLogTimer) {
      clearInterval(this.metricsLogTimer);
      this.metricsLogTimer = null;
    }

    if (this.guildId) {
      getVoiceConnection(this.guildId)?.destroy();
    }

    this.connection = null;
    this.guildId = null;
    this.reconnecting = false;
  }

  // ── Commit 3: auto-reconnect with exponential backoff ──────────

  private handleDisconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;

    this.doReconnect().catch((err) => {
      this.log.error("[dv:${this.instanceId}] Reconnect loop error:", err?.message);
      this.leaveChannel();
    });
  }

  private async doReconnect(): Promise<void> {
    const { maxReconnectAttempts, reconnectBackoffMs, reconnectBackoffMaxMs } = this.resCfg;

    metrics.increment("voice.reconnect.count");

    for (let attempt = 1; attempt <= maxReconnectAttempts; attempt++) {
      const delay = Math.min(
        reconnectBackoffMs * Math.pow(2, attempt - 1),
        reconnectBackoffMaxMs
      );

      this.log.info(
        `[dv:${this.instanceId}] Reconnecting (attempt ${attempt}/${maxReconnectAttempts})...`
      );

      await sleep(delay);

      if (!this.connection) {
        this.reconnecting = false;
        return; // leaveChannel was called during the delay
      }

      try {
        await entersState(this.connection, VoiceConnectionStatus.Signalling, 15_000);
        await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);

        // Success — re-subscribe player and restart listening
        if (this.pipeline) {
          this.connection.subscribe(this.pipeline.getPlayer());
        }
        this.listening = false;
        this.startListening();
        this.reconnecting = false;

        metrics.increment("voice.reconnect.success");
        this.log.info("[dv:${this.instanceId}] Reconnected successfully");
        return;
      } catch {
        // This attempt failed — try again
      }
    }

    // Exhausted all attempts
    this.log.error(
      `[dv:${this.instanceId}] Reconnect failed after ${maxReconnectAttempts} attempts — leaving channel`
    );
    this.reconnecting = false;
    this.leaveChannel();
  }

  // ── Audio capture ───────────────────────────────────────────────

  private startListening(): void {
    if (!this.connection || !this.pipeline) return;

    const receiver = this.connection.receiver;

    // Remove previous listener to prevent stacking
    if (this.speakingHandler) {
      this.log.info(JSON.stringify({ event: "LISTENER_STACKED", instanceId: this.instanceId }));
      receiver.speaking.removeListener("start", this.speakingHandler);
      this.speakingHandler = null;
    }

    this.listening = true;

    const decoder = new OpusEncoder(48_000, 2);
    const maxBytes = this.config.vad.maxUtteranceSec * BYTES_PER_SECOND;

    let capturing = false;

    const handler = (userId: string) => {
      if (userId !== this.config.watchUserId) return;
      if (capturing) {
        const droppedUttId = `utt-${String(++this.uttCounter).padStart(3, "0")}`;
        this.log.info(
          JSON.stringify({ event: "UTTERANCE_DROPPED_CAPTURING", uttId: droppedUttId })
        );
        return;
      }

      const uttId = `utt-${String(++this.uttCounter).padStart(3, "0")}`;

      capturing = true;

      // Commit 5: update speech timestamp + heartbeat
      this.lastUserSpeechAt = Date.now();
      this.heartbeat?.reportUserSpeech();
      this.heartbeat?.setUserSpeaking(true);

      // Interrupt Carla if speaking
      if (this.pipeline) {
        this.pipeline.interrupt();
      }

      this.log.debug("[dv:${this.instanceId}] Speech detected, capturing");

      const stream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.config.vad.silenceThresholdMs,
        },
      });

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      // Commit 4: per-stream consecutive Opus decode failure counter
      let consecutiveDecodeFailures = 0;

      stream.on("data", (packet: Buffer) => {
        if (totalBytes >= maxBytes) return;

        // Commit 8: report audio frame received
        this.heartbeat?.reportAudioFrameReceived();

        try {
          const pcm = decoder.decode(packet);
          chunks.push(pcm);
          totalBytes += pcm.length;
          // Commit 4: reset counter on success
          consecutiveDecodeFailures = 0;
        } catch {
          // Commit 4: track consecutive failures
          consecutiveDecodeFailures++;
          metrics.increment("voice.opus.decode_errors");

          if (consecutiveDecodeFailures === OPUS_WARN_THRESHOLD + 1) {
            this.log.warn(
              `[dv:${this.instanceId}] Possible codec desync — ${consecutiveDecodeFailures} consecutive Opus decode failures`
            );
          }

          if (consecutiveDecodeFailures > OPUS_RESET_THRESHOLD) {
            this.log.warn(
              "[dv:${this.instanceId}] Receive stream reset due to codec desync"
            );
            stream.destroy();
            // Re-subscribe will happen on the next "start" event
          }
        }
      });

      stream.once("end", () => {
        capturing = false;
        this.heartbeat?.setUserSpeaking(false);

        if (chunks.length === 0 || !this.pipeline) return;

        const pcm = Buffer.concat(chunks);
        const durationSec = (pcm.length / BYTES_PER_SECOND).toFixed(1);
        this.log.debug(`[dv:${this.instanceId}] Utterance: ${durationSec}s (${pcm.length} bytes)`);
        this.pipeline.enqueue({ pcm, uttId });
      });

      stream.once("error", (err) => {
        capturing = false;
        this.heartbeat?.setUserSpeaking(false);
        this.log.error("[dv:${this.instanceId}] Audio stream error:", err.message);
      });
    };

    this.speakingHandler = handler;
    receiver.speaking.on("start", handler);
  }

  // ── Commit 8: heartbeat callback handlers ──────────────────────

  private handleSilencePrompt(): void {
    if (!this.pipeline) return;

    const cached = ttsCache.getRandomGreeting("check-ins");
    if (cached) {
      // Play the cached buffer directly through the player.
      // isOggOpus=true for baked disk phrases; false for in-memory MP3.
      this.playBuffer(
        cached.buffer,
        cached.isOggOpus ? StreamType.OggOpus : StreamType.Arbitrary
      );
    } else {
      // Cache miss — synthesise fallback
      this.pipeline.synthesiseAsync("Still there?").catch((err) => {
        this.log.warn("[dv:${this.instanceId}] Silence prompt TTS error:", err?.message);
      });
    }
  }

  private handleGraceAnnounce(): void {
    if (!this.pipeline) return;
    this.pipeline
      .synthesiseAsync("Hey, I'm gonna head out if nobody says anything.")
      .catch((err) => {
        this.log.warn("[dv:${this.instanceId}] Grace announce TTS error:", err?.message);
      });
  }

  private handleBotStall(): void {
    if (!this.pipeline) return;

    const lastTranscript = this.pipeline.lastTranscript;
    this.log.warn(
      `[dv:${this.instanceId}] Bot stall detected — last transcript: "${lastTranscript?.slice(0, 80) ?? "(none)"}"`
    );

    if (!lastTranscript) return;

    if (!this.botStallRetried) {
      // First stall — interrupt and play recovery, then try reconnect
      this.botStallRetried = true;
      this.log.info("[dv:${this.instanceId}] Retrying after stall — interrupting and reconnecting");
      this.pipeline.interrupt();
      this.pipeline
        .synthesiseAsync("Having some trouble, one sec.")
        .catch((err: any) => {
          this.log.warn("[dv:${this.instanceId}] Stall recovery TTS error:", err?.message);
        });
      if (this.connection) {
        this.handleDisconnect();
      }
    } else {
      // Subsequent stall — just play recovery message, reset flag
      this.botStallRetried = false;
      this.pipeline
        .synthesiseAsync("Having some trouble, one sec.")
        .catch((err: any) => {
          this.log.warn("[dv:${this.instanceId}] Stall recovery TTS error:", err?.message);
        });
    }
  }

  private handleAudioDesync(): void {
    if (!this.connection) return;
    this.log.warn("[dv:${this.instanceId}] Audio desync detected — resetting receiver subscription");

    // Destroy and re-subscribe by restarting the listener
    this.listening = false;
    this.startListening();
  }

  /**
   * Play a raw audio buffer directly through the audio player.
   * Used for cached check-in phrases (we have the buffer but not the text).
   * streamType defaults to Arbitrary (MP3); pass OggOpus for baked disk phrases.
   */
  private playBuffer(buffer: Buffer, streamType: StreamType = StreamType.Arbitrary): void {
    if (!this.pipeline) return;

    try {
      const resource = createAudioResource(Readable.from(buffer), {
        inputType: streamType,
      });
      this.pipeline.getPlayer().play(resource);
    } catch (err: any) {
      this.log.error("[dv:${this.instanceId}] playBuffer error:", err?.message);
    }
  }
}

// ── Utilities ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

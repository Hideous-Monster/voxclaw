/**
 * Voice Heartbeat — liveness monitor for an active voice session.
 *
 * Commit 8: silence prompts, bot-stall detection, audio desync, idle timeout.
 * Commit 9: reports session duration metric each tick.
 *
 * The heartbeat ticks every `heartbeat.intervalMs` and checks four conditions:
 *   1. Silence prompt — fire when user has been quiet too long and bot was the
 *      last to speak.
 *   2. Bot stall — fire when the user spoke but the bot hasn't responded within
 *      `botStallThresholdSec`.
 *   3. Audio desync — fire when the `userSpeaking` flag is true but no Opus
 *      frames have arrived in the last 5 s.
 *   4. Idle timeout — two-stage: fire `onGraceAnnounce` first, then
 *      `onIdleTimeout` after the grace window expires (migrated from the
 *      standalone setInterval in Commit 5).
 */

import { DiscordVoiceConfig, Logger, CONFIG_DEFAULTS } from "./types.js";
import { metrics } from "./metrics.js";

// ── Callback interface ───────────────────────────────────────────────

export interface HeartbeatCallbacks {
  /** Bot should play a "still there?" check-in phrase. */
  onSilencePrompt: () => void;
  /** Bot hasn't responded after user spoke — retry or warn. */
  onBotStall: () => void;
  /** Frames stopped arriving while userSpeaking flag is set — resync receiver. */
  onDesync: () => void;
  /**
   * Idle time has crossed the grace-announce threshold.
   * VoiceManager should play the grace announcement ("I'm gonna head out…").
   */
  onGraceAnnounce: () => void;
  /** Grace window expired with no activity — leave the channel. */
  onIdleTimeout: () => void;
}

// ── VoiceHeartbeat ───────────────────────────────────────────────────

export class VoiceHeartbeat {
  private timer: NodeJS.Timeout | null = null;

  // Timestamps (epoch ms)
  private lastUserSpeechAt: number;
  private lastBotSpeechAt: number;
  private lastFrameReceivedAt: number;
  private sessionStartAt: number;

  private userSpeaking = false;

  // Per-condition firing guards (reset when user speaks)
  private silencePromptFired = false;
  private botStallFired = false;
  private graceAnnounced = false;
  private idleTimeoutFired = false;

  // Resolved config w/ defaults
  private readonly hbCfg: Required<NonNullable<DiscordVoiceConfig["heartbeat"]>>;
  private readonly resCfg: Required<NonNullable<DiscordVoiceConfig["resilience"]>>;

  constructor(
    private config: DiscordVoiceConfig,
    private log: Logger,
    private callbacks: HeartbeatCallbacks
  ) {
    this.hbCfg = {
      ...CONFIG_DEFAULTS.heartbeat,
      ...config.heartbeat,
    };
    this.resCfg = {
      ...CONFIG_DEFAULTS.resilience,
      ...config.resilience,
    };

    const now = Date.now();
    this.lastUserSpeechAt = now;
    this.lastBotSpeechAt = now;
    this.lastFrameReceivedAt = now;
    this.sessionStartAt = now;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.hbCfg.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── External updates ─────────────────────────────────────────────────

  reportUserSpeech(): void {
    this.lastUserSpeechAt = Date.now();
    // Reset all guards when the user speaks
    this.silencePromptFired = false;
    this.botStallFired = false;
    this.graceAnnounced = false;
    this.idleTimeoutFired = false;
  }

  reportBotSpeech(): void {
    this.lastBotSpeechAt = Date.now();
    this.botStallFired = false;
  }

  reportAudioFrameReceived(): void {
    this.lastFrameReceivedAt = Date.now();
  }

  setUserSpeaking(speaking: boolean): void {
    this.userSpeaking = speaking;
  }

  // ── Tick ─────────────────────────────────────────────────────────────

  private tick(): void {
    const now = Date.now();
    const silenceDuration = now - this.lastUserSpeechAt;
    const timeSinceBotSpoke = now - this.lastBotSpeechAt;
    const sessionDuration = Math.floor((now - this.sessionStartAt) / 1000);

    // Commit 9: update session duration gauge each tick
    metrics.gauge("voice.session.duration_sec", sessionDuration);

    // ── 1. Silence prompt ─────────────────────────────────────────────
    // Threshold: active=30 s, normal=60 s, passive=never
    const silenceThresholdMs =
      this.hbCfg.initiative === "active"
        ? 30_000
        : this.hbCfg.initiative === "passive"
        ? Infinity
        : (this.hbCfg.silencePromptSec ?? 60) * 1000;

    if (
      this.hbCfg.initiative !== "passive" &&
      silenceDuration > silenceThresholdMs &&
      this.lastBotSpeechAt > this.lastUserSpeechAt &&
      !this.silencePromptFired
    ) {
      this.silencePromptFired = true;
      metrics.increment("voice.heartbeat.silence_prompts");
      this.callbacks.onSilencePrompt();
    }

    // ── 2. Bot stall ──────────────────────────────────────────────────
    const userSpokeAfterBot = this.lastUserSpeechAt > this.lastBotSpeechAt;
    const stallMs = this.hbCfg.botStallThresholdSec * 1000;

    if (userSpokeAfterBot && timeSinceBotSpoke > stallMs && !this.botStallFired) {
      this.botStallFired = true;
      metrics.increment("voice.heartbeat.stalls_detected");
      this.callbacks.onBotStall();
    }

    // ── 3. Audio desync ───────────────────────────────────────────────
    const DESYNC_WINDOW_MS = 5_000;
    if (this.userSpeaking && now - this.lastFrameReceivedAt > DESYNC_WINDOW_MS) {
      this.callbacks.onDesync();
    }

    // ── 4. Idle timeout (two-stage) ───────────────────────────────────
    const idleMs = this.resCfg.idleDisconnectMin * 60 * 1000;
    const graceMs = this.resCfg.graceAnnounceSec * 1000;
    const graceThresholdMs = idleMs - graceMs;

    // Idle duration = how long since either user or bot last spoke
    const idleSince = Math.min(
      now - this.lastUserSpeechAt,
      now - this.lastBotSpeechAt
    );

    if (idleSince > graceThresholdMs && !this.graceAnnounced) {
      this.graceAnnounced = true;
      this.callbacks.onGraceAnnounce();
    }

    if (idleSince > idleMs && this.graceAnnounced && !this.idleTimeoutFired) {
      this.idleTimeoutFired = true;
      metrics.increment("voice.idle_disconnects");
      this.callbacks.onIdleTimeout();
      this.stop();
    }
  }
}

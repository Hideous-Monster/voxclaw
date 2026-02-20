# Phase 3: Voice Resilience & Liveness

## Overview

Phase 2 gets us talking. Phase 3 makes sure we *keep* talking — handling the
real-world messiness of Discord voice: dropped connections, desync, silence
gaps, and the awkwardness of an AI that just... stops responding.

## 1. Connection Resilience

### Reconnection
- Detect voice connection drops (WebSocket close, UDP timeout, heartbeat ack miss)
- Automatic reconnect with exponential backoff (1s → 2s → 4s → max 30s)
- Resume audio stream mid-conversation — don't lose context
- If reconnect fails after N attempts (configurable, default 5), gracefully leave and notify the user via text

### Chunk Stream Reconstruction
- Handle partial/corrupted Opus frames gracefully (drop + continue, don't crash)
- If receiving audio but decoding fails repeatedly, flag potential codec desync
- Re-request codec state or reconnect the receive stream

### Timeout Handling
- Configurable idle timeout: if no speech from either side for X minutes, leave the channel
- "I'm still here" grace period before disconnecting (announce intent to leave)
- Separate timeout for "user left channel" vs "both silent"

## 2. Voice Heartbeat (Liveness Monitor)

A faster heartbeat that runs **only while in an active voice call**.

### Tick Rate
- Default: every 15 seconds (configurable via `voiceHeartbeat.intervalMs`)
- Only active when connected to a voice channel with the watched user present

### Checks Per Tick

#### Channel Presence
- Is the bot still in the voice channel?
- Is the watched user still in the voice channel?
- If user left: start a grace timer (default 60s), then disconnect
- If bot got kicked/moved: attempt rejoin once, then give up

#### Speech Activity
- Track `lastUserSpeechAt` and `lastBotSpeechAt` timestamps
- If user has been silent for > `silenceThreshold` (default 30s) but is still in channel:
  - Could be listening, thinking, or we can't hear them
  - After `promptThreshold` (default 60s): take initiative, say something contextual
    ("You've gone quiet — still there?" / continue the conversation naturally)
- If bot hasn't spoken for > `botSilenceThreshold` (default 45s) and user HAS been speaking:
  - Something is wrong — likely a processing pipeline stall
  - Log warning, attempt to flush/restart the TTS pipeline
  - If persists, announce "I think I'm having trouble — give me a sec" and reconnect

#### Audio Health
- Track if we're receiving audio frames from the user's SSRC
- If user is "speaking" (Discord speaking event) but we're getting no/garbage frames:
  - Likely a receive-side desync
  - Reconnect the receive stream
  - Log the incident for debugging
- If we're sending audio but user reports not hearing us:
  - (Can't detect this directly, but if user says "can you hear me?" after bot speech, flag it)

## 3. Caching

### TTS Cache
- Cache TTS responses keyed by `hash(voice + instructions + text)`
- LRU cache with configurable max size (default 50MB)
- Cache hit = instant playback, no API call
- Pre-warmed phrases (~30) stored as static audio files, loaded from disk on connect
- Keyed by config hash — regenerate when voice/instructions change
- Dynamic responses get cached as they're generated during conversation

### STT Cache
- Less useful (input is always unique), but cache transcription results briefly
  for retry/replay scenarios

### Conversation Context Cache
- Keep last N exchanges in memory for quick context without gateway roundtrip
- Persist to disk on disconnect for session continuity

## 4. Configuration

New config fields under `voiceHeartbeat`:

```json
{
  "voiceHeartbeat": {
    "intervalMs": 15000,
    "userLeftGraceSec": 60,
    "silencePromptSec": 60,
    "botStallThresholdSec": 45,
    "idleDisconnectMin": 10,
    "maxReconnectAttempts": 5
  },
  "cache": {
    "tts": {
      "enabled": true,
      "maxSizeMb": 50
    }
  }
}
```

## 5. Observability

- Log all heartbeat state transitions (connected → reconnecting → disconnected)
- Track metrics: reconnect count, cache hit rate, silence events, stall recoveries
- Surface connection health in `openclaw status` when voice plugin is active

## Design Decisions

### Discord heartbeat vs ours
Use Discord's built-in voice heartbeat for connection-level keep-alive (socket is alive).
Layer our own application-level heartbeat on top for conversation liveness
(speech tracking, initiative, desync detection, reconnect logic).

### Pre-warmed TTS phrases
Pre-generate ~30 phrases offline and ship them as cached audio files alongside the plugin.
No API calls needed on connect — just load from disk. Regenerate only when voice or
instructions change (detect via config hash).

Phrase categories:
- Intros/greetings ("hey", "what's up", "yo")
- Acknowledgments ("got it", "makes sense", "right")
- Thinking fillers ("hang on", "let me think", "one sec")
- Check-ins ("still there?", "you good?", "lost you for a sec")
- Fun/quirky (personality-specific, Carla-flavored)
- Transitional ("anyway", "so", "moving on")

Should feel different every time — pick randomly from each category, never repeat
the same one twice in a row. Lemon will help curate the phrase list.

### Initiative aggression
Three-tier config dial:
- `passive` — never initiates, only responds
- `normal` — prompts after 60s silence, occasional check-ins (default)
- `active` — shorter thresholds, more conversational, may comment unprompted

### Reconnect strategy
Drop the audio buffer on reconnect, keep conversation context.
Losing a sentence is fine — the priority is ensuring the connection isn't severed
and the conversation keeps flowing. User can repeat themselves.
Don't try to reconstruct half-received utterances.

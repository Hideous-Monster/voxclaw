# Discord Voice Plugin for OpenClaw

Talk to Carla hands-free in a Discord voice channel. Commute, workshop, beach walk — she's there.

## How it works

1. You join a configured Discord voice channel
2. The bot auto-joins and starts listening
3. You speak → Whisper transcribes → OpenClaw responds → TTS plays back
4. You leave → bot leaves

## Requirements

- OpenClaw 2026.2.14+
- Node.js 20+
- **ffmpeg** installed on the host (for audio transcoding)
  ```bash
  sudo apt-get install ffmpeg   # Ubuntu/Debian
  brew install ffmpeg           # macOS
  ```

## Installation

```bash
# From the voxclaw repo
cd discord-voice
npm install

# Install the plugin into OpenClaw
openclaw plugins install ./discord-voice
openclaw gateway restart
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "discord-voice": {
        "enabled": true,
        "config": {
          "watchUserId": "YOUR_DISCORD_USER_ID",
          "voiceChannelId": "YOUR_VOICE_CHANNEL_ID",
          "gatewayUrl": "http://localhost:18789",
          "gatewayToken": "your-openclaw-gateway-token",
          "sessionKey": "voice:lemon",
          "agentId": "voice",
          "stt": {
            "provider": "openai",
            "model": "whisper-1"
          },
          "tts": {
            "provider": "openai",
            "model": "gpt-4o-mini-tts",
            "voice": "alloy"
          },
          "vad": {
            "silenceThresholdMs": 800,
            "minSpeechMs": 200
          }
        }
      }
    }
  }
}
```

The plugin will reuse the Discord bot token from `channels.discord.token` automatically. If you're running a separate bot, set `botToken` in the plugin config.

### Finding your IDs

```bash
# Your Discord user ID: enable Developer Mode in Discord settings,
# then right-click your username → Copy User ID

# Voice channel ID: right-click the voice channel → Copy Channel ID
```

## Cost estimate

| Component | Cost |
|-----------|------|
| STT (Whisper) | $0.006/min → ~$10.80/mo at 60 min/day |
| TTS (OpenAI) | ~$15/mo for daily use |
| LLM (Claude via OpenClaw) | Existing subscription |
| Discord | Free |
| **Total** | **~$25/mo** |

## Roadmap

- **Phase 1** (this) — Basic voice loop, OpenAI TTS
- **Phase 2** — ElevenLabs TTS for better voice quality, VAD interruption, audio cues
- **Phase 3** — Wake words, conversation summaries, multi-user support

## Architecture

```
[Discord Voice] → [Opus packets] → [OpusEncoder.decode()] → [PCM buffer]
                                                                   ↓
                                                        [OpenAI Whisper STT]
                                                                   ↓
                                                           [transcript text]
                                                                   ↓
                                                  [OpenClaw /v1/chat/completions]
                                                  (x-openclaw-session-key: voice:lemon)
                                                  (x-openclaw-agent-id: voice)
                                                                   ↓
                                                           [response text]
                                                                   ↓
                                                        [OpenAI TTS → MP3]
                                                                   ↓
                                               [Discord AudioPlayer → Voice Channel]
```

## Troubleshooting

**Bot doesn't join when I enter the voice channel**
- Check that `watchUserId` matches your Discord user ID exactly
- Check that `voiceChannelId` matches the channel you're joining
- Ensure the bot has `Connect` and `Speak` permissions in the voice channel

**Transcription is empty/wrong**
- Check that ffmpeg is installed: `ffmpeg -version`
- Try increasing `vad.minSpeechMs` if short utterances are being dropped

**High latency**
- The pipeline is sequential: STT → LLM → TTS each add latency
- Use `agentId: "voice"` to route to a faster model (Sonnet vs Opus)
- ElevenLabs TTS with streaming (Phase 2) will help significantly

# Discord Voice Plugin for OpenClaw

Talk to your OpenClaw agent hands-free in a Discord voice channel.

## Requirements

- OpenClaw 2026.2.14+
- Node.js 20+
- `ffmpeg` installed on the host
- `OPENAI_API_KEY` set (used for Whisper STT and TTS)

## Installation

```bash
cd discord-voice && npm install
openclaw plugins install ./discord-voice
openclaw gateway restart
```

## Configuration

Add to `~/.openclaw/openclaw.json` under `plugins.entries`:

```json
"discord-voice": {
  "enabled": true,
  "config": {
    "watchUserId": "YOUR_DISCORD_USER_ID",
    "voiceChannelId": "YOUR_VOICE_CHANNEL_ID",
    "gatewayUrl": "http://localhost:18789",
    "gatewayToken": "your-openclaw-gateway-token",
    "sessionKey": "voice:lemon",
    "agentId": "voice"
  }
}
```

The plugin shares the bot token from `channels.discord.token` automatically.

To find your IDs, enable Developer Mode in Discord settings, then right-click → Copy ID.

## How it works

1. You join the configured voice channel
2. The bot auto-joins and starts listening
3. You speak → transcription → agent response → voice playback
4. You leave → the bot leaves

## Troubleshooting

**Bot doesn't join** — check `watchUserId` and `voiceChannelId` match exactly. Ensure the bot has `Connect` and `Speak` permissions.

**Empty transcriptions** — check `ffmpeg` is installed. Try increasing `vad.minSpeechMs`.

**Slow responses** — use `agentId: "voice"` pointing to a faster model (e.g. Sonnet).

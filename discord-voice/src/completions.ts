/**
 * OpenClaw Chat Completions Client
 *
 * Sends transcribed speech to the OpenClaw gateway and gets back
 * a text response. Uses the chat completions endpoint with session
 * and agent headers for persistent memory.
 *
 * This is basically the brains of the operation — Carla lives here.
 */

import { DiscordVoiceConfig } from "./types.js";

export interface CompletionsResponse {
  text: string;
}

export async function sendToAgent(
  transcript: string,
  config: DiscordVoiceConfig
): Promise<CompletionsResponse> {
  const url = `${config.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const body = JSON.stringify({
    model: "openclaw",
    stream: false,
    messages: [
      {
        role: "user",
        content: transcript,
      },
    ],
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.gatewayToken}`,
      // Route to the fast voice agent (Sonnet) with persistent session memory
      "x-openclaw-agent-id": config.agentId,
      "x-openclaw-session-key": config.sessionKey,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(
      `OpenClaw gateway returned ${response.status}: ${errorText}`
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("Empty response from OpenClaw gateway");
  }

  return { text };
}

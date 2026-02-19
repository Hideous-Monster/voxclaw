/**
 * OpenClaw Chat Completions Client
 *
 * Sends transcribed speech to the OpenClaw gateway and gets back a text
 * response. Uses the chat completions endpoint with session + agent headers
 * for persistent memory.
 *
 * This is where Carla lives. Everything else is plumbing.
 */

import { DiscordVoiceConfig } from "./types.js";

/** Timeout for a single completions request (ms). Generous — LLMs can think. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface CompletionsResponse {
  text: string;
}

/**
 * Send a transcript to the OpenClaw gateway and return the assistant's
 * text response. Throws on network errors, auth failures, or empty responses.
 */
export async function sendToAgent(
  transcript: string,
  config: DiscordVoiceConfig
): Promise<CompletionsResponse> {
  const url = `${config.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.gatewayToken}`,
        "x-openclaw-agent-id": config.agentId,
        "x-openclaw-session-key": config.sessionKey,
      },
      body: JSON.stringify({
        model: `openclaw:${config.agentId}`,
        stream: false,
        messages: [{ role: "user", content: transcript }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Gateway returned ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("Empty response from gateway (no choices or content)");
    }

    return { text };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * OpenClaw Chat Completions Client
 *
 * Sends transcribed speech to the OpenClaw gateway. Supports both
 * batch (Phase 1) and streaming (Phase 2) modes.
 *
 * Streaming mode enables the pipeline to start TTS on the first sentence
 * while the LLM is still generating the rest. This is the single biggest
 * latency win in the entire voice loop.
 */

import { DiscordVoiceConfig, Logger } from "./types.js";

/** Timeout for a single completions request (ms). Generous — LLMs can think. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface CompletionsResponse {
  text: string;
}

/**
 * Send a transcript and stream the response back sentence by sentence.
 *
 * The onSentence callback fires each time a complete sentence is detected
 * in the streaming response. The pipeline can start TTS on each sentence
 * immediately rather than waiting for the full response.
 *
 * Returns the full response text when the stream is complete.
 */
export async function streamFromAgent(
  transcript: string,
  config: DiscordVoiceConfig,
  log: Logger,
  onSentence: (sentence: string) => void,
  abortSignal?: AbortSignal
): Promise<string> {
  const url = `${config.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Chain our timeout abort with any external abort signal (for interruptions)
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => controller.abort());
  }

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
        model: config.model ?? "anthropic/claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: transcript }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Gateway returned ${response.status}: ${errorText}`);
    }

    const fullText = await parseSSEStream(response, log, onSentence, controller.signal);

    if (!fullText) {
      throw new Error("Empty response from gateway");
    }

    return fullText;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse an SSE stream from the OpenAI-compatible completions endpoint.
 * Accumulates text, detects sentence boundaries, and fires the callback.
 */
async function parseSSEStream(
  response: Response,
  log: Logger,
  onSentence: (sentence: string) => void,
  signal: AbortSignal
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";
  let sentenceBuffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();

        if (data === "[DONE]") break;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (!delta) continue;

          fullText += delta;
          sentenceBuffer += delta;

          // Check for sentence boundaries and emit
          const sentences = splitSentences(sentenceBuffer);
          if (sentences.completed.length > 0) {
            for (const sentence of sentences.completed) {
              const cleaned = cleanForTTS(sentence);
              if (cleaned.length > 0) {
                onSentence(cleaned);
              }
            }
            sentenceBuffer = sentences.remainder;
          }
        } catch {
          // Malformed JSON in SSE — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Flush any remaining text as the final sentence
  const remaining = cleanForTTS(sentenceBuffer);
  if (remaining.length > 0) {
    onSentence(remaining);
  }

  return fullText;
}

// ── Sentence splitting ──────────────────────────────────────────────

interface SplitResult {
  completed: string[];
  remainder: string;
}

/**
 * Split accumulated text into completed sentences and a remainder.
 *
 * A sentence boundary is a period, exclamation, question mark, or newline
 * followed by a space or end-of-string. We're not trying to be perfect —
 * just good enough to feed TTS in natural chunks.
 */
function splitSentences(text: string): SplitResult {
  const completed: string[] = [];

  // Match sentences ending with . ! ? or newline, followed by whitespace or EOL
  const pattern = /[^.!?\n]*[.!?]\s+|[^\n]*\n/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const sentence = match[0].trim();
    if (sentence.length > 0) {
      completed.push(sentence);
    }
    lastIndex = pattern.lastIndex;
  }

  return {
    completed,
    remainder: text.slice(lastIndex),
  };
}

// ── Text cleaning for TTS ───────────────────────────────────────────

/**
 * Strip markdown, code blocks, and other formatting that sounds awful
 * when read aloud. Keep it conversational.
 */
function cleanForTTS(text: string): string {
  let cleaned = text;

  // Remove code blocks (``` ... ```)
  cleaned = cleaned.replace(/```[\s\S]*?```/g, " (code omitted) ");

  // Remove inline code (`...`)
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

  // Remove markdown bold/italic
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");
  cleaned = cleaned.replace(/__([^_]+)__/g, "$1");
  cleaned = cleaned.replace(/_([^_]+)_/g, "$1");

  // Remove markdown headers
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, "");

  // Remove markdown links [text](url) → text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove bullet points
  cleaned = cleaned.replace(/^[\s]*[-*+]\s+/gm, "");

  // Remove emoji (rough — catches most common patterns)
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}]/gu, "");
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F5FF}]/gu, "");
  cleaned = cleaned.replace(/[\u{1F680}-\u{1F6FF}]/gu, "");
  cleaned = cleaned.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "");
  cleaned = cleaned.replace(/[\u{2600}-\u{26FF}]/gu, "");
  cleaned = cleaned.replace(/[\u{2700}-\u{27BF}]/gu, "");

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

// ── Legacy batch mode (kept for fallback) ───────────────────────────

/**
 * Non-streaming completions. Used as fallback if streaming fails.
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
        model: config.model ?? "anthropic/claude-sonnet-4-6",
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

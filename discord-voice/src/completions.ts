import { DiscordVoiceConfig, Logger } from "./types.js";

const REQUEST_TIMEOUT_MS = 60_000;

export interface CompletionsResponse {
  text: string;
}

export async function streamFromAgent(
  transcript: string,
  config: DiscordVoiceConfig,
  uttId: string,
  instanceId: string,
  log: Logger,
  onSentence: (sentence: string) => void,
  abortSignal?: AbortSignal
): Promise<string> {
  const url = `${config.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

    const fullText = await parseSSEStream(response, log, onSentence, controller.signal, uttId, instanceId);

    if (!fullText) {
      throw new Error("Empty response from gateway");
    }

    return fullText;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseSSEStream(
  response: Response,
  log: Logger,
  onSentence: (sentence: string) => void,
  signal: AbortSignal,
  uttId: string,
  instanceId: string
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";
  let sentenceBuffer = "";
  let firstTokenEmitted = false;
  const llmStart = Date.now();

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

          if (!firstTokenEmitted) {
            firstTokenEmitted = true;
            log.info(JSON.stringify({ event: "LLM_FIRST_TOKEN", uttId, latencyMs: Date.now() - llmStart }));
          }

          fullText += delta;
          sentenceBuffer += delta;

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
          log.debug(`[dv:${instanceId}] Malformed SSE chunk ignored (${uttId})`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const remaining = cleanForTTS(sentenceBuffer);
  if (remaining.length > 0) {
    onSentence(remaining);
  }

  return fullText;
}

interface SplitResult {
  completed: string[];
  remainder: string;
}

function splitSentences(text: string): SplitResult {
  const completed: string[] = [];

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

function cleanForTTS(text: string): string {
  let cleaned = text;

  cleaned = cleaned.replace(/```[\s\S]*?```/g, " (code omitted) ");
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");
  cleaned = cleaned.replace(/__([^_]+)__/g, "$1");
  cleaned = cleaned.replace(/_([^_]+)_/g, "$1");
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, "");
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  cleaned = cleaned.replace(/^[\s]*[-*+]\s+/gm, "");
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}]/gu, "");
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F5FF}]/gu, "");
  cleaned = cleaned.replace(/[\u{1F680}-\u{1F6FF}]/gu, "");
  cleaned = cleaned.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "");
  cleaned = cleaned.replace(/[\u{2600}-\u{26FF}]/gu, "");
  cleaned = cleaned.replace(/[\u{2700}-\u{27BF}]/gu, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

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

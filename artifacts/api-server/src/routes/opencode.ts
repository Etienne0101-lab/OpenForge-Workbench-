import { Router, type IRouter } from "express";
import { SendCodeChatBody } from "@workspace/api-zod";

const router: IRouter = Router();
const OPENROUTER_API = "https://openrouter.ai/api/v1";
const FREE_ROUTER_ID = "openrouter/free";

type UpstreamModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
};

function getOpenRouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

router.get("/opencode/models", async (req, res) => {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    res.status(503).json({ error: "OpenRouter is not configured on the server." });
    return;
  }

  try {
    const response = await fetch(`${OPENROUTER_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      req.log.warn({ status: response.status }, "OpenRouter model list request failed");
      res.status(503).json({ error: "OpenRouter's model list is temporarily unavailable." });
      return;
    }

    const payload = (await response.json()) as { data?: UpstreamModel[] };
    const freeModels = (Array.isArray(payload.data) ? payload.data : [])
      .filter(
        (model): model is UpstreamModel & { id: string; name: string } =>
          typeof model.id === "string" &&
          model.id.endsWith(":free") &&
          typeof model.name === "string",
      )
      .map((model) => ({
        id: model.id,
        name: model.name,
        contextLength:
          typeof model.context_length === "number" ? model.context_length : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.setHeader("Cache-Control", "private, max-age=300");
    res.json([
      {
        id: FREE_ROUTER_ID,
        name: "OpenRouter Free (automatic routing)",
        contextLength: null,
      },
      ...freeModels,
    ]);
  } catch (error) {
    req.log.warn({ err: error }, "OpenRouter model list request errored");
    res.status(503).json({ error: "OpenRouter's model list is temporarily unavailable." });
  }
});

router.post("/opencode/chat", async (req, res) => {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    res.status(503).json({ error: "OpenRouter is not configured on the server." });
    return;
  }

  const parsed = SendCodeChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid chat request.", details: parsed.error.flatten() });
    return;
  }

  const { model, messages, files = [] } = parsed.data;
  const totalFileBytes = files.reduce(
    (total, file) => total + file.path.length + file.content.length,
    0,
  );
  if (totalFileBytes > 80_000) {
    res.status(413).json({ error: "Selected file context is too large. Include fewer or smaller files." });
    return;
  }

  const fileContext = files.length
    ? `\n\nProject files supplied for context (read-only; propose changes for the user to review):\n${files
        .map((file) => `--- ${file.path} ---\n${file.content}`)
        .join("\n\n")}`
    : "";

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    const upstream = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "OpenCode Workbench",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "You are a careful coding assistant in a browser-based project workspace. The project files in context are read-only. Explain proposed changes and identify their target file. Do not claim you edited or executed anything. When suggesting a complete file replacement, use exactly this format: <<<FILE path/to/file>>> on its own line, then the complete file contents, then <<<END FILE>>> on its own line. Never suggest running destructive commands without explaining their impact.",
          },
          ...messages,
          ...(fileContext
            ? [{ role: "user" as const, content: fileContext }]
            : []),
        ],
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : 502;
      req.log.warn(
        { status: upstream.status, model },
        "OpenRouter chat request rejected",
      );
      if (res.destroyed) return;
      res.status(status).json({
        error:
          status === 429
            ? "This free model is rate-limited right now. Try another free model or wait a moment."
            : "OpenRouter could not complete the request. The model may be unavailable; try another free model.",
      });
      return;
    }

    if (!upstream.body) {
      res.status(502).json({ error: "OpenRouter returned an empty response." });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let completed = false;

    const processLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        completed = true;
        return;
      }
      try {
        const event = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        const content = event.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      } catch {
        // Ignore malformed upstream keepalive/partial events; the next chunk may complete them.
      }
    };

    while (!completed && !res.destroyed) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
        if (completed) break;
      }
      if (done) {
        if (buffered) processLine(buffered);
        break;
      }
    }

    if (!res.destroyed) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
    reader.releaseLock();
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    req.log.error({ err: error, model }, "OpenRouter streaming request failed");
    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: "The response stream ended unexpectedly. Please try again." })}\n\n`,
      );
      res.end();
    } else {
      res.status(502).json({ error: "OpenRouter could not complete the request. Please try again." });
    }
  }
});

export default router;

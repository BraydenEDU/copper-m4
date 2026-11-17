// @vitest-environment node
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each Google model id gets its own mock, so a test can make one fail.
let models: Record<string, MockLanguageModelV4> = {};
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => (id: string) => models[id],
}));

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function answers(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "1" });
          c.enqueue({ type: "text-delta", id: "1", delta: text });
          c.enqueue({ type: "text-end", id: "1" });
          c.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage,
          });
          c.close();
        },
      }),
    }),
  });
}

const httpError = (statusCode: number) =>
  new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://generativelanguage.googleapis.com",
    requestBodyValues: {},
    statusCode,
  });

function fails(error: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
    doStream: async () => {
      throw error;
    },
  });
}

/** A model whose stream starts, then sends an error instead of an answer. */
function streamsAnError() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "error", error: httpError(500) });
          c.close();
        },
      }),
    }),
  });
}

async function load() {
  vi.resetModules(); // forget which models were busy in earlier tests
  return import("@/lib/ai/call");
}

function captureLog() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return () =>
    info.mock.calls
      .filter(([tag]) => tag === "[ai_calls]")
      .map(([, row]) => JSON.parse(row as string));
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  models = {
    "gemini-3.8-flash": answers("from 3.8"),
    "gemini-3.5-flash-lite": answers("from lite"),
    "gemini-3-flash-preview": answers("from 3"),
    "gemini-2.5-flash": answers("from 2.5"),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("switching AI models at a roadblock", () => {
  it.each([
    ["overloaded (503)", httpError(503)],
    ["out of quota (429)", httpError(429)],
    ["retired model (404)", httpError(404)],
    ["server error (500)", httpError(500)],
    ["network failure", new TypeError("fetch failed")],
  ])("moves on to the next model when it's %s", async (_, error) => {
    const { callText } = await load();
    const rows = captureLog();
    models["gemini-3.8-flash"] = fails(error);
    const { text } = await callText(
      { module: 4, feature: "test" },
      { prompt: "hi" },
    );
    expect(text).toBe("from lite");
    expect(rows()[0]).toMatchObject({
      ok: true,
      model: "google/gemini-3.5-flash-lite",
    });
  });

  it("keeps going down the list until a model answers", async () => {
    const { callText } = await load();
    captureLog();
    models["gemini-3.8-flash"] = fails(httpError(503));
    models["gemini-3.5-flash-lite"] = fails(httpError(429));
    const { text } = await callText(
      { module: 4, feature: "test" },
      { prompt: "hi" },
    );
    expect(text).toBe("from 3");
  });

  it("switches when a streamed answer starts with an error", async () => {
    const { callStream } = await load();
    const rows = captureLog();
    models["gemini-3.8-flash"] = streamsAnError();
    const result = callStream({ module: 4, feature: "test" }, { prompt: "hi" });
    expect(await result.text).toBe("from lite");
    await vi.waitFor(() =>
      expect(rows()[0]?.model).toBe("google/gemini-3.5-flash-lite"),
    );
  });

  it("tries a model that just failed last, for a minute", async () => {
    const { callText, modelOrder } = await load();
    captureLog();
    models["gemini-3.8-flash"] = fails(httpError(503));
    await callText({ module: 4, feature: "test" }, { prompt: "hi" });
    expect(modelOrder("google/gemini-3.8-flash").at(-1)).toBe(
      "google/gemini-3.8-flash",
    );
    expect(modelOrder("google/gemini-3.8-flash", Date.now() + 61_000)[0]).toBe(
      "google/gemini-3.8-flash",
    );
  });

  it("gives up with the last error once every model has failed", async () => {
    const { callText } = await load();
    const rows = captureLog();
    for (const id of Object.keys(models)) models[id] = fails(httpError(503));
    await expect(
      callText({ module: 4, feature: "test" }, { prompt: "hi" }),
    ).rejects.toThrow("HTTP 503");
    expect(rows()[0].ok).toBe(false);
  });

  it("doesn't switch when the key is missing", async () => {
    const { callText, AiNotConfiguredError } = await load();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    await expect(
      callText({ module: 4, feature: "test" }, { prompt: "hi" }),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

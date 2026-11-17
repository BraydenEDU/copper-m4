import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  APICallError,
  embedMany,
  generateText,
  Output,
  streamText,
  wrapLanguageModel,
} from "ai";
import type { z } from "zod";
import {
  defaultModel,
  EMBEDDING_MODEL,
  FALLBACK_MODEL,
  type EmbeddingModelId,
  MODELS,
  type ModelId,
} from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";

// Every model call in the app goes through this file, so each one is logged
// with its tokens, cost and how long it took. The log goes to the terminal
// running the app, as a line starting "[ai_calls]".

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "Set up AI to use this feature: add GOOGLE_GENERATIVE_AI_API_KEY to .env.local.",
    );
    this.name = "AiNotConfiguredError";
  }
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
}

/** Which module and feature made the call, for the ai_calls log. */
export type CallInfo = { module: number; feature: string; model?: ModelId };

// Omit that keeps generateText's "prompt or messages" union intact.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type TextOptions = DistributiveOmit<
  Parameters<typeof generateText>[0],
  "model" | "output"
>;

export type AiCallRow = {
  module: number;
  feature: string;
  model: ModelId | EmbeddingModelId;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  ok: boolean;
  created_at: string;
};

function google() {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!googleKey) throw new AiNotConfiguredError();
  return createGoogleGenerativeAI({ apiKey: googleKey });
}

function googleModel(model: ModelId) {
  const entry = MODELS.find((m) => m.id === model);
  const id =
    entry && "googleId" in entry
      ? entry.googleId
      : model.slice("google/".length);
  return google()(id);
}

/** Google's "too busy" (503) and "too many requests / quota used up" (429). */
export function isOverloaded(error: unknown): boolean {
  return (
    APICallError.isInstance(error) &&
    (error.statusCode === 503 || error.statusCode === 429)
  );
}

/** After a model hits a roadblock, try it last for this long (per server instance). */
const SKIP_BUSY_MS = 60_000;
const busyUntil = new Map<ModelId, number>();

/** How long one streaming attempt may wait for its first piece of answer. */
const FIRST_CHUNK_MS = 15_000;
/** How long one non-streaming attempt may take in all. */
const GENERATE_MS = 30_000;

class SlowModelError extends Error {}

type GoogleModel = ReturnType<typeof googleModel>;
type StreamParams = Parameters<GoogleModel["doStream"]>[0];
type StreamResult = Awaited<ReturnType<GoogleModel["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type GenerateParams = Parameters<GoogleModel["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<GoogleModel["doGenerate"]>>;

/** Runs `start` with its own abort signal, cancelled after `ms`. */
async function withDeadline<T>(
  outer: AbortSignal | undefined,
  start: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuterAbort);
  const timer = setTimeout(
    () => controller.abort(new SlowModelError(`no answer within ${ms} ms`)),
    ms,
  );
  try {
    return await Promise.race([
      start(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () =>
          reject(controller.signal.reason),
        ),
      ),
    ]);
  } catch (error) {
    outer?.removeEventListener("abort", onOuterAbort);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Parts that arrive before the model has actually said anything. */
const PREAMBLE = new Set(["stream-start", "response-metadata"]);

/**
 * One streaming attempt. It must start answering within FIRST_CHUNK_MS, and
 * an error in place of the first real part counts as a failed attempt, so the
 * next model can take over before anything reaches the screen.
 */
async function streamAttempt(
  model: GoogleModel,
  params: StreamParams,
): Promise<StreamResult> {
  const { result, reader, held } = await withDeadline(
    params.abortSignal,
    async (abortSignal) => {
      const result = await model.doStream({ ...params, abortSignal });
      const reader = result.stream.getReader();
      const held: StreamPart[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value.type === "error") {
          void reader.cancel().catch(() => {});
          throw next.value.error;
        }
        held.push(next.value);
        if (!PREAMBLE.has(next.value.type)) break;
      }
      return { result, reader, held };
    },
    FIRST_CHUNK_MS,
  );
  // Put the held parts back in front of the rest of the stream.
  const stream = new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of held) controller.enqueue(part);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { ...result, stream };
}

function generateAttempt(
  model: GoogleModel,
  params: GenerateParams,
): Promise<GenerateResult> {
  return withDeadline(
    params.abortSignal,
    async (abortSignal) => model.doGenerate({ ...params, abortSignal }),
    GENERATE_MS,
  );
}

/**
 * The approved models to try, in order: the chosen one, then the fallback,
 * then the rest, newest first. Models that hit a roadblock in the last minute go last.
 */
export function modelOrder(chosen: ModelId, now = Date.now()): ModelId[] {
  const newestFirst = MODELS.map((m) => m.id).reverse();
  const all = [chosen, FALLBACK_MODEL, ...newestFirst].filter(
    (id, i, list) => list.indexOf(id) === i,
  );
  const ready = all.filter((id) => (busyUntil.get(id) ?? 0) <= now);
  return [...ready, ...all.filter((id) => !ready.includes(id))];
}

/** Why a model was passed over, for the terminal log. */
function whyFailed(error: unknown): string {
  if (error instanceof SlowModelError) return "too slow";
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 503) return "overloaded (503)";
    if (error.statusCode === 429) return "out of quota (429)";
    if (error.statusCode) return `refused the request (${error.statusCode})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The model to call. Whenever the chosen model hits a roadblock (busy, out of
 * quota, retired, a server error, a bad response, or no answer in time), the
 * same request moves on to the next approved model, until one answers or all
 * have been tried. `onAnswer` hears which model actually answered.
 * Only a missing key or the caller cancelling stops it straight away.
 */
function languageModel(model: ModelId, onAnswer?: (used: ModelId) => void) {
  async function attempt<T>(
    signal: AbortSignal | undefined,
    run: (m: GoogleModel) => Promise<T>,
  ): Promise<T> {
    const order = modelOrder(model);
    let lastError: unknown;
    for (const [i, id] of order.entries()) {
      try {
        const result = await run(googleModel(id));
        busyUntil.delete(id);
        onAnswer?.(id);
        return result;
      } catch (error) {
        if (error instanceof AiNotConfiguredError || signal?.aborted)
          throw error;
        lastError = error;
        busyUntil.set(id, Date.now() + SKIP_BUSY_MS);
        const next = order[i + 1];
        console.warn(
          `[ai] ${id} hit a roadblock: ${whyFailed(error)}.` +
            (next ? ` Switching to ${next}.` : " No models left to try."),
        );
      }
    }
    throw lastError;
  }

  return wrapLanguageModel({
    model: googleModel(model),
    middleware: {
      wrapGenerate: ({ params }) =>
        attempt(params.abortSignal, (m) => generateAttempt(m, params)),
      wrapStream: ({ params }) =>
        attempt(params.abortSignal, (m) => streamAttempt(m, params)),
    },
  });
}

/** Prints one line per model call, so the cost and time are visible. */
async function logCall(row: AiCallRow): Promise<void> {
  console.info("[ai_calls]", JSON.stringify(row));
}

type Usage = { inputTokens?: number; outputTokens?: number };

/** Builds the ai_calls row for a call that started at `started`. */
function rowFor(
  info: CallInfo,
  model: ModelId | EmbeddingModelId | (() => ModelId),
  started: number,
) {
  return (ok: boolean, usage?: Usage): AiCallRow => {
    const used = typeof model === "function" ? model() : model;
    const input = usage?.inputTokens ?? null;
    const output = usage?.outputTokens ?? null;
    return {
      module: info.module,
      feature: info.feature,
      model: used,
      input_tokens: input,
      output_tokens: output,
      cost_usd:
        input !== null && output !== null ? costUsd(used, input, output) : null,
      latency_ms: Math.round(performance.now() - started),
      ok,
      created_at: new Date().toISOString(),
    };
  };
}

async function tracked<T extends { usage: Usage }>(
  info: CallInfo,
  run: (model: ReturnType<typeof languageModel>) => Promise<T>,
): Promise<T> {
  let used = info.model ?? defaultModel();
  const row = rowFor(info, () => used, performance.now());
  try {
    const result = await run(languageModel(used, (m) => (used = m)));
    await logCall(row(true, result.usage));
    return result;
  } catch (error) {
    if (!(error instanceof AiNotConfiguredError)) await logCall(row(false));
    throw error;
  }
}

// Switching models replaces the SDK's own retries, which would only ask the
// same busy models again. A call can still pass its own maxRetries.
const NO_RETRIES = { maxRetries: 0 };

/** Generates text. Example: callText({ module: 3, feature: "support-answer" }, { prompt }) */
export async function callText(info: CallInfo, options: TextOptions) {
  return tracked(info, (model) =>
    generateText({ ...NO_RETRIES, ...options, model }),
  );
}

/** Generates an object that matches a zod schema; read it from `result.output`. */
export async function callObject<Schema extends z.ZodType>(
  info: CallInfo,
  options: TextOptions & { schema: Schema },
) {
  const { schema, ...rest } = options;
  const result = await tracked(info, (model) =>
    generateText({
      ...NO_RETRIES,
      ...rest,
      model,
      output: Output.object({ schema }),
    }),
  );
  // Spreading `rest` loses generateText's output type; Output.object has
  // already validated it against `schema`, so restore the type here.
  return result as typeof result & { output: z.infer<Schema> };
}

type StreamOptions = DistributiveOmit<
  Parameters<typeof streamText>[0],
  "model" | "output" | "onFinish" | "onError"
>;

/**
 * Streams a reply: read `result.fullStream` to see each step as it happens
 * (thinking, tool calls, tool results, text). Logged to ai_calls when it ends.
 * Example: callStream({ module: 2, feature: "ask-copper" }, { messages })
 */
export function callStream(info: CallInfo, options: StreamOptions) {
  let used = info.model ?? defaultModel();
  const row = rowFor(info, () => used, performance.now());
  return streamText({
    ...NO_RETRIES,
    ...options,
    model: languageModel(used, (m) => (used = m)),
    onFinish: ({ totalUsage }) => logCall(row(true, totalUsage)),
    onError: () => logCall(row(false)),
  });
}

/**
 * What the text is for: "document" for passages being stored for search,
 * "query" for a question being searched with. Gemini embeds each a little
 * differently so questions land near the passages that answer them.
 */
export type EmbedPurpose = "document" | "query";

/** Scales a vector to length 1, so comparing two is a plain dot product. */
function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((x) => x / length);
}

/**
 * Embeds many texts with Gemini's embedding model, in as few requests as
 * possible. Returns one normalized vector per text, in the same order.
 * Example: callEmbedMany({ module: 3, feature: "embed-passages" }, texts, "document")
 */
export async function callEmbedMany(
  info: Omit<CallInfo, "model">,
  values: string[],
  purpose: EmbedPurpose,
): Promise<number[][]> {
  const row = rowFor(info, EMBEDDING_MODEL.id, performance.now());
  try {
    const result = await embedMany({
      model: google().embeddingModel(EMBEDDING_MODEL.googleId),
      values,
      providerOptions: {
        google: {
          outputDimensionality: EMBEDDING_MODEL.dimensions,
          taskType:
            purpose === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
        },
      },
    });
    await logCall(
      row(true, { inputTokens: result.usage.tokens, outputTokens: 0 }),
    );
    return result.embeddings.map(normalize);
  } catch (error) {
    if (!(error instanceof AiNotConfiguredError)) await logCall(row(false));
    throw error;
  }
}

/** Embeds one text. Example: callEmbed({ module: 3, feature: "search" }, question, "query") */
export async function callEmbed(
  info: Omit<CallInfo, "model">,
  value: string,
  purpose: EmbedPurpose,
): Promise<number[]> {
  const [embedding] = await callEmbedMany(info, [value], purpose);
  return embedding;
}

// Asking for some thinking (rather than letting the model decide) is what
// makes Gemini write a summary even for an easy question.
const THINKING = { includeThoughts: true, thinkingBudget: 1024 };

/**
 * Asks Gemini to include a summary of its thinking in the stream (as
 * reasoning parts). Other models ignore it. Pass as `providerOptions`.
 */
export const THOUGHT_SUMMARIES = {
  google: { thinkingConfig: THINKING },
};

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

/** After an overload, skip the busy model for this long (per server instance). */
const SKIP_BUSY_MS = 60_000;
const busyUntil = new Map<ModelId, number>();

/** How long one attempt may wait for its first piece of answer. */
const FIRST_CHUNK_MS = 15_000;

class SlowModelError extends Error {}

type GoogleModel = ReturnType<typeof googleModel>;
type StreamParams = Parameters<GoogleModel["doStream"]>[0];
type StreamResult = Awaited<ReturnType<GoogleModel["doStream"]>>;
type GenerateParams = Parameters<GoogleModel["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<GoogleModel["doGenerate"]>>;

/** Runs `start` with its own abort signal, cancelled after FIRST_CHUNK_MS. */
async function withDeadline<T>(
  outer: AbortSignal | undefined,
  start: (signal: AbortSignal) => Promise<T>,
  ms = FIRST_CHUNK_MS,
): Promise<{ value: T; settle: () => void }> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuterAbort);
  const timer = setTimeout(
    () => controller.abort(new SlowModelError("timed out")),
    ms,
  );
  const settle = () => clearTimeout(timer);
  try {
    const value = await Promise.race([
      start(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () =>
          reject(controller.signal.reason),
        ),
      ),
    ]);
    return { value, settle };
  } catch (error) {
    settle();
    outer?.removeEventListener("abort", onOuterAbort);
    throw error;
  }
}

/** One streaming attempt that must deliver its first part within the deadline. */
async function streamAttempt(
  model: GoogleModel,
  params: StreamParams,
): Promise<StreamResult> {
  const { value, settle } = await withDeadline(
    params.abortSignal,
    async (abortSignal) => {
      const result = await model.doStream({ ...params, abortSignal });
      const reader = result.stream.getReader();
      const first = await reader.read();
      return { result, reader, first };
    },
  );
  settle();
  const { result, reader, first } = value;
  // Put the first part back in front of the rest of the stream.
  const stream = new ReadableStream<(typeof first)["value"] & object>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { ...result, stream } as StreamResult;
}

async function generateAttempt(
  model: GoogleModel,
  params: GenerateParams,
): Promise<GenerateResult> {
  const { value, settle } = await withDeadline(
    params.abortSignal,
    async (abortSignal) => model.doGenerate({ ...params, abortSignal }),
    60_000,
  );
  settle();
  return value;
}

/** Busy, over quota, or too slow to answer: worth trying another model. */
function shouldTryNext(error: unknown): boolean {
  return isOverloaded(error) || error instanceof SlowModelError;
}

/**
 * The model to call. When Google says the chosen model is overloaded or out
 * of free quota, or it doesn't start answering within FIRST_CHUNK_MS, the
 * request moves on to FALLBACK_MODEL (tried twice), so the chat never sits on
 * "Reading your question…" for minutes.
 */
function languageModel(model: ModelId) {
  const primary = googleModel(model);
  const fallback = googleModel(FALLBACK_MODEL);
  const skipPrimary =
    model === FALLBACK_MODEL || (busyUntil.get(model) ?? 0) > Date.now();
  const order = skipPrimary
    ? [fallback, fallback]
    : [primary, fallback, fallback];

  async function attempt<T>(run: (m: GoogleModel) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const [i, candidate] of order.entries()) {
      try {
        return await run(candidate);
      } catch (error) {
        if (!shouldTryNext(error)) throw error;
        lastError = error;
        if (candidate === primary)
          busyUntil.set(model, Date.now() + SKIP_BUSY_MS);
        const why = error instanceof SlowModelError ? "too slow" : "overloaded";
        const next = order[i + 1] === primary ? model : FALLBACK_MODEL;
        if (i + 1 < order.length)
          console.warn(`[ai] ${candidate.modelId} was ${why}; trying ${next}`);
      }
    }
    throw lastError;
  }

  return wrapLanguageModel({
    model: primary,
    middleware: {
      wrapGenerate: ({ params }) => attempt((m) => generateAttempt(m, params)),
      wrapStream: ({ params }) => attempt((m) => streamAttempt(m, params)),
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
  model: ModelId | EmbeddingModelId,
  started: number,
) {
  return (ok: boolean, usage?: Usage): AiCallRow => {
    const input = usage?.inputTokens ?? null;
    const output = usage?.outputTokens ?? null;
    return {
      module: info.module,
      feature: info.feature,
      model,
      input_tokens: input,
      output_tokens: output,
      cost_usd:
        input !== null && output !== null
          ? costUsd(model, input, output)
          : null,
      latency_ms: Math.round(performance.now() - started),
      ok,
      created_at: new Date().toISOString(),
    };
  };
}

async function tracked<T extends { usage: Usage }>(
  info: CallInfo,
  run: (model: ModelId) => Promise<T>,
): Promise<T> {
  const model = info.model ?? defaultModel();
  const row = rowFor(info, model, performance.now());
  try {
    const result = await run(model);
    await logCall(row(true, result.usage));
    return result;
  } catch (error) {
    if (!(error instanceof AiNotConfiguredError)) await logCall(row(false));
    throw error;
  }
}

/** Generates text. Example: callText({ module: 3, feature: "support-answer" }, { prompt }) */
export async function callText(info: CallInfo, options: TextOptions) {
  return tracked(info, (model) =>
    generateText({ ...options, model: languageModel(model) }),
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
      ...rest,
      model: languageModel(model),
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
  const model = info.model ?? defaultModel();
  const row = rowFor(info, model, performance.now());
  return streamText({
    ...options,
    model: languageModel(model),
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

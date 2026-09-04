/**
 * Venice adapter failure surfacing (production incident 2026-07-24).
 *
 * The incident's ask was blunt: "we should log errors on the coordinator, like when
 * we run out of DIEM on Venice." Before this, a non-2xx became a bare Error whose
 * only route to a log was some caller choosing to print it — and credit exhaustion
 * read the same as any other failure, so the one thing an operator can actually act
 * on (top up the account) was buried. These tests pin the boundary behavior: the
 * failure is logged AT the provider, with status + body, before it is thrown, and a
 * payment failure is unmistakable in the log.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { VeniceLlm, VeniceStt } from "./venice.js";
import {
  isPaymentFailure,
  parseModelJson,
  PROVIDER_BODY_LIMITS,
  PROVIDER_TIMEOUTS,
  ProviderHttpError,
  ProviderResponseTooLargeError,
  readJsonCapped,
} from "./http.js";
import { ProviderContractError } from "./types.js";

const req = { system: "s", user: "u", schema: {}, schemaName: "n", model: "m" };
/** These unit tests stub global.fetch, so skip R22 DNS pinning for the fake host. */
const net = { allowInsecure: true };
const apiKey = { prepare: async () => ({ Authorization: "Bearer k" }), settle: async () => {} };

function stubStatus(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("payment/credit classification", () => {
  it("treats 402 as payment regardless of body", () => {
    expect(isPaymentFailure(402, "")).toBe(true);
  });

  it("treats a credit-naming body as payment on any status", () => {
    expect(isPaymentFailure(400, '{"error":{"message":"Insufficient balance"}}')).toBe(true);
    expect(isPaymentFailure(429, "quota exceeded for this key")).toBe(true);
    expect(isPaymentFailure(403, "out of diem")).toBe(true);
  });

  it("does NOT treat a plain rate limit or outage as payment", () => {
    // Ordinary 429s are transient and retrying fixes them; mislabeling one as
    // "top up your account" sends the operator after money that isn't the problem.
    expect(isPaymentFailure(429, "rate limit exceeded, retry in 5s")).toBe(false);
    expect(isPaymentFailure(500, "internal server error")).toBe(false);
    expect(isPaymentFailure(401, "invalid api key")).toBe(false);
  });
});

describe("VeniceLlm — a failed completion is logged at the boundary", () => {
  it("logs a loud, specific line on 402 and throws a billing-classified error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    stubStatus(402, '{"error":"Insufficient USD or DIEM balance"}');
    const llm = new VeniceLlm({ payment: apiKey, net });

    const thrown = await llm.completeStructured(req).catch((e) => e);
    expect(thrown).toBeInstanceOf(ProviderHttpError);
    expect((thrown as ProviderHttpError).payment).toBe(true);
    expect((thrown as ProviderHttpError).status).toBe(402);
    // The wording carries "billing"/"insufficient balance" because errorCategory()
    // matches on it to classify the job failure as provider_billing (long retry
    // tail, so an operator top-up hours later still resolves it).
    expect(String((thrown as Error).message)).toMatch(/billing: insufficient balance \(402\)/);

    const line = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toMatch(/\[llm\] payment\/credit failure \(402\)/);
    expect(line).toMatch(/Venice chat\/completions/);
    expect(line).toMatch(/Insufficient USD or DIEM balance/); // the body excerpt is in the log
  });

  it("logs status + body excerpt on any other non-2xx", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubStatus(503, "upstream model unavailable");
    const llm = new VeniceLlm({ payment: apiKey, net });

    await expect(llm.completeStructured(req)).rejects.toThrow(/503/);
    const line = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toMatch(/\[llm\] provider error \(503\) — Venice chat\/completions: upstream model unavailable/);
  });

  it("logs an embeddings failure too (not just completions)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubStatus(500, "boom");
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(llm.embed(["a"])).rejects.toThrow(/500/);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/\[llm\] provider error \(500\) — Venice embeddings/);
  });
});

describe("VeniceStt — same treatment, tagged as stt", () => {
  it("logs a payment failure under the [stt] tag", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    stubStatus(402, "insufficient balance");
    const stt = new VeniceStt({ payment: apiKey, net });
    await expect(stt.transcribe({ data: new Uint8Array([1, 2, 3]), mime: "audio/ogg" })).rejects.toThrow(/billing/);
    expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/\[stt\] payment\/credit failure \(402\) — Venice STT/);
  });
});

describe("payment preparation is bounded (unbounded await audit)", () => {
  /**
   * `payment.prepare()` runs BEFORE the request deadline is armed and takes no
   * AbortSignal, so a CashuPayment whose mint stops answering used to park the
   * awaiting job forever. Jobs drain strictly one at a time, so "one job parked
   * forever" means the whole pipeline stops with nothing logged — the failure mode
   * that made 2026-07-24 undiagnosable. It must now fail, loudly, on a deadline.
   */
  it("rejects with a provider timeout when prepare() never settles", async () => {
    vi.useFakeTimers();
    stubStatus(200, "{}");
    const llm = new VeniceLlm({
      payment: { prepare: () => new Promise<Record<string, string>>(() => {}), settle: async () => {} },
      net,
    });

    const settled = llm.completeStructured(req).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUTS.payment + 1);
    expect(await settled).toMatch(/provider timeout: Venice payment\.prepare exceeded 30000ms/);
  });

  it("does not fire for a prepare() that returns promptly", async () => {
    stubStatus(200, JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(llm.completeStructured(req)).resolves.toMatchObject({ value: { ok: true } });
  });
});

/**
 * Per-model `disable_thinking` (2026-08-26).
 *
 * The adapter sent `venice_parameters.disable_thinking: true` on every call
 * because every model it had ever been pointed at accepted it. `z-ai-glm-5-3-flash`
 * does not: it answers ANY request carrying the parameter with HTTP 400 "Reasoning
 * is mandatory for this endpoint and cannot be disabled". That is not a degraded
 * match — it is every scoring call failing, for a model the matching bake-off found
 * to be better and cheaper than the deployed one.
 *
 * `reasoning_effort: "none"` is refused the same way, and GET /models advertises
 * "none" as a supported effort for that model, so the catalogue cannot be trusted
 * here (it IS trustworthy for supportsResponseSchema). Hence: config override,
 * plus detection on the model's own refusal.
 */
describe("per-model disable_thinking", () => {
  const bodyOf = (call: unknown) => JSON.parse((call as RequestInit).body as string);
  const ok = JSON.stringify({
    choices: [{ message: { content: '{"a":1}' } }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });

  it("sends disable_thinking by default — the behaviour every deployed model wants", async () => {
    const fetchMock = vi.fn(async () => new Response(ok, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const llm = new VeniceLlm({ payment: apiKey, net });
    await llm.completeStructured({ ...req, model: "deepseek-v4-flash-0731" });
    expect(bodyOf(fetchMock.mock.calls[0][1]).venice_parameters).toMatchObject({
      include_venice_system_prompt: false,
      disable_thinking: true,
      strip_thinking_response: true,
    });
  });

  it("omits it — not sends false — when configured off for that model id", async () => {
    // Omitted rather than `false`, because a provider that rejects the parameter
    // may reject it whatever its value; the only safe request is one without it.
    const fetchMock = vi.fn(async () => new Response(ok, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const llm = new VeniceLlm({
      payment: apiKey,
      net,
      disableThinking: { "z-ai-glm-5-3-flash": false },
    });
    await llm.completeStructured({ ...req, model: "z-ai-glm-5-3-flash" });
    const vp = bodyOf(fetchMock.mock.calls[0][1]).venice_parameters;
    expect(vp).not.toHaveProperty("disable_thinking");
    expect(vp.strip_thinking_response).toBe(true);
  });

  it("keeps the setting per MODEL, not per adapter", async () => {
    const fetchMock = vi.fn(async () => new Response(ok, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const llm = new VeniceLlm({
      payment: apiKey,
      net,
      disableThinking: { "z-ai-glm-5-3-flash": false },
    });
    await llm.completeStructured({ ...req, model: "z-ai-glm-5-3-flash" });
    await llm.completeStructured({ ...req, model: "deepseek-v4-flash-0731" });
    expect(bodyOf(fetchMock.mock.calls[0][1]).venice_parameters).not.toHaveProperty("disable_thinking");
    expect(bodyOf(fetchMock.mock.calls[1][1]).venice_parameters.disable_thinking).toBe(true);
  });

  it("learns the refusal from the model itself, retries, and does not ask again", async () => {
    // Without this the role is a total outage: the parameter goes out on every
    // call, so every call 400s, and no amount of job retrying helps.
    const REFUSAL = JSON.stringify({
      error: "Reasoning is mandatory for this endpoint and cannot be disabled.",
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      JSON.parse(init.body as string).venice_parameters.disable_thinking
        ? new Response(REFUSAL, { status: 400 })
        : new Response(ok, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = new VeniceLlm({ payment: apiKey, net });

    const first = await llm.completeStructured({ ...req, model: "z-ai-glm-5-3-flash" });
    expect(first.value).toEqual({ a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // refused, then retried without it

    // Remembered: the second call must not spend another request rediscovering it.
    await llm.completeStructured({ ...req, model: "z-ai-glm-5-3-flash" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchMock.mock.calls[2][1]).venice_parameters).not.toHaveProperty("disable_thinking");
  });

  it("does NOT swallow an unrelated 400", async () => {
    // 400 covers every malformed request. Retrying a schema error with different
    // parameters would turn a loud bug into a quiet one.
    const fetchMock = vi.fn(async () => new Response('{"error":"bad schema"}', { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(llm.completeStructured({ ...req, model: "m" })).rejects.toThrow(ProviderHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * A response cut off at the token ceiling (2026-09-04 audit).
 *
 * Production scored at the 4096 default while the benchmark harness had long since
 * pinned 12000, with a comment saying that a K=10 batch truncates mid-JSON there.
 * A truncated body is not a lost row — it is unparseable JSON, so the whole batch
 * fails and rides the full paid retry schedule. Nothing read `finish_reason`, so in
 * the log it was indistinguishable from a model emitting garbage, and the two want
 * opposite responses: raise the budget vs. fix the prompt.
 */
describe("truncated completions are named, not mistaken for a malformed model", () => {
  it("reports finish_reason=length and the ceiling that was hit", async () => {
    const truncated = JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: '{"matches":[{"ind' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(truncated, { status: 200 })));
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(
      llm.completeStructured({ ...req, model: "deepseek-v4-flash-0731", maxTokens: 12000 }),
    ).rejects.toThrow(/truncated at the 12000-token ceiling/);
  });

  it("still calls a genuinely malformed body invalid JSON", async () => {
    const garbage = JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "not json at all" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(garbage, { status: 200 })));
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(
      llm.completeStructured({ ...req, model: "deepseek-v4-flash-0731" }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

/**
 * Embeddings: order and count (2026-09-04 audit).
 *
 * `embed` mapped rows POSITIONALLY and never checked how many came back. Two
 * separate faults hid in that:
 *
 *  - OpenAI's embeddings contract gives every row a 0-based `index` naming the
 *    input it belongs to, and does not promise the array is sorted. A gateway that
 *    reorders rows handed attendee A's vector to attendee B, silently. Above the
 *    50-attendee prefilter threshold every attendee then gets someone else's
 *    top-30 candidates, and the only symptom is matches that feel subtly wrong.
 *  - A SHORT response made the caller's `embeddings[i]!` `undefined`, which
 *    `putArtifact` stores as `JSON.stringify(undefined)` — the literal string
 *    `undefined`, not JSON — which then throws inside `utf8ToBytes` on the next
 *    read, failing `match_recompute` and re-billing this call on every retry.
 */
describe("VeniceLlm.embed — vectors land on the input they belong to", () => {
  const vec = (n: number) => [n, n, n];
  const embedBody = (rows: unknown[]) => JSON.stringify({ data: rows });

  it("honours `index` when the gateway returns rows out of order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          embedBody([
            { index: 2, embedding: vec(3) },
            { index: 0, embedding: vec(1) },
            { index: 1, embedding: vec(2) },
          ]),
          { status: 200 },
        ),
      ),
    );
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(llm.embed(["a", "b", "c"])).resolves.toEqual([vec(1), vec(2), vec(3)]);
  });

  it("still maps positionally when the gateway omits `index` (the old behaviour)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(embedBody([{ embedding: vec(1) }, { embedding: vec(2) }]), { status: 200 }),
      ),
    );
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(llm.embed(["a", "b"])).resolves.toEqual([vec(1), vec(2)]);
  });

  it("fails loudly on a SHORT response instead of yielding an undefined vector", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(embedBody([{ index: 0, embedding: vec(1) }]), { status: 200 })),
    );
    const llm = new VeniceLlm({ payment: apiKey, net });
    const thrown = await llm.embed(["a", "b", "c"]).catch((e) => e);
    expect(thrown).toBeInstanceOf(ProviderContractError);
    expect((thrown as Error).message).toMatch(/expected 3 vectors, got 1/);
  });

  it("rejects a duplicated or out-of-range index rather than letting one row win", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          embedBody([
            { index: 0, embedding: vec(1) },
            { index: 0, embedding: vec(9) }, // would silently overwrite attendee 0
          ]),
          { status: 200 },
        ),
      ),
    );
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(llm.embed(["a", "b"])).rejects.toThrow(/duplicate/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          embedBody([
            { index: 0, embedding: vec(1) },
            { index: 7, embedding: vec(2) },
          ]),
          { status: 200 },
        ),
      ),
    );
    await expect(new VeniceLlm({ payment: apiKey, net }).embed(["a", "b"])).rejects.toThrow(
      /out of range/,
    );
  });
});

/**
 * STT: an ABSENT `text` (2026-09-04 audit). It became `""`, and transcribe.ts
 * caches a transcript by blob sha256 forever — so one transient provider glitch
 * permanently discarded an intro the attendee had recorded, indistinguishable from
 * silence and with no log line at all. A wrong-TYPED `text` already threw.
 */
describe("VeniceStt — an absent transcript is a contract error, not silence", () => {
  it("throws when the response carries no `text` field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ language: "en" }), { status: 200 })));
    const stt = new VeniceStt({ payment: apiKey, net });
    const thrown = await stt
      .transcribe({ data: new Uint8Array([1, 2, 3]), mime: "audio/ogg" })
      .catch((e) => e);
    expect(thrown).toBeInstanceOf(ProviderContractError);
    expect((thrown as Error).message).toMatch(/no `text` field/);
  });

  it("still throws on a wrong-typed `text`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: 42 }), { status: 200 })));
    const stt = new VeniceStt({ payment: apiKey, net });
    await expect(
      stt.transcribe({ data: new Uint8Array([1, 2, 3]), mime: "audio/ogg" }),
    ).rejects.toThrow(/text was not a string/);
  });

  it("an explicit empty string is still a valid (if empty) transcript", async () => {
    // Genuine silence exists. Only ABSENCE is the contract violation — the caller
    // in transcribe.ts decides whether an empty transcript is worth caching.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "" }), { status: 200 })));
    const stt = new VeniceStt({ payment: apiKey, net });
    await expect(
      stt.transcribe({ data: new Uint8Array([1, 2, 3]), mime: "audio/ogg" }),
    ).resolves.toEqual({ text: "", language: undefined });
  });
});

/**
 * Lenient model-output parsing (docs/MODEL-BAKEOFF.md adoption item 2).
 *
 * `z-ai-glm-5-3-flash` fences its output despite `response_format: {strict: true}`
 * — 3 of 82 scoring calls survived a bare `JSON.parse`. So it benchmarks at zero
 * format failures and would have failed ~96% of production calls, which is the one
 * thing keeping the bakeoff's quality-and-cost winner unadoptable.
 */
describe("parseModelJson", () => {
  it("parses plain JSON exactly as JSON.parse does", () => {
    expect(parseModelJson('{"matches":[{"index":1}]}')).toEqual({ matches: [{ index: 1 }] });
    expect(parseModelJson("  [1,2,3]  ")).toEqual([1, 2, 3]);
  });

  it("strips a ```json fence", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('  ```JSON \n{"a":1}\n  ```  ')).toEqual({ a: 1 });
  });

  it("tolerates a leading sentence before the object", () => {
    expect(parseModelJson('Here is the JSON you asked for:\n{"a":1}')).toEqual({ a: 1 });
  });

  it("does NOT mask a genuinely malformed response", () => {
    // Truncated mid-object (the finish_reason=length case), unbalanced, prose only,
    // and a fence around something that is not JSON.
    expect(() => parseModelJson('{"matches":[{"ind')).toThrow();
    expect(() => parseModelJson('```json\n{"a":1,\n```')).toThrow();
    expect(() => parseModelJson("I am unable to comply with this request.")).toThrow();
    expect(() => parseModelJson("```json\nnot json at all\n```")).toThrow();
  });

  it("does not silently accept the FIRST of two values, hiding the rest", () => {
    // A depth-counting extractor stops at the first balanced object and drops what
    // follows — turning "the model answered twice" into a confident wrong answer.
    // Taking the outermost span keeps the trailing text inside the strict re-parse.
    expect(() => parseModelJson('{"a":1} {"b":2}')).toThrow();
  });

  it("the adapter accepts a fenced completion end-to-end", async () => {
    const fenced = JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: '```json\n{"ok":true}\n```' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fenced, { status: 200 })));
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(llm.completeStructured({ ...req, model: "z-ai-glm-5-3-flash" })).resolves.toMatchObject({
      value: { ok: true },
    });
  });
});

/**
 * Response byte caps (2026-09-04 audit). `guardedProviderFetch` hands the raw
 * `Response` to the handler and caps nothing — unlike `safeFetch`, which streams
 * every download under an explicit `maxBytes`. A bare `res.json()` therefore
 * buffers whatever the socket keeps sending, inside a 120s completion deadline, in
 * a single-threaded daemon that drains jobs serially. And a Routstr node is
 * DISCOVERED from an untrusted kind-38421 announcement, so the operator never
 * chose the host the bytes come from.
 */
describe("readJsonCapped", () => {
  it("reads a normal body", async () => {
    await expect(readJsonCapped(new Response('{"a":1}'), "t")).resolves.toEqual({ a: 1 });
  });

  it("aborts once the cap is passed, instead of buffering the whole stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Far more than the cap, delivered in chunks like a real socket would.
        for (let i = 0; i < 64; i++) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    await expect(readJsonCapped(new Response(body), "t", 4096)).rejects.toBeInstanceOf(
      ProviderResponseTooLargeError,
    );
  });

  it("names the operation and the cap so an operator can tell which call blew up", async () => {
    const thrown = await readJsonCapped(new Response("x".repeat(100)), "Venice embeddings", 10).catch(
      (e) => e,
    );
    expect(String((thrown as Error).message)).toMatch(/Venice embeddings.*10-byte cap/);
  });

  it("gives embeddings a larger cap than the other reads (a whole roster in one call)", () => {
    expect(PROVIDER_BODY_LIMITS.embedding).toBeGreaterThan(PROVIDER_BODY_LIMITS.json);
    expect(PROVIDER_BODY_LIMITS.json).toBeGreaterThan(PROVIDER_BODY_LIMITS.error);
  });

  it("the completion path is capped, not just the helper", async () => {
    const huge = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
        for (let i = 0; i < PROVIDER_BODY_LIMITS.json / (1024 * 1024) + 2; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(huge, { status: 200 })));
    const llm = new VeniceLlm({ payment: apiKey, net });
    await expect(llm.completeStructured(req)).rejects.toBeInstanceOf(ProviderResponseTooLargeError);
  });
});

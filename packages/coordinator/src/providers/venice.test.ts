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
import { isPaymentFailure, PROVIDER_TIMEOUTS, ProviderHttpError } from "./http.js";

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

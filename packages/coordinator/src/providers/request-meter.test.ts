/**
 * Billed provider requests are counted where they go out (audit KIMIK31 R-6).
 *
 * The `*_calls` budgets count job RUNS, and stay that way by owner decision. What
 * these tests pin is the logged count beside them: every billed adapter request
 * passes `withProviderTimeout`, is counted there by kind (including a failed one,
 * a 402 and an adapter-internal retry), metadata requests are not, and the count
 * lands on the job that sent it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Store } from "../store/db.js";
import { JobRunner } from "../pipeline/jobs.js";
import { VeniceLlm, VeniceStt } from "./venice.js";
import { RoutstrLlm } from "./routstr.js";
import {
  billedKindOf,
  emptyTally,
  formatJobSpend,
  formatTally,
  formatWindowSummary,
  noteCountedRun,
  ProviderRequestMeter,
  providerRequests,
  runWithRequestTally,
} from "./request-meter.js";

const net = { allowInsecure: true };
const payment = { prepare: async () => ({ Authorization: "Bearer k" }), settle: async () => {} };
const req = { system: "s", user: "u", schema: {}, schemaName: "n", model: "m" };
const audio = { data: new Uint8Array([1, 2, 3]), mime: "audio/ogg" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every fetch answers with `status` and returns the URLs it saw. */
function stubAll(status: number, body = "{}"): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(body, { status });
    }),
  );
  return urls;
}

async function tallyOf(fn: () => Promise<unknown>) {
  const t = emptyTally();
  await runWithRequestTally(t, async () => {
    await fn().catch(() => {});
  });
  return t;
}

describe("billedKindOf", () => {
  it("classifies the adapters' billed labels and ignores metadata", () => {
    expect(billedKindOf("Venice chat/completions")).toBe("chat");
    expect(billedKindOf("Routstr chat/completions")).toBe("chat");
    expect(billedKindOf("Venice decisions")).toBe("decision");
    expect(billedKindOf("Venice embeddings")).toBe("embed");
    expect(billedKindOf("Venice STT")).toBe("stt");
    expect(billedKindOf("Venice GET /models?type=embedding")).toBeUndefined();
    expect(billedKindOf("Routstr GET /info")).toBeUndefined();
  });
});

describe("each adapter request is counted once, by kind, whatever its outcome", () => {
  it("Venice STT, chat, decisions and embeddings — refused with a 402", async () => {
    // A 402 is the case that matters most to the bill: the request was sent and
    // the job will retry it. Counting only successes would hide exactly that.
    const urls = stubAll(402, '{"error":"insufficient balance"}');
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const llm = new VeniceLlm({ apiKey: "k", payment, net } as any);
    const stt = new VeniceStt({ apiKey: "k", payment, net } as any);
    const t = await tallyOf(async () => {
      await stt.transcribe(audio).catch(() => {});
      await stt.transcribe(audio).catch(() => {});
      await llm.completeStructured(req).catch(() => {});
      await llm.decide({ state: {}, questions: {}, model: "jev" }).catch(() => {});
      await llm.embed(["a"]).catch(() => {});
    });
    expect(urls).toHaveLength(5);
    expect(t).toEqual({ total: 5, runs: 0, byKind: { stt: 2, chat: 1, decision: 1, embed: 1 } });
  });

  it("counts both requests of VeniceLlm's learn-and-retry, and not GET /models", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/models")) return Response.json({ data: [] });
        // First completion: the model refuses disable_thinking; the adapter
        // corrects its traits and sends the request again.
        if (n++ === 0) return new Response('{"error":"reasoning is mandatory"}', { status: 400 });
        return Response.json({ choices: [{ message: { content: "{}" } }] });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const llm = new VeniceLlm({ apiKey: "k", payment, net, disableThinking: { m: true } } as any);
    const t = await tallyOf(async () => {
      await llm.models();
      await llm.completeStructured(req);
    });
    expect(n).toBe(2);
    expect(t).toEqual({ total: 2, runs: 0, byKind: { chat: 2 } });
  });

  it("Routstr chat, including one that fails at the network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const llm = new RoutstrLlm({ nodeUrl: "https://node/v1", payment: { ...payment, fail: async () => {} }, net });
    const t = await tallyOf(() => llm.completeStructured(req));
    expect(t).toEqual({ total: 1, runs: 0, byKind: { chat: 1 } });
  });

  it("also feeds the daemon-wide meter, outside any job", async () => {
    stubAll(500);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = providerRequests.window(1).byKind.stt ?? 0;
    await new VeniceStt({ apiKey: "k", payment, net } as any).transcribe(audio).catch(() => {});
    expect(providerRequests.window(1).byKind.stt).toBe(before + 1);
  });
});

describe("the job line carries what the run sent", () => {
  it("a multi-stage job: one counted run, one request per actual call, by kind", async () => {
    stubAll(500);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(s));
    const llm = new VeniceLlm({ apiKey: "k", payment, net } as any);
    const stt = new VeniceStt({ apiKey: "k", payment, net } as any);
    const store = new Store();
    const runner = new JobRunner(store, {});
    runner.register("process_attendee", async () => {
      noteCountedRun(); // what assertSpendAllowed does once per paid job
      // Two media items, then summary, profile and translation.
      for (let i = 0; i < 2; i++) await stt.transcribe(audio).catch(() => {});
      for (let i = 0; i < 3; i++) await llm.completeStructured(req).catch(() => {});
    });
    runner.register("publish_profile", async () => {});
    runner.enqueue("process_attendee", "k1", {});
    runner.enqueue("publish_profile", "k2", {});
    await runner.drain();
    const done = lines.find((l) => /process_attendee #\d+ done/.test(l));
    expect(done).toMatch(/done in \d+ms — 1 counted run, 5 provider requests \(stt 2, chat 3\)$/);
    // A job that spends nothing keeps its short line.
    expect(lines.find((l) => /publish_profile #\d+ done/.test(l))).toMatch(/done in \d+ms$/);
  });

  it("a failed run still reports what it sent", async () => {
    stubAll(402);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((s: string) => void warns.push(s));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stt = new VeniceStt({ apiKey: "k", payment, net } as any);
    const runner = new JobRunner(new Store(), {});
    runner.register("process_attendee", async () => {
      noteCountedRun();
      await stt.transcribe(audio);
    });
    runner.enqueue("process_attendee", "k1", {});
    await runner.runOne();
    expect(warns.find((l) => /process_attendee #\d+ failed/.test(l))).toMatch(
      /after \d+ms — 1 counted run, 1 provider request \(stt 1\):/,
    );
  });
});

describe("formatting and the window", () => {
  it("formats tallies and the periodic summary", () => {
    expect(formatTally(emptyTally())).toBe("0 provider requests");
    expect(formatJobSpend(emptyTally())).toBeUndefined();
    expect(
      formatWindowSummary({
        windowHours: 24,
        runs: 40,
        runLimit: 80_000,
        requests: { total: 112, runs: 0, byKind: { chat: 80, stt: 20, embed: 12 } },
        uptimeMs: 48 * 3_600_000,
      }),
    ).toBe(
      "[budget] last 24h: 40 counted runs (daemon_calls_per_window 80000), 112 provider requests " +
        "(stt 20, chat 80, embed 12), 2.8 per run — requests are logged, not enforced",
    );
    expect(
      formatWindowSummary({ windowHours: 24, runs: 1, runLimit: 0, requests: emptyTally(), uptimeMs: 5 * 60_000 }),
    ).toMatch(/1 counted run \(daemon_calls_per_window unlimited\), 0 provider requests since this process started 5 min ago, 0\.0 per run/);
  });

  it("the window drops hours that have rolled out of it", () => {
    let t = 10 * 3_600_000;
    const m = new ProviderRequestMeter(() => t);
    m.record("chat");
    t += 3_600_000;
    m.record("stt");
    expect(m.window(2).total).toBe(2);
    expect(m.window(1)).toEqual({ total: 1, runs: 0, byKind: { stt: 1 } });
    t += 30 * 3_600_000;
    expect(m.window(24).total).toBe(0);
  });
});

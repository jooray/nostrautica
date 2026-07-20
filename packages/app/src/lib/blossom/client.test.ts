import { describe, it, expect, vi, afterEach } from "vitest";
import { uploadAndMirror } from "./client.js";
import { LocalSigner } from "$lib/signer/local.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("uploadAndMirror", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls through to the next server when the first upload fails", async () => {
    const signer = LocalSigner.generate();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.startsWith("https://bad.example/upload")) {
        return new Response("nope", { status: 415 });
      }
      if (url.startsWith("https://good.example/upload")) {
        return jsonResponse({ url: "https://good.example/deadbeef" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadAndMirror(
      signer,
      ["https://bad.example", "https://good.example"],
      new Uint8Array([1, 2, 3]),
      "application/octet-stream",
    );

    expect(result.primary).toBe("https://good.example/deadbeef");
    expect(calls[0]).toBe("PUT https://bad.example/upload");
    expect(calls[1]).toBe("PUT https://good.example/upload");
  });

  it("throws with every server's error when all uploads fail", async () => {
    const signer = LocalSigner.generate();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 415 })),
    );

    await expect(
      uploadAndMirror(
        signer,
        ["https://bad-one.example", "https://bad-two.example"],
        new Uint8Array([1, 2, 3]),
        "application/octet-stream",
      ),
    ).rejects.toThrow(/bad-one\.example.*bad-two\.example/s);
  });
});

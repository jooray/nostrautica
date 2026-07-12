import { describe, it, expect } from "vitest";
import { parsePostContent, imetaUrls } from "./render.js";

describe("parsePostContent", () => {
  it("splits text, links, images, and mentions", () => {
    const tokens = parsePostContent(
      "hey nostr:npub1abc check https://example.com and https://x.com/pic.png",
    );
    expect(tokens).toEqual([
      { type: "text", value: "hey " },
      { type: "mention", bech32: "npub1abc" },
      { type: "text", value: " check " },
      { type: "link", url: "https://example.com" },
      { type: "text", value: " and " },
      { type: "image", url: "https://x.com/pic.png" },
    ]);
  });

  it("treats imeta-advertised urls as images even without an extension", () => {
    const tokens = parsePostContent("see https://blossom.example/abcd", [
      "https://blossom.example/abcd",
    ]);
    expect(tokens.find((t) => t.type === "image")).toEqual({
      type: "image",
      url: "https://blossom.example/abcd",
    });
  });

  it("plain text is a single token", () => {
    expect(parsePostContent("just words")).toEqual([{ type: "text", value: "just words" }]);
  });

  it("imetaUrls extracts url fields from imeta tags", () => {
    expect(
      imetaUrls([
        ["imeta", "url https://a.example/1.png", "m image/png"],
        ["t", "nostr"],
        ["imeta", "url https://b.example/2.jpg"],
      ]),
    ).toEqual(["https://a.example/1.png", "https://b.example/2.jpg"]);
  });
});

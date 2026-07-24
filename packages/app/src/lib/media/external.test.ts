import { describe, it, expect } from "vitest";
import { isYouTubeUrl, youTubeId, youTubeEmbedUrl, classifyTalkUrl } from "./external.js";

describe("external talk URL helpers", () => {
  it("recognizes YouTube URLs across shapes", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://cdn.example/talk.mp4")).toBe(false);
    expect(isYouTubeUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false); // non-https
  });

  it("extracts the video id from every common shape", () => {
    expect(youTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for a YouTube host with no valid id", () => {
    expect(youTubeId("https://www.youtube.com/feed/subscriptions")).toBeNull();
    expect(youTubeId("https://cdn.example/talk.mp4")).toBeNull();
  });

  it("builds the no-cookie embed URL", () => {
    expect(youTubeEmbedUrl("dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
  });

  it("classifies a direct video URL as kind:video", () => {
    expect(classifyTalkUrl("https://cdn.example/talk.mp4")).toEqual({
      kind: "video",
      url: "https://cdn.example/talk.mp4",
    });
  });

  it("classifies a YouTube URL as kind:youtube", () => {
    expect(classifyTalkUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      kind: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
  });

  it("rejects non-https and malformed input", () => {
    expect(classifyTalkUrl("http://cdn.example/talk.mp4")).toBeNull();
    expect(classifyTalkUrl("not a url")).toBeNull();
    expect(classifyTalkUrl("")).toBeNull();
  });

  it("rejects a YouTube host without a resolvable video id", () => {
    expect(classifyTalkUrl("https://www.youtube.com/feed/trending")).toBeNull();
  });
});

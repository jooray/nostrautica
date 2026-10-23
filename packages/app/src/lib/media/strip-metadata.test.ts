import { describe, it, expect } from "vitest";
import { stripMediaMetadata, sniffContainer, MetadataStripError } from "./strip-metadata.js";

// ---------------------------------------------------------------------------
// Fixture helpers: every file below is built byte by byte, so each test states
// exactly which metadata it plants and where the media bytes sit.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const str = (s: string) => enc.encode(s);

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function be(n: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let v = n;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function le32(n: number): Uint8Array {
  return be(n, 4).reverse();
}

/** Byte-string search, so "the location is gone" is asserted on raw bytes. */
function contains(hay: Uint8Array, needle: Uint8Array | string): boolean {
  const n = typeof needle === "string" ? str(needle) : needle;
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

function indexOf(hay: Uint8Array, needle: string): number {
  const n = str(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

async function run(bytes: Uint8Array, type = ""): Promise<Uint8Array> {
  const out = await stripMediaMetadata(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  return new Uint8Array(await out.arrayBuffer());
}

async function refused(bytes: Uint8Array): Promise<unknown> {
  return stripMediaMetadata(new Blob([bytes as Uint8Array<ArrayBuffer>])).then(
    () => null,
    (e: unknown) => e,
  );
}

// --- ISO-BMFF --------------------------------------------------------------

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = cat(...payload);
  return cat(be(8 + body.length, 4), str(type), body);
}

/** The same box with a 64-bit largesize header (size field = 1). */
function largeBox(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = cat(...payload);
  return cat(be(1, 4), str(type), be(16 + body.length, 8), body);
}

function fullBox(type: string, version: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array([version, 0, 0, 0]), ...payload);
}

const T_CREATED = 0xdeadbeef;
const T_MODIFIED = 0xcafef00d;

function mvhd(): Uint8Array {
  // v0: creation, modification, timescale=1000, duration=5000, then 80 bytes.
  return fullBox("mvhd", 0, be(T_CREATED, 4), be(T_MODIFIED, 4), be(1000, 4), be(5000, 4), new Uint8Array(80));
}
function tkhd(): Uint8Array {
  return fullBox("tkhd", 0, be(T_CREATED, 4), be(T_MODIFIED, 4), be(1, 4), new Uint8Array(72));
}
function mdhd(): Uint8Array {
  // v1: 64-bit times.
  return fullBox("mdhd", 1, be(T_CREATED, 8), be(T_MODIFIED, 8), be(44100, 4), be(9000, 8), new Uint8Array(4));
}
function hdlr(handler: string, name = "Core Media"): Uint8Array {
  return fullBox("hdlr", 0, new Uint8Array(4), str(handler), new Uint8Array(12), str(name + "\0"));
}

/** A track whose `sizes` samples sit in one chunk at `offset` (stco or co64). */
function trak(handler: string, sizes: number[], offset: number, co64 = false): Uint8Array {
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, be(0, 4)),
    fullBox("stsz", 0, be(0, 4), be(sizes.length, 4), ...sizes.map((s) => be(s, 4))),
    fullBox("stsc", 0, be(1, 4), be(1, 4), be(sizes.length, 4), be(1, 4)),
    co64 ? fullBox("co64", 0, be(1, 4), be(offset, 8)) : fullBox("stco", 0, be(1, 4), be(offset, 4)),
  );
  return box("trak", tkhd(), box("mdia", mdhd(), hdlr(handler), box("minf", stbl)));
}

const LOCATION = "+48.1486+017.1077/";
const VIDEO = str("VIDEOSAMPLE-ONE|VIDEOSAMPLE-TWO|");
const GPS = str("GPMF-GPS5:48.1486,17.1077");

/**
 * A phone-style mp4: a video track, a GoPro-style GPS metadata track whose
 * samples live in mdat, moov/udta with ©xyz + make/model, an Apple mdta `meta`
 * with a 64-bit size, a top-level XMP `uuid` (largesize) and a top-level `meta`.
 */
function phoneMp4(): { file: Uint8Array; videoAt: number; gpsAt: number } {
  const ftyp = box("ftyp", str("isom"), be(512, 4), str("isomiso2avc1mp41"));
  const build = (videoAt: number, gpsAt: number) =>
    box(
      "moov",
      mvhd(),
      trak("vide", [16, 16], videoAt),
      trak("meta", [GPS.length], gpsAt, true),
      box(
        "udta",
        box("©xyz", be(LOCATION.length, 2), be(0x15c7, 2), str(LOCATION)),
        box("©mak", str("Apple")),
        box("©mod", str("iPhone 15 Pro")),
      ),
      largeBox(
        "meta",
        hdlr("mdta"),
        box("keys", str("com.apple.quicktime.location.ISO6709")),
        box("ilst", box("data", str(LOCATION))),
      ),
    );
  const probe = build(0, 0);
  const mdatStart = ftyp.length + probe.length + 8;
  const moov = build(mdatStart, mdatStart + VIDEO.length);
  const mdat = box("mdat", VIDEO, GPS);
  const xmp = largeBox(
    "uuid",
    new Uint8Array([0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac]),
    str('<x:xmpmeta><exif:GPSLatitude>48,8.916N</exif:GPSLatitude><xmp:CreateDate>2026-10-01</xmp:CreateDate>'),
  );
  const topMeta = fullBox("meta", 0, hdlr("ID32"), box("ID32", str("ID3 Secret Album")));
  return { file: cat(ftyp, moov, mdat, xmp, topMeta), videoAt: mdatStart, gpsAt: mdatStart + VIDEO.length };
}

interface ParsedBox {
  type: string;
  start: number;
  end: number;
  headerLen: number;
}

/** A test-side box walker, independent of the code under test. */
function boxesIn(b: Uint8Array, from: number, to: number): ParsedBox[] {
  const out: ParsedBox[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = from;
  while (at < to) {
    let size = dv.getUint32(at);
    let headerLen = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(at + 8));
      headerLen = 16;
    } else if (size === 0) size = to - at;
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    out.push({ type, start: at, end: at + size, headerLen });
    at += size;
  }
  expect(at).toBe(to);
  return out;
}

function find(b: Uint8Array, path: string[]): ParsedBox {
  let from = 0;
  let to = b.length;
  let hit: ParsedBox | undefined;
  for (const type of path) {
    hit = boxesIn(b, from, to).find((x) => x.type === type);
    if (!hit) throw new Error(`no ${path.join("/")}`);
    from = hit.start + hit.headerLen;
    to = hit.end;
  }
  return hit!;
}

// --- EBML ------------------------------------------------------------------

function vsize(n: number): Uint8Array {
  if (n < 0x7f) return new Uint8Array([0x80 | n]);
  if (n < 0x3fff) return new Uint8Array([0x40 | (n >> 8), n & 0xff]);
  return cat(new Uint8Array([0x10]), be(n, 3));
}

function el(id: number[], ...payload: Uint8Array[]): Uint8Array {
  const body = cat(...payload);
  return cat(new Uint8Array(id), vsize(body.length), body);
}

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  DocType: [0x42, 0x82],
  Segment: [0x18, 0x53, 0x80, 0x67],
  SeekHead: [0x11, 0x4d, 0x9b, 0x74],
  Seek: [0x4d, 0xbb],
  SeekID: [0x53, 0xab],
  SeekPosition: [0x53, 0xac],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimestampScale: [0x2a, 0xd7, 0xb1],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  DateUTC: [0x44, 0x61],
  Title: [0x7b, 0xa9],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  Name: [0x53, 0x6e],
  CodecID: [0x86],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timestamp: [0xe7],
  SimpleBlock: [0xa3],
  Tags: [0x12, 0x54, 0xc3, 0x67],
  Tag: [0x73, 0x73],
  SimpleTag: [0x67, 0xc8],
  TagString: [0x44, 0x87],
  Attachments: [0x19, 0x41, 0xa4, 0x69],
  CRC32: [0xbf],
};

/**
 * A webm: unknown-size Segment, a SeekHead pointing at Info and Tags, an Info
 * with a CRC-32 and every identifying field, a named track, an unknown-size
 * cluster (MediaRecorder style), then a Tags element large enough to need a
 * 2-byte size, and an attachment.
 */
function taggedWebm(): Uint8Array {
  const header = el(ID.EBML, el(ID.DocType, str("webm")));
  const seekHead = el(
    ID.SeekHead,
    el(ID.Seek, el(ID.SeekID, new Uint8Array(ID.Info)), el(ID.SeekPosition, be(64, 2))),
    el(ID.Seek, el(ID.SeekID, new Uint8Array(ID.Tags)), el(ID.SeekPosition, be(4096, 2))),
  );
  const info = el(
    ID.Info,
    el(ID.CRC32, be(0x12345678, 4)),
    el(ID.TimestampScale, be(1000000, 3)),
    el(ID.MuxingApp, str("SecretMuxer 1.0")),
    el(ID.WritingApp, str("SecretWriter on Pixel 10")),
    el(ID.DateUTC, be(0x0a0b0c0d0e0f, 8)),
    el(ID.Title, str("Secret Title")),
  );
  const tracks = el(
    ID.Tracks,
    el(ID.TrackEntry, el(ID.TrackNumber, be(1, 1)), el(ID.Name, str("Secret Track")), el(ID.CodecID, str("V_VP8"))),
  );
  const cluster = cat(
    new Uint8Array(ID.Cluster),
    new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    el(ID.Timestamp, be(0, 1)),
    el(ID.SimpleBlock, str("FRAMEDATA-ONE")),
    el(ID.SimpleBlock, str("FRAMEDATA-TWO")),
  );
  const tags = el(
    ID.Tags,
    el(ID.Tag, el(ID.SimpleTag, el(ID.TagString, str("Secret Tag " + "x".repeat(300))))),
  );
  const attachments = el(ID.Attachments, str("Secret cover art with EXIF"));
  const segment = cat(
    new Uint8Array(ID.Segment),
    new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    seekHead,
    info,
    tracks,
    cluster,
    tags,
    attachments,
  );
  return cat(header, segment);
}

interface ParsedEl {
  id: number;
  start: number;
  dataStart: number;
  end: number | null;
}

function ebmlAt(b: Uint8Array, at: number): ParsedEl {
  const first = b[at]!;
  const idLen = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : 4;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[at + i]!;
  const s = at + idLen;
  let w = 1;
  while (!(b[s]! & (0x80 >> (w - 1)))) w++;
  let v = b[s]! & (0xff >> w);
  let ones = v === 0xff >> w;
  for (let i = 1; i < w; i++) {
    v = v * 256 + b[s + i]!;
    if (b[s + i] !== 0xff) ones = false;
  }
  return { id, start: at, dataStart: s + w, end: ones ? null : s + w + v };
}

function children(b: Uint8Array, from: number, to: number): ParsedEl[] {
  const out: ParsedEl[] = [];
  let at = from;
  while (at < to) {
    const e = ebmlAt(b, at);
    expect(e.end).not.toBeNull();
    out.push(e);
    at = e.end!;
  }
  expect(at).toBe(to);
  return out;
}

const VOID = 0xec;

// ---------------------------------------------------------------------------

describe("stripMediaMetadata: ISO-BMFF (mp4/mov)", () => {
  it("removes location, device, XMP and dates without moving a byte", async () => {
    const { file, videoAt, gpsAt } = phoneMp4();
    // The fixture really carries what the test claims to remove.
    for (const s of [LOCATION, "iPhone", "Apple", "GPSLatitude", "GPMF-GPS5", "Secret Album"])
      expect(contains(file, s)).toBe(true);

    const out = await run(file, "video/mp4");
    expect(out.length).toBe(file.length);
    for (const s of [LOCATION, "iPhone", "Apple", "GPSLatitude", "CreateDate", "GPMF-GPS5", "Secret Album", "location"])
      expect(contains(out, s), s).toBe(false);

    // Same top-level layout; the metadata boxes are now free boxes.
    expect(boxesIn(out, 0, out.length).map((b) => b.type)).toEqual(["ftyp", "moov", "mdat", "free", "free"]);
    // The kept 64-bit header is still a 64-bit header of the same size.
    const xmp = boxesIn(out, 0, out.length)[3]!;
    expect(xmp.headerLen).toBe(16);
    expect(xmp.end - xmp.start).toBe(boxesIn(file, 0, file.length)[3]!.end - boxesIn(file, 0, file.length)[3]!.start);

    // Inside moov: the GPS track and udta/meta are gone; one video trak remains.
    const moov = find(out, ["moov"]);
    expect(boxesIn(out, moov.start + 8, moov.end).map((b) => b.type)).toEqual(["mvhd", "trak", "free", "free", "free"]);

    // The video samples are byte-identical where stco says they are…
    expect(out.subarray(videoAt, videoAt + VIDEO.length)).toEqual(VIDEO);
    const stco = find(out, ["moov", "trak", "mdia", "minf", "stbl", "stco"]);
    expect(new DataView(out.buffer).getUint32(stco.start + 16)).toBe(videoAt);
    // …while the dropped track's samples are zeroed, not left behind in mdat.
    expect(out.subarray(gpsAt, gpsAt + GPS.length).every((x) => x === 0)).toBe(true);
    // Everything outside moov and the removed regions is untouched.
    expect(out.subarray(0, moov.start)).toEqual(file.subarray(0, moov.start));
  });

  it("zeroes the mvhd/tkhd/mdhd timestamps (v0 and v1) and keeps the timescale", async () => {
    const { file } = phoneMp4();
    const out = await run(file);
    const dv = new DataView(out.buffer);
    const mv = find(out, ["moov", "mvhd"]);
    expect(dv.getUint32(mv.start + 12)).toBe(0);
    expect(dv.getUint32(mv.start + 16)).toBe(0);
    expect(dv.getUint32(mv.start + 20)).toBe(1000);
    expect(dv.getUint32(mv.start + 24)).toBe(5000);
    const tk = find(out, ["moov", "trak", "tkhd"]);
    expect(dv.getUint32(tk.start + 12)).toBe(0);
    expect(dv.getUint32(tk.start + 16)).toBe(0);
    expect(dv.getUint32(tk.start + 20)).toBe(1); // track id
    const md = find(out, ["moov", "trak", "mdia", "mdhd"]);
    expect(dv.getBigUint64(md.start + 12)).toBe(0n);
    expect(dv.getBigUint64(md.start + 20)).toBe(0n);
    expect(dv.getUint32(md.start + 28)).toBe(44100);
    expect(contains(out, be(T_CREATED, 4))).toBe(false);
    expect(contains(out, be(T_MODIFIED, 4))).toBe(false);
  });

  it("strips iTunes tags (ilst) from an m4a and keeps the audio and its MIME", async () => {
    const ftyp = box("ftyp", str("M4A "), be(0, 4), str("M4A mp42isom"));
    const audio = str("AAC-FRAMES-AAC-FRAMES");
    const build = (at: number) =>
      box(
        "moov",
        mvhd(),
        trak("soun", [audio.length], at),
        box(
          "udta",
          fullBox(
            "meta",
            0,
            hdlr("mdir"),
            box(
              "ilst",
              box("©nam", box("data", be(1, 4), be(0, 4), str("Secret Voice Memo"))),
              box("©day", box("data", be(1, 4), be(0, 4), str("2026-10-01T09:30:00Z"))),
              box("covr", box("data", be(13, 4), be(0, 4), str("JFIF-with-GPS"))),
            ),
          ),
        ),
      );
    const at = ftyp.length + build(0).length + 8;
    const file = cat(ftyp, build(at), box("mdat", audio));
    const blob = await stripMediaMetadata(new Blob([file as Uint8Array<ArrayBuffer>], { type: "audio/mp4" }));
    expect(blob.type).toBe("audio/mp4");
    const out = new Uint8Array(await blob.arrayBuffer());
    expect(out.length).toBe(file.length);
    for (const s of ["Secret Voice Memo", "2026-10-01", "JFIF-with-GPS", "ilst", "©nam"]) expect(contains(out, s)).toBe(false);
    expect(out.subarray(at, at + audio.length)).toEqual(audio);
    expect(find(out, ["moov", "trak", "mdia", "hdlr"])).toBeTruthy();
  });

  it("follows a 64-bit mdat and co64 offsets", async () => {
    const ftyp = box("ftyp", str("qt  "), be(0, 4), str("qt  "));
    const build = (at: number) => box("moov", mvhd(), trak("vide", [VIDEO.length], at, true), box("udta", box("©xyz", str(LOCATION))));
    const at = ftyp.length + build(0).length + 16;
    const file = cat(ftyp, build(at), largeBox("mdat", VIDEO));
    const out = await run(file);
    expect(out.length).toBe(file.length);
    expect(contains(out, LOCATION)).toBe(false);
    expect(out.subarray(at, at + VIDEO.length)).toEqual(VIDEO);
  });

  it("accepts a QuickTime file that opens with moov, no ftyp", async () => {
    const build = (at: number) => box("moov", mvhd(), trak("vide", [VIDEO.length], at), box("udta", box("©xyz", str(LOCATION))));
    const at = build(0).length + 8;
    const out = await run(cat(build(at), box("mdat", VIDEO)));
    expect(contains(out, LOCATION)).toBe(false);
    expect(out.subarray(at, at + VIDEO.length)).toEqual(VIDEO);
  });

  it("refuses a box whose size runs past the end of the file", async () => {
    const { file } = phoneMp4();
    const truncated = file.subarray(0, file.length - 20);
    expect(await refused(truncated)).toBeInstanceOf(MetadataStripError);
  });

  it("refuses a file without moov", async () => {
    const file = cat(box("ftyp", str("isom"), be(0, 4)), box("mdat", VIDEO));
    expect(await refused(file)).toBeInstanceOf(MetadataStripError);
  });

  it("refuses a fragmented file with a non-audio/video track it cannot follow", async () => {
    const file = cat(
      box("ftyp", str("iso6"), be(0, 4)),
      box("moov", mvhd(), trak("vide", [], 0), trak("meta", [], 0)),
      box("moof", box("mfhd", be(0, 4), be(1, 4))),
      box("mdat", GPS),
    );
    expect(await refused(file)).toBeInstanceOf(MetadataStripError);
  });

  it("refuses a dropped track whose samples point outside mdat", async () => {
    const ftyp = box("ftyp", str("isom"), be(0, 4));
    const file = cat(ftyp, box("moov", mvhd(), trak("meta", [8], 0)), box("mdat", GPS));
    expect(await refused(file)).toBeInstanceOf(MetadataStripError);
  });
});

describe("stripMediaMetadata: MP3", () => {
  const frame = cat(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), str("MPEG-AUDIO-PAYLOAD"));

  function id3v2(text: string, footer = false): Uint8Array {
    const frameBody = cat(new Uint8Array([0]), str(text));
    const tit2 = cat(str("TIT2"), be(frameBody.length, 4), new Uint8Array(2), frameBody);
    const n = tit2.length;
    const size = new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
    const head = cat(str("ID3"), new Uint8Array([footer ? 4 : 3, 0, footer ? 0x10 : 0]), size);
    return footer ? cat(head, tit2, str("3DI"), new Uint8Array([4, 0, 0x10]), size) : cat(head, tit2);
  }
  const id3v1 = cat(str("TAG"), str("Secret v1 title".padEnd(30, "\0")), new Uint8Array(95));
  function ape(): Uint8Array {
    const item = cat(le32(6), le32(0), str("Title\0"), str("Secret"));
    const footer = (flags: number) => cat(str("APETAGEX"), le32(2000), le32(item.length + 32), le32(1), le32(flags), new Uint8Array(8));
    return cat(footer(0xa0000000), item, footer(0x80000000));
  }

  it("drops stacked ID3v2 tags in front and APE + ID3v1 behind, keeping the frames", async () => {
    const file = cat(id3v2("Secret Title"), id3v2("Recorded at home", true), frame, frame, ape(), id3v1);
    const out = await run(file, "audio/mpeg");
    expect(out).toEqual(cat(frame, frame));
  });

  it("tolerates zero padding after the ID3v2 tag", async () => {
    const out = await run(cat(id3v2("Secret"), new Uint8Array(100), frame));
    expect(out).toEqual(frame);
  });

  it("passes an untagged MP3 through unchanged", async () => {
    const file = cat(frame, frame);
    expect(await run(file)).toEqual(file);
  });

  it("refuses a file whose ID3 tag is not followed by an MPEG frame", async () => {
    expect(await refused(cat(id3v2("Secret"), str("OggS-not-mpeg-at-all")))).toBeInstanceOf(MetadataStripError);
  });
});

describe("stripMediaMetadata: WebM / Matroska", () => {
  it("voids Tags, Attachments and the identifying Info/track fields at identical size", async () => {
    const file = taggedWebm();
    for (const s of ["Secret Tag", "SecretMuxer", "SecretWriter", "Secret Title", "Secret Track", "Secret cover"])
      expect(contains(file, s)).toBe(true);
    const out = await run(file, "video/webm");
    expect(out.length).toBe(file.length);
    expect(contains(out, "Secret")).toBe(false);
    expect(contains(out, be(0x0a0b0c0d0e0f, 6))).toBe(false); // DateUTC
    expect(contains(out, new Uint8Array(ID.Tags))).toBe(false); // element AND its Seek entry
    // Media and structure kept, at the same offsets.
    expect(indexOf(out, "FRAMEDATA-ONE")).toBe(indexOf(file, "FRAMEDATA-ONE"));
    expect(indexOf(out, "FRAMEDATA-TWO")).toBe(indexOf(file, "FRAMEDATA-TWO"));
    expect(contains(out, "V_VP8")).toBe(true);
    expect(contains(out, "webm")).toBe(true);

    // The output still parses into the same element spans.
    const header = ebmlAt(out, 0);
    const segment = ebmlAt(out, header.end!);
    expect(segment.end).toBeNull();
    const seekHead = ebmlAt(out, segment.dataStart);
    const info = ebmlAt(out, seekHead.end!);
    const tracks = ebmlAt(out, info.end!);
    expect([seekHead.id, info.id, tracks.id]).toEqual([0x114d9b74, 0x1549a966, 0x1654ae6b]);
    // SeekHead: the Info entry stays, the Tags entry is a Void.
    expect(children(out, seekHead.dataStart, seekHead.end!).map((c) => c.id)).toEqual([0x4dbb, VOID]);
    // Info: only TimestampScale survives; the CRC-32 (now stale) is voided too.
    expect(children(out, info.dataStart, info.end!).map((c) => c.id)).toEqual([VOID, 0x2ad7b1, VOID, VOID, VOID, VOID]);
    const entry = children(out, tracks.dataStart, tracks.end!)[0]!;
    expect(children(out, entry.dataStart, entry.end!).map((c) => c.id)).toEqual([0xd7, VOID, 0x86]);

    // After the unknown-size cluster: Tags (2-byte size) and Attachments are Voids
    // spanning exactly the original bytes.
    const tagsAt = indexOf(file, "FRAMEDATA-TWO") + "FRAMEDATA-TWO".length;
    const voidTags = ebmlAt(out, tagsAt);
    const origTags = ebmlAt(file, tagsAt);
    expect(voidTags.id).toBe(VOID);
    expect(voidTags.end).toBe(origTags.end);
    const voidAtt = ebmlAt(out, voidTags.end!);
    expect(voidAtt.id).toBe(VOID);
    expect(voidAtt.end).toBe(out.length);
  });

  it("refuses a Matroska file whose element runs past the end", async () => {
    const header = el(ID.EBML, el(ID.DocType, str("webm")));
    const segment = el(ID.Segment, el(ID.Info, el(ID.Title, str("Secret"))));
    const broken = cat(header, segment.subarray(0, segment.length - 3));
    expect(await refused(broken)).toBeInstanceOf(MetadataStripError);
  });
});

describe("stripMediaMetadata: FLAC and WAV", () => {
  it("turns FLAC Vorbis comments and pictures into padding of the same size", async () => {
    const streaminfo = cat(new Uint8Array([0x00]), be(34, 3), new Uint8Array(34).fill(7));
    const comment = str("\u0000\u0000\u0000\u0000TITLE=Secret");
    const vorbis = cat(new Uint8Array([0x04]), be(comment.length, 3), comment);
    const picture = str("PNG-Secret-cover");
    const pic = cat(new Uint8Array([0x86]), be(picture.length, 3), picture); // last block
    const frames = cat(new Uint8Array([0xff, 0xf8]), str("FLAC-FRAMES"));
    const file = cat(str("fLaC"), streaminfo, vorbis, pic, frames);
    const out = await run(file, "audio/flac");
    expect(out.length).toBe(file.length);
    expect(contains(out, "Secret")).toBe(false);
    expect(out.subarray(0, 4 + streaminfo.length)).toEqual(file.subarray(0, 4 + streaminfo.length));
    expect(out[4 + streaminfo.length]).toBe(0x01); // PADDING, not last
    expect(out[4 + streaminfo.length + vorbis.length]).toBe(0x81); // PADDING, last
    expect(out.subarray(out.length - frames.length)).toEqual(frames);
  });

  it("turns WAV LIST/INFO and bext chunks into JUNK of the same size", async () => {
    const chunk = (id: string, body: Uint8Array) => cat(str(id), le32(body.length), body, body.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
    const fmt = chunk("fmt ", new Uint8Array(16).fill(1));
    const list = chunk("LIST", cat(str("INFO"), chunk("INAM", str("Secret name\0"))));
    const bext = chunk("bext", str("Secret originator 2026-10-01"));
    const data = chunk("data", str("PCM-SAMPLES!"));
    const body = cat(str("WAVE"), fmt, list, bext, data);
    const file = cat(str("RIFF"), le32(body.length), body);
    const out = await run(file, "audio/wav");
    expect(out.length).toBe(file.length);
    expect(contains(out, "Secret")).toBe(false);
    expect(contains(out, "INFO")).toBe(false);
    expect(indexOf(out, "PCM-SAMPLES!")).toBe(indexOf(file, "PCM-SAMPLES!"));
    expect(indexOf(out, "JUNK")).toBe(12 + fmt.length);
  });
});

describe("stripMediaMetadata: refusal (same policy as Android)", () => {
  it("refuses containers it cannot strip", async () => {
    const ogg = cat(str("OggS"), new Uint8Array(60));
    expect(await refused(ogg)).toBeInstanceOf(MetadataStripError);
    expect(await refused(str("just some text pretending to be media"))).toBeInstanceOf(MetadataStripError);
    expect(await refused(new Uint8Array(4))).toBeInstanceOf(MetadataStripError);
  });

  it("sniffs by content, not by name or declared MIME", () => {
    expect(sniffContainer(box("ftyp", str("isom")))).toBe("isobmff");
    expect(sniffContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe("matroska");
    expect(sniffContainer(str("ID3\u0004"))).toBe("mp3");
    expect(sniffContainer(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe("mp3");
    expect(sniffContainer(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBe("mp3"); // ADTS AAC
    expect(sniffContainer(str("fLaC"))).toBe("flac");
    expect(sniffContainer(cat(str("RIFF"), le32(4), str("WAVE")))).toBe("wav");
    expect(sniffContainer(cat(str("RIFF"), le32(4), str("AVI ")))).toBeNull();
    expect(sniffContainer(str("OggS"))).toBeNull();
    expect(sniffContainer(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull(); // JPEG
  });
});

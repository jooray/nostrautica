/**
 * Strip hidden metadata from an audio/video file the user PICKED for upload
 * (intro or talk), the web counterpart of the Android app's re-mux
 * (`VideoShrink.strip`, audit R-22). A phone video carries where it was shot
 * (`©xyz`, Apple `mdta` location keys), the device make/model and software, the
 * creation date; an m4a/mp3 its tags and cover art. All of that used to ride
 * along, encrypted but intact, to every attendee who can open the intro.
 *
 * No re-encode and no ffmpeg.wasm: each container is rewritten in place, and
 * almost always without moving a single byte, because ISO-BMFF sample tables
 * (`stco`/`co64`) and Matroska `SeekHead`/`Cues` hold absolute offsets. A
 * metadata box/element is overwritten with a skip-me box of the SAME size
 * (`free` / EBML `Void` / RIFF `JUNK` / FLAC `PADDING`) and its payload zeroed,
 * so the file length and every offset stay valid. Only MP3's ID3/APE tags,
 * which sit at the very ends of the stream, are cut off instead.
 *
 * The output is assembled from `Blob` slices of the original plus the few
 * patched regions, so a large file is never read into memory a second time:
 * only the box headers, ISO-BMFF `moov` and Matroska `Info`/`Tracks`/`SeekHead`
 * are actually read.
 *
 * Failure policy (same as Android): anything not recognised, or anything that
 * does not parse cleanly, throws {@link MetadataStripError}. The caller must then
 * refuse the file rather than upload the original bytes.
 *
 * Not run on in-app MediaRecorder takes: they carry no location, and a
 * MediaRecorder WebM's unknown-size clusters would make the walk read every block
 * header of the take for nothing.
 */

/** Why a file could not be stripped. The message is for logs, not for the UI. */
export class MetadataStripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataStripError";
  }
}

export type MediaContainer = "isobmff" | "matroska" | "mp3" | "flac" | "wav";

function fail(why: string): never {
  throw new MetadataStripError(why);
}

// ---------------------------------------------------------------------------
// Shared plumbing: reads, edits, assembly
// ---------------------------------------------------------------------------

/** A byte range of the original to replace: with `bytes`, or with `zeros` zero bytes. */
type Edit = { at: number; bytes: Uint8Array } | { at: number; zeros: number };

async function readAt(file: Blob, start: number, len: number): Promise<Uint8Array> {
  if (start < 0 || len < 0 || start + len > file.size) fail("read past end of file");
  const out = new Uint8Array(await file.slice(start, start + len).arrayBuffer());
  if (out.length !== len) fail("short read");
  return out;
}

function editLen(e: Edit): number {
  return "bytes" in e ? e.bytes.length : e.zeros;
}

const ZERO_CHUNK = new Uint8Array(64 * 1024);

/**
 * Build the output from the original's slices with `edits` laid over it. The
 * length never changes: an edit replaces exactly as many bytes as it covers.
 * Overlapping zero runs (two references to the same bytes) are merged; any other
 * overlap means the parse went wrong, and is refused.
 */
function assemble(file: Blob, edits: Edit[], start = 0, end = file.size): Blob {
  const sorted = edits.filter((e) => editLen(e) > 0).sort((a, b) => a.at - b.at);
  const merged: Edit[] = [];
  for (const e of sorted) {
    if (e.at < start || e.at + editLen(e) > end) fail("edit outside the file");
    const prev = merged[merged.length - 1];
    if (prev && e.at < prev.at + editLen(prev)) {
      if ("zeros" in prev && "zeros" in e) {
        prev.zeros = Math.max(prev.zeros, e.at + e.zeros - prev.at);
        continue;
      }
      fail("overlapping edits");
    }
    merged.push("zeros" in e ? { ...e } : e);
  }
  const parts: BlobPart[] = [];
  let pos = start;
  for (const e of merged) {
    if (e.at > pos) parts.push(file.slice(pos, e.at));
    if ("bytes" in e) parts.push(e.bytes as Uint8Array<ArrayBuffer>);
    else {
      let n = e.zeros;
      while (n > 0) {
        const k = Math.min(n, ZERO_CHUNK.length);
        parts.push(k === ZERO_CHUNK.length ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, k));
        n -= k;
      }
    }
    pos = e.at + editLen(e);
  }
  if (end > pos) parts.push(file.slice(pos, end));
  return new Blob(parts, { type: file.type });
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[at + i] ?? 0);
  return s;
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

function u64be(b: Uint8Array, at: number): number {
  const v = u32be(b, at) * 2 ** 32 + u32be(b, at + 4);
  if (!Number.isSafeInteger(v)) fail("64-bit size out of range");
  return v;
}

function u32le(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Which container `head` (the first bytes of a file) starts, or null. */
export function sniffContainer(head: Uint8Array): MediaContainer | null {
  if (head.length >= 4 && u32be(head, 0) === 0x1a45dfa3) return "matroska";
  if (ascii(head, 0, 4) === "fLaC") return "flac";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return "wav";
  if (ascii(head, 0, 3) === "ID3") return "mp3"; // re-sniffed after the tag (FLAC can carry one)
  if (head.length >= 8 && ISO_FIRST_BOXES.has(ascii(head, 4, 4))) return "isobmff";
  if (head.length >= 4 && isAudioFrameSync(head, 0)) return "mp3";
  return null;
}

/**
 * Return a copy of `file` with its hidden metadata removed, or throw
 * {@link MetadataStripError} when that cannot be done safely.
 */
export async function stripMediaMetadata(file: Blob): Promise<Blob> {
  if (file.size < 12) fail("file too small to be media");
  const head = await readAt(file, 0, Math.min(file.size, 64));
  switch (sniffContainer(head)) {
    case "isobmff":
      return stripIsoBmff(file);
    case "matroska":
      return stripMatroska(file);
    case "mp3":
      return stripMp3(file);
    case "flac":
      return stripFlac(file, 0, file.size);
    case "wav":
      return stripWav(file);
    default:
      return fail("unrecognised container");
  }
}

// ---------------------------------------------------------------------------
// ISO-BMFF: mp4 / m4a / mov / 3gp
// ---------------------------------------------------------------------------

/** Box types a real file can open with (QuickTime .mov may lack `ftyp`). */
const ISO_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "uuid", "styp"]);

/** Wherever these appear (top level or inside moov/trak/mdia), they go entirely. */
const ISO_META_BOXES = new Set(["udta", "meta", "uuid"]);

/** Top-level boxes neutralised on top of the above: producer wall-clock (`prft`)
 * and the padding boxes, which editors leave stale copies of old metadata in. */
const ISO_TOP_EXTRA = new Set(["prft", "free", "skip", "wide"]);

/** Track handlers kept. A timed-metadata track (GoPro GPMF GPS, Apple `mebx`
 * location), subtitles (DJI's per-frame GPS) or timecode go, as on Android, where
 * only the audio and video tracks are re-muxed. */
const ISO_AV_HANDLERS = new Set(["vide", "soun"]);

/** The cap on the in-memory `moov`: a long phone video's is a few MB. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

interface Box {
  type: string;
  start: number;
  /** 8, or 16 with a 64-bit largesize. A `uuid`'s usertype counts as payload. */
  headerLen: number;
  end: number;
}

/** Parse the box header at `at` in `b` (whose byte 0 sits at file offset `base`). */
function parseBox(b: Uint8Array, at: number, limit: number, base = 0): Box {
  if (at + 8 > limit) fail("truncated box header");
  const size32 = u32be(b, at);
  const type = ascii(b, at + 4, 4);
  let headerLen = 8;
  let size: number;
  if (size32 === 1) {
    if (at + 16 > limit) fail("truncated largesize");
    size = u64be(b, at + 8);
    headerLen = 16;
  } else if (size32 === 0) {
    size = limit - at; // extends to the end of its parent (the file, at top level)
  } else size = size32;
  if (size < headerLen || at + size > limit) fail(`bad size for box '${type}'`);
  return { type, start: base + at, headerLen, end: base + at + size };
}

function* isoChildren(b: Uint8Array, from: number, to: number): Generator<Box> {
  let at = from;
  while (at < to) {
    // A 4-byte zero terminator is legal at the end of some QuickTime containers.
    if (to - at < 8) {
      if (to - at === 4 && u32be(b, at) === 0) return;
      fail("trailing bytes in box");
    }
    const box = parseBox(b, at, to);
    yield box;
    at = box.end;
  }
}

/** Neutralise a box held in memory: type `free`, payload zeroed, size kept. */
function freeBoxInPlace(b: Uint8Array, box: Box): void {
  b.set([0x66, 0x72, 0x65, 0x65], box.start + 4); // "free"
  b.fill(0, box.start + box.headerLen, box.end);
}

/** Zero the creation/modification times of an mvhd/tkhd/mdhd full box. */
function zeroTimes(b: Uint8Array, box: Box): void {
  const p = box.start + box.headerLen;
  if (p + 4 > box.end) fail(`truncated '${box.type}'`);
  const version = b[p]!;
  const len = version === 1 ? 16 : version === 0 ? 8 : fail(`unknown '${box.type}' version`);
  if (p + 4 + len > box.end) fail(`truncated '${box.type}'`);
  b.fill(0, p + 4, p + 4 + len);
}

function findChild(b: Uint8Array, parent: Box, type: string): Box | undefined {
  for (const c of isoChildren(b, parent.start + parent.headerLen, parent.end)) if (c.type === type) return c;
  return undefined;
}

function trackHandler(b: Uint8Array, trak: Box): string {
  const mdia = findChild(b, trak, "mdia") ?? fail("track without mdia");
  const hdlr = findChild(b, mdia, "hdlr") ?? fail("track without hdlr");
  const p = hdlr.start + hdlr.headerLen;
  if (p + 12 > hdlr.end) fail("truncated hdlr");
  return ascii(b, p + 8, 4);
}

/** Absolute file ranges holding a track's samples, from its sample tables. */
function trackSampleRanges(b: Uint8Array, trak: Box): Array<[number, number]> {
  const mdia = findChild(b, trak, "mdia")!;
  const minf = findChild(b, mdia, "minf") ?? fail("track without minf");
  const stbl = findChild(b, minf, "stbl") ?? fail("track without stbl");
  let sizes: ((i: number) => number) | null = null;
  let sampleCount = 0;
  let offsets: number[] | null = null;
  const stsc: Array<[number, number]> = [];
  for (const c of isoChildren(b, stbl.start + stbl.headerLen, stbl.end)) {
    const p = c.start + c.headerLen + 4; // past version/flags
    const need = (n: number) => {
      if (p + n > c.end) fail(`truncated '${c.type}'`);
    };
    if (c.type === "stsz") {
      need(8);
      const fixed = u32be(b, p);
      sampleCount = u32be(b, p + 4);
      if (fixed === 0) need(8 + sampleCount * 4);
      sizes = fixed !== 0 ? () => fixed : (i) => u32be(b, p + 8 + i * 4);
    } else if (c.type === "stz2") {
      need(8);
      const field = b[p + 3]!;
      sampleCount = u32be(b, p + 4);
      if (field !== 4 && field !== 8 && field !== 16) fail("bad stz2 field size");
      need(8 + Math.ceil((sampleCount * field) / 8));
      const q = p + 8;
      sizes =
        field === 16
          ? (i) => (b[q + i * 2]! << 8) | b[q + i * 2 + 1]!
          : field === 8
            ? (i) => b[q + i]!
            : (i) => (i % 2 === 0 ? b[q + (i >> 1)]! >> 4 : b[q + (i >> 1)]! & 0x0f);
    } else if (c.type === "stco" || c.type === "co64") {
      need(4);
      const n = u32be(b, p);
      const w = c.type === "co64" ? 8 : 4;
      need(4 + n * w);
      offsets = [];
      for (let i = 0; i < n; i++) offsets.push(w === 8 ? u64be(b, p + 4 + i * 8) : u32be(b, p + 4 + i * 4));
    } else if (c.type === "stsc") {
      need(4);
      const n = u32be(b, p);
      need(4 + n * 12);
      for (let i = 0; i < n; i++) stsc.push([u32be(b, p + 4 + i * 12), u32be(b, p + 8 + i * 12)]);
    }
  }
  if (sampleCount === 0) return [];
  if (!sizes || !offsets || stsc.length === 0) fail("incomplete sample tables");
  const ranges: Array<[number, number]> = [];
  let sample = 0;
  let entry = 0;
  for (let chunk = 1; chunk <= offsets.length && sample < sampleCount; chunk++) {
    while (entry + 1 < stsc.length && stsc[entry + 1]![0] <= chunk) entry++;
    const perChunk = stsc[entry]![1];
    let len = 0;
    for (let k = 0; k < perChunk && sample < sampleCount; k++) len += sizes(sample++);
    const off = offsets[chunk - 1]!;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === off) last[1] = off + len;
    else if (len > 0) ranges.push([off, off + len]);
  }
  if (sample !== sampleCount) fail("sample tables disagree");
  return ranges;
}

/**
 * Strip a `moov` held in memory (mutated in place). Returns the file ranges of
 * dropped tracks' samples, which the caller zeroes inside `mdat`.
 */
function stripMoov(b: Uint8Array, moov: Box, fragmented: boolean): Array<[number, number]> {
  const zero: Array<[number, number]> = [];
  const walk = (parent: Box) => {
    for (const c of isoChildren(b, parent.start + parent.headerLen, parent.end)) {
      if (ISO_META_BOXES.has(c.type)) freeBoxInPlace(b, c);
      else if (c.type === "mvhd" || c.type === "tkhd" || c.type === "mdhd") zeroTimes(b, c);
      else if (c.type === "trak") {
        if (!ISO_AV_HANDLERS.has(trackHandler(b, c))) {
          // Its samples live in mdat (or, fragmented, in moof/trun runs this
          // does not follow): zero them, or refuse.
          if (fragmented) fail("non-audio/video track in a fragmented file");
          zero.push(...trackSampleRanges(b, c));
          freeBoxInPlace(b, c);
        } else walk(c);
      } else if (c.type === "mdia" || c.type === "minf" || c.type === "edts" || c.type === "mvex") walk(c);
    }
  };
  walk(moov);
  return zero;
}

async function stripIsoBmff(file: Blob): Promise<Blob> {
  const size = file.size;
  const edits: Edit[] = [];
  const mdats: Array<[number, number]> = [];
  let moov: Box | null = null;
  let fragmented = false;
  let at = 0;
  while (at < size) {
    const head = await readAt(file, at, Math.min(16, size - at));
    const box = parseBox(head, 0, size - at, at);
    if (box.type === "moov") {
      if (moov) fail("two moov boxes");
      moov = box;
    } else if (box.type === "mdat") mdats.push([box.start + box.headerLen, box.end]);
    else if (box.type === "moof") fragmented = true;
    else if (ISO_META_BOXES.has(box.type) || ISO_TOP_EXTRA.has(box.type)) {
      const header = head.slice(0, box.headerLen);
      header.set([0x66, 0x72, 0x65, 0x65], 4);
      edits.push({ at: box.start, bytes: header });
      edits.push({ at: box.start + box.headerLen, zeros: box.end - box.start - box.headerLen });
    }
    at = box.end;
  }
  if (!moov) fail("no moov box");
  const moovLen = moov.end - moov.start;
  if (moovLen > MAX_MOOV_BYTES) fail("moov too large");
  const buf = await readAt(file, moov.start, moovLen);
  const local: Box = { ...moov, start: 0, end: moovLen };
  const dropped = stripMoov(buf, local, fragmented);
  edits.push({ at: moov.start, bytes: buf });
  for (const [s, e] of dropped) {
    if (!mdats.some(([ms, me]) => s >= ms && e <= me)) fail("track samples outside mdat");
    edits.push({ at: s, zeros: e - s });
  }
  return assemble(file, edits);
}

// ---------------------------------------------------------------------------
// Matroska / WebM
// ---------------------------------------------------------------------------

const MKV = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  Info: 0x1549a966,
  DateUTC: 0x4461,
  Title: 0x7ba9,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Name: 0x536e,
  Cluster: 0x1f43b675,
  Tags: 0x1254c367,
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
  Void: 0xec,
  CRC32: 0xbf,
} as const;

/** Segment children voided whole: tags, attached files (cover art with its own
 * EXIF), and chapters (titles). */
const MKV_DROP = new Set<number>([MKV.Tags, MKV.Attachments, MKV.Chapters]);

/** Cluster children: an unknown-size cluster ends at the first ID not in here. */
const MKV_CLUSTER_CHILDREN = new Set<number>([0xe7, 0x5854, 0xa7, 0xab, 0xa0, 0xa3, 0xaf, MKV.Void, MKV.CRC32]);

/** The cap on a Segment child read into memory (Info, Tracks, SeekHead). */
const MAX_MKV_MASTER_BYTES = 16 * 1024 * 1024;

interface Ebml {
  id: number;
  start: number;
  dataStart: number;
  /** null = unknown size (live-streamed, e.g. MediaRecorder output). */
  size: number | null;
}

/** Windowed reads, so walking element headers is not one Blob read per header. */
class WindowReader {
  readonly file: Blob;
  private readonly winSize = 64 * 1024;
  private winStart = 0;
  private win: Uint8Array = new Uint8Array(0);
  constructor(file: Blob) {
    this.file = file;
  }
  async bytes(pos: number, n: number): Promise<Uint8Array> {
    if (pos < this.winStart || pos + n > this.winStart + this.win.length) {
      const len = Math.min(Math.max(n, this.winSize), this.file.size - pos);
      if (len < n) fail("truncated element");
      this.win = await readAt(this.file, pos, len);
      this.winStart = pos;
    }
    return this.win.subarray(pos - this.winStart, pos - this.winStart + n);
  }
}

/** Element header from bytes (`b[at]` is file offset `base + at`). */
function parseEbml(b: Uint8Array, at: number, limit: number, base = 0): Ebml {
  if (at >= limit) fail("truncated element");
  const first = b[at]!;
  const idLen = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
  if (idLen === 0) fail("bad element ID");
  if (at + idLen >= limit) fail("truncated element");
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[at + i]!;
  const s = at + idLen;
  const lead = b[s]!;
  let sizeLen = 1;
  while (sizeLen <= 8 && !(lead & (0x80 >> (sizeLen - 1)))) sizeLen++;
  if (sizeLen > 8) fail("bad element size");
  if (s + sizeLen > limit) fail("truncated element");
  let value = lead & (0xff >> sizeLen);
  let allOnes = value === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const byte = b[s + i]!;
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  if (!allOnes && !Number.isSafeInteger(value)) fail("element size out of range");
  return { id, start: base + at, dataStart: base + s + sizeLen, size: allOnes ? null : value };
}

async function readEbml(r: WindowReader, pos: number, limit: number): Promise<Ebml> {
  const n = Math.min(12, limit - pos);
  if (n < 2) fail("truncated element");
  return parseEbml(await r.bytes(pos, n), 0, n, pos);
}

function ebmlEnd(e: Ebml, limit: number): number {
  if (e.size === null) fail("unknown-size element where a size is required");
  const end = e.dataStart + e.size;
  if (end > limit) fail("element runs past its parent");
  return end;
}

/** A Void element header totalling exactly `total` bytes once `total - header`
 * zero bytes follow it (ID 0xEC, then a size vint of a fitting width). */
function voidHeader(total: number): Uint8Array {
  for (let w = 1; w <= 8; w++) {
    const v = total - 1 - w;
    if (v >= 0 && v <= 2 ** (7 * w) - 2) {
      const h = new Uint8Array(1 + w);
      h[0] = MKV.Void;
      let rest = v;
      for (let i = w; i >= 1; i--) {
        h[i] = rest % 256;
        rest = Math.floor(rest / 256);
      }
      h[1]! |= 0x80 >> (w - 1);
      return h;
    }
  }
  return fail("element too small to void");
}

function voidInPlace(b: Uint8Array, start: number, end: number): void {
  const h = voidHeader(end - start);
  b.set(h, start);
  b.fill(0, start + h.length, end);
}

/**
 * Void the children of the master element spanning `b[from, to)` whose ID is in
 * `drop` (and recurse into those in `into`). When anything changed, the master's
 * own CRC-32 child no longer matches, so it is voided too. Returns whether
 * anything changed (which invalidates the parent's CRC as well).
 */
function voidChildren(
  b: Uint8Array,
  from: number,
  to: number,
  drop: (child: Ebml, end: number) => boolean,
  into: Set<number> = new Set(),
): boolean {
  let changed = false;
  const crcs: Array<[number, number]> = [];
  let at = from;
  while (at < to) {
    const c = parseEbml(b, at, to);
    if (c.size === null) fail("unknown-size child");
    const end = c.dataStart + c.size;
    if (end > to) fail("child runs past its parent");
    if (c.id === MKV.CRC32) crcs.push([c.start, end]);
    else if (drop(c, end)) {
      voidInPlace(b, c.start, end);
      changed = true;
    } else if (into.has(c.id) && voidChildren(b, c.dataStart, end, drop, into)) changed = true;
    at = end;
  }
  if (changed) for (const [s, e] of crcs) voidInPlace(b, s, e);
  return changed;
}

/** The SeekID a Seek entry spanning `b[from, to)` points at (0 when absent). */
function seekTarget(b: Uint8Array, from: number, to: number): number {
  let at = from;
  while (at < to) {
    const g = parseEbml(b, at, to);
    if (g.size === null || g.dataStart + g.size > to) fail("bad Seek entry");
    const end = g.dataStart + g.size;
    if (g.id === MKV.SeekID) {
      if (g.size > 4) fail("bad SeekID");
      let id = 0;
      for (let i = g.dataStart; i < end; i++) id = id * 256 + b[i]!;
      return id;
    }
    at = end;
  }
  return 0;
}

/** Strip a small Segment child (Info / Tracks / SeekHead) read into memory. */
async function stripMkvMaster(r: WindowReader, el: Ebml, end: number, edits: Edit[]): Promise<void> {
  const len = end - el.start;
  if (len > MAX_MKV_MASTER_BYTES) fail("metadata element too large");
  const buf = await readAt(r.file, el.start, len);
  const from = el.dataStart - el.start;
  let changed = false;
  if (el.id === MKV.Info) {
    const ids = new Set<number>([MKV.DateUTC, MKV.Title, MKV.MuxingApp, MKV.WritingApp]);
    changed = voidChildren(buf, from, len, (c) => ids.has(c.id));
  } else if (el.id === MKV.Tracks) {
    changed = voidChildren(buf, from, len, (c) => c.id === MKV.Name, new Set([MKV.TrackEntry]));
  } else if (el.id === MKV.SeekHead) {
    // Seek entries pointing at what is voided would now point at a Void.
    changed = voidChildren(
      buf,
      from,
      len,
      (c, cEnd) => c.id === MKV.Seek && MKV_DROP.has(seekTarget(buf, c.dataStart, cEnd)),
    );
  }
  if (changed) edits.push({ at: el.start, bytes: buf });
}

async function stripMatroska(file: Blob): Promise<Blob> {
  const r = new WindowReader(file);
  const size = file.size;
  const header = await readEbml(r, 0, size);
  if (header.id !== MKV.EBML) fail("no EBML header");
  let at = ebmlEnd(header, size);
  const edits: Edit[] = [];
  let segments = 0;
  while (at < size) {
    const top = await readEbml(r, at, size);
    if (top.id === MKV.Void) {
      at = ebmlEnd(top, size);
      continue;
    }
    if (top.id !== MKV.Segment) fail("unexpected top-level element");
    segments++;
    const segEnd = top.size === null ? size : ebmlEnd(top, size);
    let pos = top.dataStart;
    while (pos < segEnd) {
      const el = await readEbml(r, pos, segEnd);
      if (el.size === null) {
        // Only a live-streamed Cluster may have an unknown size: it ends where
        // the next non-cluster-child element starts.
        if (el.id !== MKV.Cluster) fail("unknown-size element other than a Cluster");
        pos = el.dataStart;
        while (pos < segEnd) {
          const c = await readEbml(r, pos, segEnd);
          if (!MKV_CLUSTER_CHILDREN.has(c.id)) break;
          pos = ebmlEnd(c, segEnd);
        }
        continue;
      }
      const end = ebmlEnd(el, segEnd);
      if (MKV_DROP.has(el.id)) {
        const h = voidHeader(end - el.start);
        edits.push({ at: el.start, bytes: h });
        edits.push({ at: el.start + h.length, zeros: end - el.start - h.length });
      } else if (el.id === MKV.Info || el.id === MKV.Tracks || el.id === MKV.SeekHead) {
        await stripMkvMaster(r, el, end, edits);
      }
      pos = end;
    }
    at = segEnd;
  }
  if (segments !== 1) fail("expected exactly one Segment");
  return assemble(file, edits);
}

// ---------------------------------------------------------------------------
// MP3 (and ADTS AAC): ID3v2 at the front, ID3v1 / APE / Lyrics3 at the back
// ---------------------------------------------------------------------------

/** An MPEG audio frame header (or an ADTS AAC one) starts at `b[at]`. */
function isAudioFrameSync(b: Uint8Array, at: number): boolean {
  const b0 = b[at];
  const b1 = b[at + 1];
  const b2 = b[at + 2];
  if (b0 !== 0xff || b1 === undefined || b2 === undefined || (b1 & 0xe0) !== 0xe0) return false;
  if ((b1 & 0xf6) === 0xf0) return true; // ADTS: MPEG-4/2 AAC, layer bits 00
  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  const bitrate = b2 >> 4;
  const rate = (b2 >> 2) & 3;
  return version !== 1 && layer !== 0 && bitrate !== 0xf && rate !== 3;
}

function syncsafe(b: Uint8Array, at: number): number {
  if ((b[at]! | b[at + 1]! | b[at + 2]! | b[at + 3]!) & 0x80) fail("bad ID3 size");
  return (b[at]! << 21) | (b[at + 1]! << 14) | (b[at + 2]! << 7) | b[at + 3]!;
}

async function stripMp3(file: Blob): Promise<Blob> {
  let start = 0;
  // Leading ID3v2 tag(s): some taggers stack more than one.
  for (;;) {
    if (file.size - start < 10) fail("truncated ID3 tag");
    const h = await readAt(file, start, 10);
    if (ascii(h, 0, 3) !== "ID3") break;
    const footer = h[5]! & 0x10 ? 10 : 0;
    start += 10 + syncsafe(h, 6) + footer;
    if (start >= file.size) fail("ID3 tag covers the whole file");
  }
  // Some writers pad the tag with zeros past its declared size.
  const probe = await readAt(file, start, Math.min(64 * 1024, file.size - start));
  let skip = 0;
  while (skip < probe.length && probe[skip] === 0) skip++;
  if (ascii(probe, skip, 4) === "fLaC") return stripFlac(file, start + skip, file.size);
  if (!isAudioFrameSync(probe, skip)) fail("no MPEG audio frame after the tags");
  start += skip;

  let end = file.size;
  for (;;) {
    if (end - start >= 128) {
      const v1 = await readAt(file, end - 128, 128);
      if (ascii(v1, 0, 3) === "TAG") {
        end -= 128;
        if (end - start >= 227 && ascii(await readAt(file, end - 227, 4), 0, 4) === "TAG+") end -= 227;
        continue;
      }
    }
    if (end - start >= 32) {
      const ape = await readAt(file, end - 32, 32);
      if (ascii(ape, 0, 8) === "APETAGEX") {
        const tagSize = u32le(ape, 12); // items + footer
        const hasHeader = (u32le(ape, 20) & 0x80000000) !== 0;
        const total = tagSize + (hasHeader ? 32 : 0);
        if (tagSize < 32 || total > end - start) fail("bad APE tag size");
        end -= total;
        continue;
      }
    }
    if (end - start >= 15) {
      const ly = await readAt(file, end - 15, 15);
      if (ascii(ly, 6, 9) === "LYRICS200") {
        const n = Number(ascii(ly, 0, 6));
        if (!Number.isInteger(n) || n + 15 > end - start) fail("bad Lyrics3 size");
        end -= n + 15;
        continue;
      }
    }
    if (end - start >= 10) {
      const f = await readAt(file, end - 10, 10);
      if (ascii(f, 0, 3) === "3DI") {
        const total = 20 + syncsafe(f, 6);
        if (total > end - start) fail("bad appended ID3 tag size");
        end -= total;
        continue;
      }
    }
    break;
  }
  if (end - start < 4) fail("no audio left after the tags");
  return assemble(file, [], start, end);
}

// ---------------------------------------------------------------------------
// FLAC: keep STREAMINFO and SEEKTABLE, turn every other block into PADDING
// ---------------------------------------------------------------------------

async function stripFlac(file: Blob, start: number, end: number): Promise<Blob> {
  if (ascii(await readAt(file, start, 4), 0, 4) !== "fLaC") fail("no fLaC marker");
  const edits: Edit[] = [];
  let at = start + 4;
  for (let first = true; ; first = false) {
    if (at + 4 > end) fail("truncated FLAC metadata");
    const h = await readAt(file, at, 4);
    const last = (h[0]! & 0x80) !== 0;
    const type = h[0]! & 0x7f;
    const len = (h[1]! << 16) | (h[2]! << 8) | h[3]!;
    if (type === 127 || (first && type !== 0)) fail("bad FLAC metadata block");
    if (at + 4 + len > end) fail("FLAC metadata block runs past the end");
    if (type !== 0 && type !== 3) {
      edits.push({ at, bytes: new Uint8Array([(last ? 0x80 : 0) | 1, h[1]!, h[2]!, h[3]!]) });
      edits.push({ at: at + 4, zeros: len });
    }
    at += 4 + len;
    if (last) break;
  }
  const sync = await readAt(file, at, Math.min(2, end - at));
  if (sync[0] !== 0xff || (sync[1]! & 0xfe) !== 0xf8) fail("no FLAC frame after the metadata");
  return assemble(file, edits, start, end);
}

// ---------------------------------------------------------------------------
// WAV: keep fmt/data/fact, turn every other chunk into JUNK
// ---------------------------------------------------------------------------

const WAV_KEEP = new Set(["fmt ", "data", "fact"]);

async function stripWav(file: Blob): Promise<Blob> {
  const head = await readAt(file, 0, 12);
  const end = Math.min(file.size, 8 + u32le(head, 4));
  if (end < 12) fail("bad RIFF size");
  const edits: Edit[] = [];
  let at = 12;
  let sawData = false;
  let openData = false;
  while (at + 8 <= end) {
    const h = await readAt(file, at, 8);
    const id = ascii(h, 0, 4);
    const len = u32le(h, 4);
    if (at + 8 + len > end) {
      // A writer that never finalised may leave data's size short or open-ended.
      if (id === "data") {
        sawData = true;
        openData = true;
        break;
      }
      fail("RIFF chunk runs past the end");
    }
    if (id === "data") sawData = true;
    if (!WAV_KEEP.has(id)) {
      edits.push({ at, bytes: new Uint8Array([0x4a, 0x55, 0x4e, 0x4b]) }); // "JUNK"
      edits.push({ at: at + 8, zeros: len });
    }
    at += 8 + len + (len & 1);
  }
  if (!sawData) fail("no WAV data chunk");
  // Bytes past the RIFF's declared end are outside the file proper (an appended
  // tag, typically) and are cut, unless the data chunk itself ran open-ended.
  return assemble(file, edits, 0, openData ? file.size : end);
}

/** @module @category Core - Binary Encoding */
/**
 * The Marmot binary profile.
 *
 * Marmot-owned binary structures (app component state, app component updates, Marmot
 * extensions, and other byte strings owned by the Marmot spec) use TLS Presentation
 * Language syntax with QUIC variable-length vector prefixes. This module implements that
 * profile: fixed-width network-byte-order integers, fixed `opaque[N]` fields, QUIC
 * variable-length integer length prefixes, and length-prefixed variable vectors.
 *
 * It does not cover bytes owned by another protocol. MLS messages, KeyPackages,
 * credentials, and MLS-defined extensions use the encoding defined by MLS; Nostr event ids
 * and signatures use the Nostr canonical event serialization; transport envelopes use the
 * encoding defined by their transport document.
 *
 * @see Marmot v2 spec: `foundation/canonical-encoding.md`
 */
/** Largest value representable by a QUIC variable-length integer (`2^62 - 1`). */
export declare const MAX_VARINT = 4611686018427387903n;
/** Error thrown when bytes do not conform to the Marmot binary profile. */
export declare class BinaryDecodeError extends Error {
    constructor(message: string);
}
/**
 * Encodes a QUIC variable-length integer using the shortest prefix size that can hold the
 * value, as required for canonical Marmot encoding.
 *
 * @param value - A non-negative integer in `[0, MAX_VARINT]`.
 */
export declare function encodeVarint(value: number | bigint): Uint8Array;
/**
 * Decodes a QUIC variable-length integer at `offset`.
 *
 * Rejects non-minimal encodings: a value MUST use the shortest prefix size that can hold
 * it, so a longer prefix for the same value is invalid.
 *
 * @returns The decoded value and the number of bytes consumed.
 */
export declare function decodeVarint(data: Uint8Array, offset?: number): {
    value: bigint;
    length: number;
};
/** Number of bytes a value would occupy when encoded as a QUIC varint. */
export declare function varintSize(value: number | bigint): number;
interface OpaqueBounds {
    /** Minimum decoded byte length (inclusive). Defaults to `0`. */
    min?: number;
    /** Maximum decoded byte length (inclusive). Defaults to unbounded. */
    max?: number;
}
/**
 * Builds a byte string in the Marmot binary profile. Methods append in field order and
 * return `this` for chaining; call {@link BinaryWriter.build} to materialize the bytes.
 */
export declare class BinaryWriter {
    private chunks;
    private length;
    private push;
    /** Appends a `uint8`. */
    uint8(value: number): this;
    /** Appends a big-endian `uint16`. */
    uint16(value: number): this;
    /** Appends a big-endian `uint32`. */
    uint32(value: number): this;
    /** Appends a big-endian `uint64`. */
    uint64(value: number | bigint): this;
    /** Appends a QUIC variable-length integer. */
    varint(value: number | bigint): this;
    /** Appends raw fixed bytes with no length prefix (`opaque name[N]`). */
    bytes(value: Uint8Array): this;
    /**
     * Appends a variable-length byte string as a QUIC varint length prefix followed by the
     * bytes (`opaque name<min..max>`).
     */
    opaque(value: Uint8Array, bounds?: OpaqueBounds): this;
    /**
     * Appends a list as a QUIC varint byte-length prefix followed by the concatenated item
     * encodings (`Type items<V>`).
     */
    vector(items: Uint8Array[], bounds?: OpaqueBounds): this;
    /** Materializes the accumulated bytes. */
    build(): Uint8Array;
}
/**
 * Reads a byte string in the Marmot binary profile with a moving cursor. Read methods
 * advance the cursor and throw {@link BinaryDecodeError} on truncated or non-canonical
 * input.
 */
export declare class BinaryReader {
    private readonly data;
    private offset;
    private readonly view;
    constructor(data: Uint8Array);
    /** Bytes not yet consumed. */
    get remaining(): number;
    /** Current cursor position. */
    get position(): number;
    /** Whether any bytes remain to be read. */
    hasMore(): boolean;
    private require;
    /** Reads a `uint8`. */
    uint8(): number;
    /** Reads a big-endian `uint16`. */
    uint16(): number;
    /** Reads a big-endian `uint32`. */
    uint32(): number;
    /** Reads a big-endian `uint64`. */
    uint64(): bigint;
    /** Reads a QUIC variable-length integer as a `bigint`. */
    varintBig(): bigint;
    /**
     * Reads a QUIC variable-length integer as a `number`. Throws if the value exceeds
     * {@link Number.MAX_SAFE_INTEGER}; use {@link BinaryReader.varintBig} for larger values.
     */
    varint(): number;
    /** Reads exactly `n` raw bytes (`opaque name[N]`). */
    bytes(n: number): Uint8Array;
    /**
     * Reads a variable-length byte string written as a QUIC varint length prefix followed by
     * the bytes (`opaque name<min..max>`). Enforces the field bounds when given.
     */
    opaque(bounds?: OpaqueBounds): Uint8Array;
    /**
     * Reads a list written as a QUIC varint byte-length prefix followed by concatenated item
     * encodings (`Type items<V>`). The body MUST decode to a whole number of items with no
     * trailing bytes.
     */
    vector<T>(readItem: (reader: BinaryReader) => T, bounds?: OpaqueBounds): T[];
    /**
     * Asserts that the cursor has consumed the entire buffer. Use this when a document says a
     * value is "decoded exactly".
     */
    end(): void;
}
/** UTF-8 encodes text. Marmot text fields are UTF-8 byte strings. */
export declare function encodeUtf8(text: string): Uint8Array;
/** UTF-8 decodes bytes without Unicode normalization. */
export declare function decodeUtf8(bytes: Uint8Array): string;
export {};

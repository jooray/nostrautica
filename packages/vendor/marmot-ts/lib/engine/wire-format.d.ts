/** @module @category Engine */
import { type ContentTypeValue, type MlsMessage } from "ts-mls";
/**
 * Marmot v2 carries MLS handshake content — Commits and Proposals — as
 * `PublicMessage`, while application messages stay `PrivateMessage`
 * (`darkmatter/spec/foundation/mls-protocol.md`, "Handshake wire format"). The
 * kind-445 transport wrap provides confidentiality, so relays never see
 * plaintext handshake bytes. The inbound pipeline therefore cannot assume a
 * single wire format when classifying or ordering framed messages; these
 * accessors read the framed fields uniformly across both carriages.
 */
/**
 * The MLS framed content type (application / proposal / commit) carried by a
 * private- or public-message {@link MlsMessage}, or `undefined` for non-framed
 * messages (welcome / key package / group info).
 */
export declare function framedContentType(message: MlsMessage): ContentTypeValue | undefined;
/**
 * The MLS epoch carried by a private- or public-message {@link MlsMessage}, or
 * `undefined` for non-framed messages. Normalizes to `bigint` regardless of how
 * each wire format models the field.
 */
export declare function framedEpoch(message: MlsMessage): bigint | undefined;

/**
 * Codec for `marmot.group.agent-text-stream.quic.v1` (`0x8006`) — the policy
 * gating the QUIC agent-text-stream transport binding.
 *
 * Wire (Marmot binary profile): a fixed 12-byte record, no length prefixes.
 *   uint8  required_member_roles;
 *   uint8  allowed_member_roles;
 *   uint32 max_plaintext_frame_len;   // big-endian
 *   uint32 replay_ttl_secs;           // big-endian
 *   uint16 padding_bucket_bytes;      // big-endian
 *
 * @see darkmatter `crates/traits/src/agent_text_stream.rs` `encode_component_state`
 */
export declare const AGENT_TEXT_STREAM_ROLE_RECEIVE = 1;
export declare const AGENT_TEXT_STREAM_ROLE_SEND = 2;
export declare const AGENT_TEXT_STREAM_ROLE_FANOUT = 4;
/**
 * MLS LeafNode extension types that advertise each agent-text-stream-QUIC member
 * role. A member advertises a role by listing the role's extension type in its
 * LeafNode capabilities (agent-text-stream-quic-v1.md "role capability"); a
 * group's `required_member_roles` mask is enforced against these on invite/join.
 * A client that does not advertise a required role capability cannot be invited
 * into the group.
 *
 * @see darkmatter `crates/traits/src/agent_text_stream.rs`
 *   (`AGENT_TEXT_STREAM_QUIC_{RECEIVE,SEND,FANOUT}_CAPABILITY`)
 */
export declare const AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE = 62161;
export declare const AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE = 62162;
export declare const AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE = 62164;
/**
 * All agent-text-stream-QUIC role capability extension types, ascending — the
 * full registered set (`registries.md`).
 *
 * Note: marmot-ts only *advertises* `receive` in its KeyPackage capabilities
 * (see {@link ensureMarmotCapabilities}), because it has no QUIC data plane and
 * `receive` is satisfiable by reading the final MLS message. This list is the
 * registry reference for all three roles, not the set marmot-ts claims.
 */
export declare const AGENT_TEXT_STREAM_QUIC_ROLE_EXTENSION_TYPES: readonly [62161, 62162, 62164];
export interface AgentTextStreamQuicPolicyV1 {
    requiredMemberRoles: number;
    allowedMemberRoles: number;
    maxPlaintextFrameLen: number;
    replayTtlSecs: number;
    paddingBucketBytes: number;
}
/** Encodes an {@link AgentTextStreamQuicPolicyV1} to its 12-byte component `data`. */
export declare function encodeAgentTextStreamQuicPolicyV1(policy: AgentTextStreamQuicPolicyV1): Uint8Array;
/** Decodes `marmot.group.agent-text-stream.quic.v1` component `data` bytes. */
export declare function decodeAgentTextStreamQuicPolicyV1(data: Uint8Array): AgentTextStreamQuicPolicyV1;

export interface GroupAvatarUrlV1 {
    /** Normalized `https` avatar URL, or `""` for an absent/cleared avatar. */
    url: string;
    /** Optional render dimension hint (e.g. `"128x128"`). */
    dim?: string;
    /** Optional thumbhash render hint. */
    thumbhash?: string;
}
/** Encodes a {@link GroupAvatarUrlV1} to its component `data` bytes. */
export declare function encodeGroupAvatarUrlV1(avatar: GroupAvatarUrlV1): Uint8Array;
/** Decodes `marmot.group.avatar-url.v1` component `data` bytes. */
export declare function decodeGroupAvatarUrlV1(data: Uint8Array): GroupAvatarUrlV1;

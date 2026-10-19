/** Complete encrypted image metadata. Keys are secret MLS-protected material. */
export interface GroupBlossomImagePresent {
    kind: "present";
    imageHash: Uint8Array;
    imageKey: Uint8Array;
    imageNonce: Uint8Array;
    imageUploadKey: Uint8Array;
    mediaType: string;
}
/** Present image or canonical five-empty-field clear state. */
export type GroupBlossomImage = GroupBlossomImagePresent | {
    kind: "empty";
};
/** Image-specific MIME normalization; does not change message-media semantics. */
export declare function canonicalizeGroupImageMediaType(value: string): string;
/**
 * Encodes the ordered five vectors in `app-components/group-blossom-image-v1.md`.
 * Producers may supply a declared MIME which is stored in canonical form.
 */
export declare function encodeGroupBlossomImage(image: GroupBlossomImage): Uint8Array;
/** Strict bounded decoding with owned fields and canonical present/empty states. */
export declare function decodeGroupBlossomImage(data: Uint8Array): GroupBlossomImage;

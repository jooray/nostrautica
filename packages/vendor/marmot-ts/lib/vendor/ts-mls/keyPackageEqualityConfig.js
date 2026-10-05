import { encode } from "./codec/tlsEncoder.js";
import { credentialEncoder } from "./credential.js";
import { constantTimeEqual } from "./util/constantTimeCompare.js";
/** @public */
export const defaultKeyPackageEqualityConfig = {
    compareKeyPackages(a, b) {
        return constantTimeEqual(a.leafNode.signaturePublicKey, b.leafNode.signaturePublicKey);
    },
    compareKeyPackageToLeafNode(a, b) {
        if (constantTimeEqual(a.leafNode.signaturePublicKey, b.signaturePublicKey))
            return true;
        return constantTimeEqual(encode(credentialEncoder, a.leafNode.credential), encode(credentialEncoder, b.credential));
    },
};

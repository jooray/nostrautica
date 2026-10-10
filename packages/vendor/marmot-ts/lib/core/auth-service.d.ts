import { AuthenticationService } from "../vendor/ts-mls/index.js";
/**
 * Marmot credential policy (`foundation/identity.md`): a `basic`
 * credential whose identity is a valid 32-byte x-only secp256k1 public key.
 * Rejecting non-curve identities here is the inbound gate that stops a peer
 * adding a member whose account identity is not a real Nostr pubkey.
 */
export declare const marmotAuthService: AuthenticationService;

import { ciphersuites, defaultCryptoProvider, } from "ts-mls";
import { createCredential } from "../core/credential.js";
import { createSimpleGroup } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import { MarmotGroup, } from "./group/marmot-group.js";
/**
 * Builds new {@link MarmotGroup} instances. Isolates the only consumers of the
 * account-identity-proof signer and the ciphersuite implementation — i.e. the
 * native-sensitive group-creation seam (darkmatter's `do_create_group`). The
 * factory only constructs and persists; caching/eventing is the registry's job.
 */
export class GroupFactory {
    #store;
    #rewindStore;
    #signer;
    #network;
    #audit;
    #auditContext;
    #cryptoProvider;
    #accountProofSigner;
    #historyFactory;
    #mediaFactory;
    #convergencePolicy;
    #ingestionPool;
    constructor(options) {
        this.#store = options.store;
        this.#rewindStore = options.rewindStore;
        this.#convergencePolicy = options.convergencePolicy;
        this.#ingestionPool = options.ingestionPool;
        this.#signer = options.signer;
        this.#network = options.network;
        this.#audit = options.audit;
        this.#auditContext = options.auditContext;
        this.#cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
        this.#accountProofSigner = options.accountProofSigner;
        this.#historyFactory =
            options.historyFactory;
        this.#mediaFactory = options.mediaFactory;
    }
    /** Resolves a ciphersuite implementation from a name (defaults to X25519/AES128). */
    async #getCiphersuiteImpl(name) {
        const ciphersuiteName = name ?? "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
        const id = ciphersuites[ciphersuiteName];
        return await this.#cryptoProvider.getCiphersuiteImpl(id);
    }
    /**
     * Creates and persists a new simple group with the manager's signer as the
     * sole initial admin. The returned group is saved but not cached — the
     * caller (registry/manager) tracks it and emits the `created` event.
     */
    async create(name, options) {
        const ciphersuiteImpl = await this.#getCiphersuiteImpl(options?.ciphersuite);
        const pubkey = await this.#signer.getPublicKey();
        const credential = await createCredential(pubkey);
        const keyPackage = await generateKeyPackage({
            credential,
            ciphersuiteImpl,
            accountProofSigner: this.#accountProofSigner,
        });
        const { clientState } = await createSimpleGroup(keyPackage, ciphersuiteImpl, name, {
            ...options,
            adminPubkeys: [...new Set([pubkey, ...(options?.adminPubkeys || [])])],
        });
        const group = new MarmotGroup(clientState, {
            ciphersuite: ciphersuiteImpl,
            store: this.#store,
            rewindStore: this.#rewindStore,
            convergencePolicy: this.#convergencePolicy,
            ingestionPool: this.#ingestionPool,
            signer: this.#signer,
            network: this.#network,
            audit: this.#audit,
            auditContext: this.#auditContext,
            history: this.#historyFactory,
            media: this.#mediaFactory,
        });
        await group.save(true);
        return group;
    }
}
//# sourceMappingURL=group-factory.js.map
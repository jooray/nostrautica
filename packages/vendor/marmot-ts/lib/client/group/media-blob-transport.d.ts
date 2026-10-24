import type { EventSigner } from "applesauce-core";
import type { MediaBlobTransport } from "./media-transfer.js";
export interface BlossomMediaTransportOptions {
    signer: EventSigner;
    /**
     * Contact-time permission, checked before signing or fetching. Defaults to
     * HTTPS, rejecting non-routable literal hosts and localhost. A callback can allow local
     * development endpoints. DNS resolution is controlled by the fetch/network
     * implementation; use a resolver-aware fetch or egress policy to restrict it.
     */
    allowDestination?: (url: URL) => boolean;
    fetch?: typeof globalThis.fetch;
}
/** Bounded BUD-01/02 adapter. Redirects, browser credentials and caching are disabled. */
export declare function createBlossomMediaTransport(options: BlossomMediaTransportOptions): MediaBlobTransport;

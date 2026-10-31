/**
 * marmot-ts `NostrNetworkInterface` over the coordinator's Nostr transport
 * (MARMOT-GROUP-CHAT §4: "network adapter over its existing NostrClient").
 *
 * marmot needs four methods: publish, request (one-shot), subscription (live),
 * and getUserInboxRelays (kind-10050 lookup). The coordinator's `NostrClient`
 * already gives us publish / fetch / subscribe; this maps between the two shapes
 * (note the reversed `publish(relays, event)` argument order and the per-relay
 * `PublishResponse` map marmot expects).
 */
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";
import { INBOX_RELAY_LIST_KIND } from "@internet-privacy/marmot-ts/core";
import { CHAT_INTEROP_RELAYS, KIND_RELAY_LIST } from "@nostrautica/protocol";
import { sanitizeRelayUrls, type RelayPolicy } from "../net/relay-urls.js";

/** Any Nostr event shape (structurally shared between nostr-tools and applesauce). */
type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][]; [k: string]: unknown };
type AnyFilter = Record<string, unknown>;

/**
 * One relay's answer, as `NostrClient.publish` reports it on a total failure
 * (`PublishFailedError.outcomes`). Structural, so this module needs no import of
 * the transport.
 */
type RelayOutcome = { url: string; status: "acked" | "rejected" | "timeout" | "transport"; reason: string };

/** The subset of the coordinator transport this adapter drives. */
export interface ChatNetworkTransport {
  /**
   * Resolves once any relay acked (`acked`, when given, names the relays that had
   * by then). Rejects when none did, ideally with `outcomes` on the error.
   */
  publish(
    event: AnyEvent,
    relays?: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ acked?: string[] } | void>;
  fetch(filter: AnyFilter, relays?: string[], timeoutMs?: number): Promise<AnyEvent[]>;
  subscribe(filter: AnyFilter, onEvent: (e: AnyEvent) => void, relays?: string[]): () => void;
}

export interface ChatNetworkOptions {
  transport: ChatNetworkTransport;
  /** Relays used when a per-user lookup finds no inbox list. */
  defaultRelays: string[];
  /**
   * Operator relay policy (audit R20/C4) applied to relays discovered from an
   * untrusted kind-10050 inbox list. The connect-time guard already blocks
   * private-network SSRF, but WITHOUT this an approved chat user's inbox list could
   * fan the daemon out to any public relay, bypassing the operator's allowlist.
   * Defaults to `{}` (wss-only, deduped, capped — the historical behavior).
   */
  relayPolicy?: RelayPolicy;
}

/** Kind 445: group commits, proposals and application messages. */
const GROUP_EVENT_KIND = 445;

/**
 * Per-relay OK timeout for a kind-445 publish (audit K-7), instead of
 * nostr-tools' 4.4 s. A relay under REQ pressure can take longer than that to
 * answer a commit it has stored, and an OK that arrives late is still an OK.
 * The publish resolves on the first ack, so this only lengthens the case where
 * no relay answers at all.
 */
export const GROUP_EVENT_PUBLISH_TIMEOUT_MS = 15_000;

/**
 * The per-relay map marmot-ts reads after a publish no relay acked (audit K-7).
 *
 * The difference that matters is "the relay said no" against "we do not know".
 * marmot-ts (`group-runtime.js`, `#publishToGroupRelays`) keeps a commit's exact
 * bytes for a retry, as a `PublicationUncertainError`, only when some response
 * is `uncertain`. Otherwise it treats the failure as definite and rolls the
 * commit back. That was every failure here, so a relay that stored the commit
 * and then timed out its OK left the members on N+1 and the coordinator on N,
 * and the coordinator's next commit was a competing N+1 that members discard.
 *
 * So a timeout, a transport error, and any failure the transport did not
 * classify are `uncertain`. Only a relay's own OK=false is definite.
 */
function failureResponses(targets: string[], e: unknown): Record<string, PublishResponse> {
  const message = e instanceof Error ? e.message : String(e);
  const outcomes = (e as { outcomes?: unknown }).outcomes;
  const byUrl = new Map<string, RelayOutcome>();
  if (Array.isArray(outcomes)) for (const o of outcomes as RelayOutcome[]) byUrl.set(o.url, o);
  return Object.fromEntries(
    targets.map((r) => {
      const o = byUrl.get(r);
      if (o?.status === "rejected") return [r, { from: r, ok: false, message: o.reason }];
      return [r, { from: r, ok: false, message: o?.reason ?? message, uncertain: true }];
    }),
  );
}

function asArray<T>(x: T | T[]): T[] {
  return Array.isArray(x) ? x : [x];
}

/** Per-author cap on NIP-65 outbox relays consulted for a 10050 (as COORD-16). */
const MAX_OUTBOX_RELAYS = 5;

/** The newest event of `kind` by `pubkey` (relays return whatever they like). */
function newestOfKind(events: AnyEvent[], kind: number, pubkey: string): AnyEvent | undefined {
  return events
    .filter((e) => e.kind === kind && e.pubkey === pubkey)
    .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0];
}

export function makeChatNetwork(opts: ChatNetworkOptions): NostrNetworkInterface {
  const { transport, defaultRelays, relayPolicy = {} } = opts;
  return {
    async publish(relays, event): Promise<Record<string, PublishResponse>> {
      const targets = relays.length ? relays : defaultRelays;
      const opts = event.kind === GROUP_EVENT_KIND ? { timeoutMs: GROUP_EVENT_PUBLISH_TIMEOUT_MS } : undefined;
      try {
        const result = await transport.publish(event as unknown as AnyEvent, targets, opts);
        // Which relays had acked when the transport resolved. A transport that does
        // not say is taken at its word that the publish succeeded everywhere.
        // It resolved, so at least one relay acked; if none of the names match a
        // target (a spelling the transport normalized), do not turn that into a
        // failure here.
        let acked = result && Array.isArray(result.acked) ? new Set(result.acked) : undefined;
        if (acked && !targets.some((r) => acked!.has(r))) acked = undefined;
        return Object.fromEntries(
          targets.map((r) => [
            r,
            !acked || acked.has(r) ? { from: r, ok: true } : { from: r, ok: false, message: "no answer yet" },
          ]),
        );
      } catch (e) {
        return failureResponses(targets, e);
      }
    },

    async request(relays, filters) {
      const targets = relays.length ? relays : defaultRelays;
      const all: AnyEvent[] = [];
      const seen = new Set<string>();
      for (const filter of asArray(filters)) {
        for (const e of await transport.fetch(filter as AnyFilter, targets)) {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            all.push(e);
          }
        }
      }
      return all as never;
    },

    subscription(relays, filters): Subscribable<never> {
      const targets = relays.length ? relays : defaultRelays;
      return {
        subscribe(observer) {
          const closers = asArray(filters).map((filter) =>
            transport.subscribe(
              filter as AnyFilter,
              (e) => observer.next?.(e as never),
              targets,
            ),
          );
          return {
            unsubscribe() {
              for (const c of closers) c();
            },
          };
        },
      };
    },

    async getUserInboxRelays(pubkey) {
      // Where a Welcome is gift-wrapped to. For our own app's devices the default
      // relays were always enough; an EXTERNAL Marmot client (a White Noise key
      // linked under NIP §10.5) publishes its kind-10050 wherever its own client
      // puts things, so look as broadly as key-package discovery does for 10002:
      // the defaults plus the chat interop relays, then the key's own NIP-65
      // outbox relays. A Welcome sent to relays the recipient never reads is a
      // silent no-show — the linked user would sit waiting for an invite forever.
      const bootstrap = [...new Set([...defaultRelays, ...CHAT_INTEROP_RELAYS])];
      let latest = newestOfKind(
        await transport.fetch({ kinds: [INBOX_RELAY_LIST_KIND], authors: [pubkey] }, bootstrap),
        INBOX_RELAY_LIST_KIND,
        pubkey,
      );
      if (!latest) {
        const relayList = newestOfKind(
          await transport.fetch({ kinds: [KIND_RELAY_LIST], authors: [pubkey] }, bootstrap),
          KIND_RELAY_LIST,
          pubkey,
        );
        // Untrusted (COORD-16): wss-only, policy-filtered, and capped per author.
        const outbox = relayList
          ? sanitizeRelayUrls(
              relayList.tags.filter((t) => t[0] === "r" && typeof t[1] === "string").map((t) => t[1]!),
              { ...relayPolicy, cap: MAX_OUTBOX_RELAYS },
            )
          : [];
        if (outbox.length) {
          latest = newestOfKind(
            await transport.fetch({ kinds: [INBOX_RELAY_LIST_KIND], authors: [pubkey] }, outbox),
            INBOX_RELAY_LIST_KIND,
            pubkey,
          );
        }
      }
      if (!latest) return defaultRelays;
      // Untrusted input (audit COORD-16 + R20): wss-only, well-formed, deduped,
      // capped — AND filtered through the operator relay allowlist, so an approved
      // chat user's kind-10050 inbox list can't push the daemon past the operator's
      // intended public-relay egress restriction.
      const relays = sanitizeRelayUrls(
        latest.tags.filter((t) => t[0] === "relay" && typeof t[1] === "string").map((t) => t[1]!),
        relayPolicy,
      );
      return relays.length ? relays : defaultRelays;
    },
  };
}

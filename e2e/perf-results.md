# Per-page time-to-full-display (2026-07-17T13:44:30.601Z)

naddr: `naddr1qvzqqqrukvpzqf53g9yda8anr7stmr4hxjq9gsvmfzecuwdlxgrjzzc3wzf6mvcxqyfhwue69uhkcmmrv9kxsmmnwsarwdehxuqp7ur9wfnz6mt9v9eh2un9d4jkuapdv4mx2mn594nrgd3h8qcrvds4te8qa`

| Page | Cold cache-paint | Cold network-settled | Warm-nav cache-paint | Warm-nav network-settled | Warm-reload cache-paint | Warm-reload network-settled |
|---|---|---|---|---|---|---|
| Home | 3ms | 22ms | 5ms | 19ms | 27ms | 55ms |
| EventHome | 1ms | 73ms | 1ms | 38ms | 13ms | 264ms |
| Attendees | 1ms | 427ms | 1ms | 428ms | 11ms | 644ms |
| Attendee | 2ms | 48ms | 2ms | 45ms | 12ms | 365ms |
| Matches | — | 17ms | — | 15ms | — | 261ms |
| Posts | 0ms | 452ms | 0ms | 449ms | 11ms | 676ms |
| Post | 0ms | 44ms | 0ms | 47ms | 12ms | 359ms |
| Talks | — | 31ms | — | 34ms | — | 373ms |
| Admin | 21ms | — | 19ms | — | 277ms | — |
| Dm | 1ms | 414ms | 0ms | 404ms | 12ms | 567ms |
| DmChat | 2ms | 409ms | 1ms | 407ms | 12ms | 660ms |
| Record | — | 53ms | — | 47ms | — | 301ms |

## Relay-blocked reload check (EventHome)

- `nostrautica-appcache` IndexedDB present: **true**
- Reload with relay blocked — cache-paint: **11ms**
- network-settled fired despite blocked relay: **false** (expect false)
- Page rendered real event content with the relay blocked: **true**

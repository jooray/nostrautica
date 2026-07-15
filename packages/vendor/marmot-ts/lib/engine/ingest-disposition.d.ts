/** @module @category Engine */
import { type Disposition } from "../core/inbound.js";
import type { IngestResult } from "./types.js";
/** Maps an {@link IngestResult} to its protocol-visible {@link Disposition}. */
export declare function ingestResultDisposition<TEnvelope>(result: IngestResult<TEnvelope>): Disposition;

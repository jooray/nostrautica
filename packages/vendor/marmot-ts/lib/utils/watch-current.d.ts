/**
 * Watch a current value, coalescing changes while the consumer is
 * busy. Cancellation also wakes an outstanding next(), unlike a bare generator.
 * @internal
 */
export declare function watchCurrent<T>(options: {
    read: () => T | PromiseLike<T>;
    /**
     * Discard reads overtaken by changes (for storage-backed timelines). Bounded
     * so a steady change stream cannot starve the consumer; the next pull rereads.
     */
    discardStale?: boolean;
    subscribe: (changed: () => void) => () => void;
    signal?: AbortSignal;
    closed?: AbortSignal;
}): AsyncGenerator<T>;

/**
 * Watch a synchronous current value, coalescing changes while the consumer is
 * busy. Cancellation also wakes an outstanding next(), unlike a bare generator.
 * @internal
 */
export declare function watchCurrent<T>(options: {
    read: () => T;
    subscribe: (changed: () => void) => () => void;
    signal?: AbortSignal;
    closed?: AbortSignal;
}): AsyncGenerator<T>;

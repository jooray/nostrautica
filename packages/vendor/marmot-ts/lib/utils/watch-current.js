/**
 * Watch a synchronous current value, coalescing changes while the consumer is
 * busy. Cancellation also wakes an outstanding next(), unlike a bare generator.
 * @internal
 */
export function watchCurrent(options) {
    let cancelled = false;
    let version = 0;
    let wake;
    let unsubscribe;
    const changed = () => {
        version++;
        wake?.();
        wake = undefined;
    };
    const cancel = () => {
        cancelled = true;
        unsubscribe?.();
        unsubscribe = undefined;
        options.signal?.removeEventListener("abort", cancel);
        options.closed?.removeEventListener("abort", cancel);
        wake?.();
        wake = undefined;
    };
    const iterator = (async function* () {
        if (cancelled || options.signal?.aborted || options.closed?.aborted)
            return;
        unsubscribe = options.subscribe(changed);
        options.signal?.addEventListener("abort", cancel, { once: true });
        options.closed?.addEventListener("abort", cancel, { once: true });
        try {
            let yieldedVersion = -1;
            while (!cancelled) {
                if (yieldedVersion === version)
                    await new Promise((resolve) => {
                        wake = resolve;
                    });
                if (cancelled)
                    return;
                yieldedVersion = version;
                yield options.read();
            }
        }
        finally {
            cancel();
        }
    })();
    return {
        next: (...args) => iterator.next(...args),
        return: (value) => {
            cancel();
            return iterator.return(value);
        },
        throw: (error) => {
            cancel();
            return iterator.throw(error);
        },
        [Symbol.asyncIterator]() {
            return this;
        },
        async [Symbol.asyncDispose]() {
            cancel();
            await iterator.return(undefined);
        },
    };
}

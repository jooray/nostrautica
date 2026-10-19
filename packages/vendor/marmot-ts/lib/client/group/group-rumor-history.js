import { matchFilters } from "applesauce-core/helpers/filter";
import { EventEmitter } from "eventemitter3";
import { deserializeApplicationData } from "../../core/group-message.js";
/** A group.history implementation that stores the parsed rumor events for a group and provies methods for querying */
export class GroupRumorHistory extends EventEmitter {
    backend;
    constructor(backend) {
        super();
        this.backend = backend;
    }
    /** Creates a new method that will create {@link GroupRumorHistory} instances for a group id */
    static makeFactory(backendFactory) {
        return (groupId) => new GroupRumorHistory(backendFactory(groupId));
    }
    /** Parses an MLS message and saves it as a rumor event */
    async saveMessage(message) {
        let rumor;
        try {
            rumor = deserializeApplicationData(message);
        }
        catch (error) {
            return; // Invalid payloads have no rumor to store.
        }
        await this.saveRumor(rumor);
    }
    /** Saves a new rumor event to the backend */
    async saveRumor(rumor) {
        await this.backend.addRumor(rumor);
        // Notify listeners that a new rumor has been added
        this.emit("rumor", rumor);
    }
    /** Purge all rumor events from the backend */
    async purgeMessages() {
        await this.backend.clear();
        // Notify listeners that all rumors have been cleared
        this.emit("cleared");
    }
    /** Retract a validated inner identity before notifying timeline listeners. */
    async removeMessage(rumorId) {
        if (!/^[a-f0-9]{64}$/.test(rumorId))
            throw new Error("Invalid rumor ID for history removal");
        await this.backend.removeRumor(rumorId);
        this.emit("removed", rumorId);
    }
    /** Request stored rumors by filters */
    async queryRumors(filters) {
        return this.backend.queryRumors(Array.isArray(filters) ? filters : [filters]);
    }
    /**
     * Async generator that yields the current timeline of {@link Rumor} events whenever a
     * matching rumor is saved, a rumor is removed, or history is cleared. Each
     * snapshot is freshly queried so removal refills limited pages. Changes
     * during loading or paused consumption are latched until the next pull.
     *
     * The generator runs until the caller breaks out of the loop or the consuming
     * iterator is garbage-collected (via the `finally` cleanup).
     */
    async *subscribe(filters) {
        const filtersArray = filters
            ? Array.isArray(filters)
                ? filters
                : [filters]
            : [{}];
        let version = 0;
        let observed = -1;
        let wake;
        const changed = () => {
            version++;
            wake?.();
            wake = undefined;
        };
        const inserted = (rumor) => {
            if (matchFilters(filtersArray, rumor))
                changed();
        };
        this.on("rumor", inserted);
        this.on("cleared", changed);
        this.on("removed", changed);
        try {
            while (true) {
                if (observed === version)
                    await new Promise((resolve) => {
                        wake = resolve;
                    });
                const snapshotVersion = version;
                const snapshot = await this.backend.queryRumors(filtersArray);
                if (snapshotVersion !== version)
                    continue;
                observed = snapshotVersion;
                yield [...snapshot];
            }
        }
        finally {
            this.off("rumor", inserted);
            this.off("cleared", changed);
            this.off("removed", changed);
        }
    }
    /**
     * Creates an async generator for paginated loading of historical rumor events.
     *
     * This method allows UI components to load historical messages in pages, enabling
     * infinite scroll or paginated UI patterns.
     *
     * @param filter - Optional filter to apply to the query
     * @yields Batches of Rumor events, with each batch containing up to `filter.limit` messages
     */
    async *createPaginatedLoader(filter) {
        const limit = filter?.limit ?? 50;
        let cursor = filter?.until ?? undefined;
        while (true) {
            const rumors = await this.backend.queryRumors({
                ...filter,
                until: cursor,
                limit,
            });
            // If no rumors returned, we've reached the end
            if (rumors.length === 0)
                return;
            // Find the oldest timestamp in the current page
            // and set it as the new `until` for the next page (going backwards)
            const oldest = Math.min(...rumors.map((rumor) => rumor.created_at));
            // Set the next `until` to be just before the oldest message
            // This ensures we get the next older page without duplicates
            if (!cursor || oldest < cursor)
                cursor = oldest - 1;
            // Yield the current page
            yield rumors;
            // If we got fewer than the limit, we've reached the end
            if (rumors.length < limit) {
                return;
            }
        }
    }
}

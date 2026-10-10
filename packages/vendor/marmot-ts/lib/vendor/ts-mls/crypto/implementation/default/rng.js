export const defaultRng = {
    randomBytes(n) {
        return crypto.getRandomValues(new Uint8Array(n));
    },
};

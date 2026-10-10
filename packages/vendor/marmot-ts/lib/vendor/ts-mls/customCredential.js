function createCustomCredentialType(credentialId) {
    return credentialId;
}
export function createCustomCredential(credentialId, data) {
    const result = {
        credentialType: createCustomCredentialType(credentialId),
        data,
    };
    return result;
}

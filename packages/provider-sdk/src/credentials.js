/**
 * Credential shapes shared by the provider adapter contract and the auth
 * contract. Extracted into their own module so `auth.ts` and `provider.ts` can
 * both reference them without importing each other (no cycle).
 */
/**
 * Generic API-key resolver for provider plugins. The host still owns encrypted
 * persistence; the plugin owns how its config row maps to runtime credentials.
 */
export function resolveApiKeyConfigCredentials(config, defaultBaseURL) {
    return {
        apiKey: config.api_key ?? undefined,
        baseURL: config.base_url ?? defaultBaseURL,
        extra: config.extra ?? undefined,
    };
}
/**
 * Generic AWS/SigV4 resolver for provider plugins. Reads the provider-owned
 * secret blob through the SDK credential store and falls back to config.extra
 * for region so SDK clients can still use the default AWS credential chain.
 */
export async function resolveAwsConfigCredentials(config, credentials) {
    const aws = {};
    const tokens = await credentials.get();
    const extra = tokens?.extra ?? {};
    aws.accessKeyId = readString(extra.accessKeyId);
    aws.secretAccessKey = readString(extra.secretAccessKey);
    aws.sessionToken = readString(extra.sessionToken);
    aws.region = readString(extra.region) ?? readString(config.extra?.aws_region);
    return { aws };
}
function readString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
//# sourceMappingURL=credentials.js.map
/**
 * Zod validators for `ProviderSpec` (the declarative provider authoring surface).
 *
 * Two variants:
 *  - `providerSpecSchema` — the FULL schema (built-ins / host). Accepts every
 *    field, every wire, every discovery/test format, and host-only auth (hooks).
 *  - `thirdPartyProviderSpecSchema` — what a PLUGIN may author. It rejects the
 *    host-only capabilities a third party must not claim: `auth.hooks` (names a
 *    host exotic-hook module), the `sdk:*` / `chatgpt-models` discovery formats
 *    and the `codex-health` / `sdk:*` test formats (host OAuth/SDK code), and the
 *    `pat-exchange` auth flavor (needs a host hook). Everything else — including
 *    the 6 wires and RFC authorization-code/device-code auth — is declarative.
 *
 * The "parse every built-in spec" test (provider-engine) is the drift guard: a
 * field added to `ProviderSpec` without the schema makes a real spec fail
 * `.strict()`, so the schema cannot silently fall behind the type.
 */
import { z } from 'zod';
const valueSourceSchema = z
    .object({ from: z.enum(['extra', 'env']), key: z.string() })
    .strict();
const templateVarSchema = z
    .object({
    sources: z.array(valueSourceSchema),
    required: z.boolean().optional(),
    errorMessage: z.string().optional(),
})
    .strict();
const wireOptsSchema = z
    .object({
    // Shared by both the full and third-party schemas: a third party may author
    // `vendor:'fugu'` — harmless (the flag only tweaks requests against their own
    // configured baseURL, same profile as the already-allowed 'zai'/'openrouter').
    vendor: z.enum(['openai', 'openrouter', 'zai', 'deepseek', 'copilot', 'fugu', 'mistral']).optional(),
    baseUrlTemplate: z.string().optional(),
    baseUrlVars: z.record(z.string(), templateVarSchema).optional(),
    modelModes: z
        .object({
        map: z.record(z.string(), z.object({ baseURL: z.string() }).strict()),
        envOverride: z.string().optional(),
        defaultModeKey: z.string().optional(),
    })
        .strict()
        .optional(),
    headerSources: z
        .array(z
        .object({
        header: z.string(),
        sources: z.array(valueSourceSchema),
        defaultValue: z.string().optional(),
    })
        .strict())
        .optional(),
    thinkingMode: z
        .object({
        from: z.literal('extra'),
        key: z.string(),
        default: z.enum(['auto', 'enabled', 'disabled']),
    })
        .strict()
        .optional(),
    defaultThinking: z
        .object({ type: z.literal('enabled'), budget_tokens: z.number() })
        .strict()
        .optional(),
    claudeCode: z.boolean().optional(),
    geminiOAuth: z.boolean().optional(),
    responsesApi: z.boolean().optional(),
    responsesStateless: z.boolean().optional(),
    responsesReasoningSummaryModels: z.array(z.string()).optional(),
    responsesReasoningFromThinking: z.boolean().optional(),
    responsesIncludeOrchestrationUsage: z.boolean().optional(),
    summaryModelDefault: z.string().optional(),
    indexerDefaultModel: z.string().optional(),
})
    .strict();
const DISCOVERY_FORMATS = [
    'openai-models',
    'anthropic-models',
    'gemini-models',
    'openrouter-models',
    'cloudflare-models',
    'chatgpt-models',
    'sdk:bedrock',
    'sdk:copilot',
    'sdk:claude-code',
    'sdk:kimi-code',
    'sdk:google-oauth',
    'static',
];
/** Declarative-safe discovery formats a third party may use (HTTP `/models` + static). */
const THIRD_PARTY_DISCOVERY_FORMATS = [
    'openai-models',
    'anthropic-models',
    'gemini-models',
    'openrouter-models',
    'cloudflare-models',
    'static',
];
const TEST_FORMATS = [
    'openai-models',
    'anthropic-models',
    'gemini-key',
    'gemini-oauth',
    'codex-health',
    'sdk:kimi-code',
    'sdk:claude-code',
    'unsupported',
];
const THIRD_PARTY_TEST_FORMATS = ['openai-models', 'anthropic-models', 'gemini-key', 'unsupported'];
const discoveryDescriptorSchema = (formats) => z
    .object({
    from: z.enum(formats),
    modelsUrl: z.string().optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
    filterPrefixes: z.array(z.string()).optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    supportsModes: z.array(z.string()).optional(),
    accountIdFrom: templateVarSchema.optional(),
})
    .strict();
const testDescriptorSchema = (formats) => z
    .object({
    from: z.enum(formats),
    fallbackBaseURL: z.string().optional(),
    message: z.string().optional(),
})
    .strict();
const providerModelMetaSchema = z
    .object({
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
    canReason: z.boolean().optional(),
    supportsAttachments: z.boolean().optional(),
    inputModalities: z.array(z.string()).optional(),
    supportedReasoningLevels: z.array(z.string()).nullable().optional(),
    defaultReasoningLevel: z.string().nullable().optional(),
    applyPatchToolType: z.string().nullable().optional(),
})
    .strict();
const pricingEntrySchema = z.object({ inputPer1M: z.number(), outputPer1M: z.number() }).strict();
const capabilitiesSchema = z
    .object({
    zaiCodingMode: z.boolean().optional(),
    supportsThinking: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    fileInput: z.enum(['native', 'pdf-only', 'text', 'model-dependent']).optional(),
    supportsImageGen: z.boolean().optional(),
})
    .strict();
const visualSchema = z.object({ icon: z.string(), fg: z.string(), bg: z.string() }).strict();
const authFieldSchema = z
    .object({
    key: z.string(),
    label: z.string(),
    secret: z.boolean().optional(),
    optional: z.boolean().optional(),
    placeholder: z.string().optional(),
})
    .strict();
const authNeedsSchema = z
    .object({
    loopback: z.boolean().optional(),
    deviceCode: z.boolean().optional(),
    openBrowser: z.boolean().optional(),
    scheduledRefresh: z.boolean().optional(),
})
    .strict();
/** Declarative settings-form field. Pure presentational data — no host capability,
 *  so the SAME schema is safe for built-ins and third-party plugins. */
const configFieldSchema = z
    .object({
    key: z.string().min(1),
    type: z.enum(['text', 'password', 'select', 'toggle']),
    label: z.string(),
    storeIn: z.enum(['api_key', 'base_url', 'extra']),
    options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
    optional: z.boolean().optional(),
    advanced: z.boolean().optional(),
    default: z.string().optional(),
})
    .strict();
const providerConfigDescriptorSchema = z.object({ fields: z.array(configFieldSchema) }).strict();
/** Recursive JSON value (for `request.body.inject`). Pure data — third-party-safe. */
const jsonValueSchema = z.lazy(() => z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
]));
/** Declarative HTTP-request customization. Claims NO host capability → the SAME
 *  schema is safe for built-ins and third-party plugins (added to both variants). */
const requestDescriptorSchema = z
    .object({
    auth: z.object({ header: z.string().min(1), valueTemplate: z.string() }).strict().optional(),
    headers: z
        .array(z.object({ header: z.string().min(1), value: z.string() }).strict())
        .optional(),
    query: z.record(z.string(), z.string()).optional(),
    model: z
        .object({
        stripSuffix: z.array(z.string()).optional(),
        map: z.record(z.string(), z.string()).optional(),
        template: z.string().optional(),
    })
        .strict()
        .optional(),
    body: z
        .object({
        inject: z.record(z.string(), jsonValueSchema).optional(),
        remove: z.array(z.string()).optional(),
    })
        .strict()
        .optional(),
    response: z.object({ reasoningDeltaKey: z.string() }).strict().optional(),
})
    .strict();
/** Common auth fields (both host + third-party). `flavor`/`hooks` are tightened per-variant. */
const authBase = {
    mode: z.enum(['api-key', 'oauth', 'aws-sigv4']),
    scopes: z.array(z.string()).optional(),
    refreshThresholdSec: z.number().optional(),
    fields: z.array(authFieldSchema).optional(),
    needs: authNeedsSchema.optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    authorizeUrl: z.string().optional(),
    authorizeUrlByScope: z.array(z.object({ whenScope: z.string(), url: z.string() }).strict()).optional(),
    tokenUrl: z.string().optional(),
    deviceAuthUrl: z.string().optional(),
    redirect: z.object({ port: z.number().optional(), path: z.string().optional() }).strict().optional(),
    authorizeParams: z.record(z.string(), z.string()).optional(),
};
const authDescriptorSchema = z
    .object({
    ...authBase,
    flavor: z.enum(['authorization-code', 'device-code', 'pat-exchange']).optional(),
    hooks: z.string().optional(),
})
    .strict();
const semanticDescriptorSchema = z.object({
    embedding: z.object({
        protocol: z.enum(['openai-embeddings', 'cloudflare', 'bedrock']),
        defaultModels: z.array(z.string()).optional(),
        modelPatterns: z.array(z.string()).optional(),
    }).strict().optional(),
    rerank: z.object({
        protocol: z.enum(['cohere-rerank', 'openai-rerank', 'cloudflare', 'bedrock']),
        defaultModels: z.array(z.string()).optional(),
        modelPatterns: z.array(z.string()).optional(),
    }).strict().optional(),
}).strict();
/** Third-party auth: no `hooks` (host-only), no `pat-exchange` (needs a host hook). */
const thirdPartyAuthDescriptorSchema = z
    .object({
    ...authBase,
    flavor: z.enum(['authorization-code', 'device-code']).optional(),
})
    .strict();
function specSchema(opts) {
    return z
        .object({
        specVersion: z.number().optional(),
        kind: z.string().min(1),
        displayName: z.string().min(1),
        visual: visualSchema.optional(),
        credKind: z.enum(['api-key', 'oauth', 'aws']),
        envVars: z.array(z.string()),
        defaultBaseURL: z.string().optional(),
        defaultModels: z.array(z.string()),
        defaultModel: z.string().optional(),
        pricing: z.record(z.string(), pricingEntrySchema),
        pricingPriority: z.number().optional(),
        capabilities: capabilitiesSchema.optional(),
        semantic: semanticDescriptorSchema.optional(),
        wire: z.enum(['openai-compat', 'anthropic', 'gemini', 'bedrock', 'codex', 'kimi']),
        wireOpts: wireOptsSchema.optional(),
        request: requestDescriptorSchema.optional(),
        discovery: discoveryDescriptorSchema(opts.discoveryFormats).optional(),
        models: z.record(z.string(), providerModelMetaSchema).optional(),
        test: testDescriptorSchema(opts.testFormats).optional(),
        auth: opts.auth.optional(),
        config: providerConfigDescriptorSchema.optional(),
    })
        .strict()
        // `request.auth` overrides the credential header — only meaningful (and only
        // safe) on the api-key path. OAuth/aws connectors own auth via their hooks.
        .superRefine((spec, ctx) => {
        if (spec.request?.auth && spec.credKind !== 'api-key') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['request', 'auth'],
                message: "request.auth requires credKind 'api-key'",
            });
        }
    });
}
/** Full schema (built-ins / host) — every wire, format, and host-only auth. */
export const providerSpecSchema = specSchema({
    discoveryFormats: DISCOVERY_FORMATS,
    testFormats: TEST_FORMATS,
    auth: authDescriptorSchema,
});
/** What a third-party PLUGIN may author — host-only capabilities rejected. */
export const thirdPartyProviderSpecSchema = specSchema({
    discoveryFormats: THIRD_PARTY_DISCOVERY_FORMATS,
    testFormats: THIRD_PARTY_TEST_FORMATS,
    auth: thirdPartyAuthDescriptorSchema,
});
// ── compile-time drift guard: a validated spec must be a usable ProviderSpec ──
// (the runtime "parse every BUILTIN_SPECS" test guards the reverse direction).
const _schemaInfersSpec = (s) => s;
void _schemaInfersSpec;
//# sourceMappingURL=spec.schema.js.map
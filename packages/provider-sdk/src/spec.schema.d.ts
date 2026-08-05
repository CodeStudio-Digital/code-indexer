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
/** Full schema (built-ins / host) — every wire, format, and host-only auth. */
export declare const providerSpecSchema: z.ZodEffects<z.ZodObject<{
    specVersion: z.ZodOptional<z.ZodNumber>;
    kind: z.ZodString;
    displayName: z.ZodString;
    visual: z.ZodOptional<z.ZodObject<{
        icon: z.ZodString;
        fg: z.ZodString;
        bg: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        icon: string;
        fg: string;
        bg: string;
    }, {
        icon: string;
        fg: string;
        bg: string;
    }>>;
    credKind: z.ZodEnum<["api-key", "oauth", "aws"]>;
    envVars: z.ZodArray<z.ZodString, "many">;
    defaultBaseURL: z.ZodOptional<z.ZodString>;
    defaultModels: z.ZodArray<z.ZodString, "many">;
    defaultModel: z.ZodOptional<z.ZodString>;
    pricing: z.ZodRecord<z.ZodString, z.ZodObject<{
        inputPer1M: z.ZodNumber;
        outputPer1M: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        inputPer1M: number;
        outputPer1M: number;
    }, {
        inputPer1M: number;
        outputPer1M: number;
    }>>;
    pricingPriority: z.ZodOptional<z.ZodNumber>;
    capabilities: z.ZodOptional<z.ZodObject<{
        zaiCodingMode: z.ZodOptional<z.ZodBoolean>;
        supportsThinking: z.ZodOptional<z.ZodBoolean>;
        supportsVision: z.ZodOptional<z.ZodBoolean>;
        fileInput: z.ZodOptional<z.ZodEnum<["native", "pdf-only", "text", "model-dependent"]>>;
        supportsImageGen: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    }, {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    }>>;
    semantic: z.ZodOptional<z.ZodObject<{
        embedding: z.ZodOptional<z.ZodObject<{
            protocol: z.ZodEnum<["openai-embeddings", "cloudflare", "bedrock"]>;
            defaultModels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            modelPatterns: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        }, {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        }>>;
        rerank: z.ZodOptional<z.ZodObject<{
            protocol: z.ZodEnum<["cohere-rerank", "openai-rerank", "cloudflare", "bedrock"]>;
            defaultModels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            modelPatterns: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        }, {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        }>>;
    }, "strict", z.ZodTypeAny, {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    }, {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    }>>;
    wire: z.ZodEnum<["openai-compat", "anthropic", "gemini", "bedrock", "codex", "kimi"]>;
    wireOpts: z.ZodOptional<z.ZodObject<{
        vendor: z.ZodOptional<z.ZodEnum<["openai", "openrouter", "zai", "deepseek", "copilot", "fugu", "mistral"]>>;
        baseUrlTemplate: z.ZodOptional<z.ZodString>;
        baseUrlVars: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            sources: z.ZodArray<z.ZodObject<{
                from: z.ZodEnum<["extra", "env"]>;
                key: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                key: string;
                from: "extra" | "env";
            }, {
                key: string;
                from: "extra" | "env";
            }>, "many">;
            required: z.ZodOptional<z.ZodBoolean>;
            errorMessage: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }>>>;
        modelModes: z.ZodOptional<z.ZodObject<{
            map: z.ZodRecord<z.ZodString, z.ZodObject<{
                baseURL: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                baseURL: string;
            }, {
                baseURL: string;
            }>>;
            envOverride: z.ZodOptional<z.ZodString>;
            defaultModeKey: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        }, {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        }>>;
        headerSources: z.ZodOptional<z.ZodArray<z.ZodObject<{
            header: z.ZodString;
            sources: z.ZodArray<z.ZodObject<{
                from: z.ZodEnum<["extra", "env"]>;
                key: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                key: string;
                from: "extra" | "env";
            }, {
                key: string;
                from: "extra" | "env";
            }>, "many">;
            defaultValue: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }>, "many">>;
        thinkingMode: z.ZodOptional<z.ZodObject<{
            from: z.ZodLiteral<"extra">;
            key: z.ZodString;
            default: z.ZodEnum<["auto", "enabled", "disabled"]>;
        }, "strict", z.ZodTypeAny, {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        }, {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        }>>;
        defaultThinking: z.ZodOptional<z.ZodObject<{
            type: z.ZodLiteral<"enabled">;
            budget_tokens: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            type: "enabled";
            budget_tokens: number;
        }, {
            type: "enabled";
            budget_tokens: number;
        }>>;
        claudeCode: z.ZodOptional<z.ZodBoolean>;
        geminiOAuth: z.ZodOptional<z.ZodBoolean>;
        responsesApi: z.ZodOptional<z.ZodBoolean>;
        responsesStateless: z.ZodOptional<z.ZodBoolean>;
        responsesReasoningSummaryModels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        responsesReasoningFromThinking: z.ZodOptional<z.ZodBoolean>;
        responsesIncludeOrchestrationUsage: z.ZodOptional<z.ZodBoolean>;
        summaryModelDefault: z.ZodOptional<z.ZodString>;
        indexerDefaultModel: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    }, {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    }>>;
    request: z.ZodOptional<z.ZodObject<{
        auth: z.ZodOptional<z.ZodObject<{
            header: z.ZodString;
            valueTemplate: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            header: string;
            valueTemplate: string;
        }, {
            header: string;
            valueTemplate: string;
        }>>;
        headers: z.ZodOptional<z.ZodArray<z.ZodObject<{
            header: z.ZodString;
            value: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            value: string;
            header: string;
        }, {
            value: string;
            header: string;
        }>, "many">>;
        query: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        model: z.ZodOptional<z.ZodObject<{
            stripSuffix: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            template: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        }, {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        }>>;
        body: z.ZodOptional<z.ZodObject<{
            inject: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<any, z.ZodTypeDef, any>>>;
            remove: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        }, {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        }>>;
        response: z.ZodOptional<z.ZodObject<{
            reasoningDeltaKey: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            reasoningDeltaKey: string;
        }, {
            reasoningDeltaKey: string;
        }>>;
    }, "strict", z.ZodTypeAny, {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    }, {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    }>>;
    discovery: z.ZodOptional<z.ZodObject<{
        from: z.ZodEnum<["openai-models", "anthropic-models", "gemini-models", "openrouter-models", "cloudflare-models", "chatgpt-models", "sdk:bedrock", "sdk:copilot", "sdk:claude-code", "sdk:kimi-code", "sdk:google-oauth", "static"]>;
        modelsUrl: z.ZodOptional<z.ZodString>;
        queryParams: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        filterPrefixes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        requiredCapabilities: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        supportsModes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        accountIdFrom: z.ZodOptional<z.ZodObject<{
            sources: z.ZodArray<z.ZodObject<{
                from: z.ZodEnum<["extra", "env"]>;
                key: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                key: string;
                from: "extra" | "env";
            }, {
                key: string;
                from: "extra" | "env";
            }>, "many">;
            required: z.ZodOptional<z.ZodBoolean>;
            errorMessage: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }>>;
    }, "strict", z.ZodTypeAny, {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "chatgpt-models" | "sdk:bedrock" | "sdk:copilot" | "sdk:claude-code" | "sdk:kimi-code" | "sdk:google-oauth" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    }, {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "chatgpt-models" | "sdk:bedrock" | "sdk:copilot" | "sdk:claude-code" | "sdk:kimi-code" | "sdk:google-oauth" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    }>>;
    models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        contextWindow: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        canReason: z.ZodOptional<z.ZodBoolean>;
        supportsAttachments: z.ZodOptional<z.ZodBoolean>;
        inputModalities: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        supportedReasoningLevels: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
        defaultReasoningLevel: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        applyPatchToolType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strict", z.ZodTypeAny, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }>>>;
    test: z.ZodOptional<z.ZodObject<{
        from: z.ZodEnum<["openai-models", "anthropic-models", "gemini-key", "gemini-oauth", "codex-health", "sdk:kimi-code", "sdk:claude-code", "unsupported"]>;
        fallbackBaseURL: z.ZodOptional<z.ZodString>;
        message: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        from: "openai-models" | "anthropic-models" | "sdk:claude-code" | "sdk:kimi-code" | "gemini-key" | "gemini-oauth" | "codex-health" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    }, {
        from: "openai-models" | "anthropic-models" | "sdk:claude-code" | "sdk:kimi-code" | "gemini-key" | "gemini-oauth" | "codex-health" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    }>>;
    auth: z.ZodOptional<z.ZodTypeAny>;
    config: z.ZodOptional<z.ZodObject<{
        fields: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            type: z.ZodEnum<["text", "password", "select", "toggle"]>;
            label: z.ZodString;
            storeIn: z.ZodEnum<["api_key", "base_url", "extra"]>;
            options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                value: z.ZodString;
                label: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                value: string;
                label: string;
            }, {
                value: string;
                label: string;
            }>, "many">>;
            placeholder: z.ZodOptional<z.ZodString>;
            helpText: z.ZodOptional<z.ZodString>;
            optional: z.ZodOptional<z.ZodBoolean>;
            advanced: z.ZodOptional<z.ZodBoolean>;
            default: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }, {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }>, "many">;
    }, "strict", z.ZodTypeAny, {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    }, {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    }>>;
}, "strict", z.ZodTypeAny, {
    kind: string;
    displayName: string;
    credKind: "api-key" | "oauth" | "aws";
    envVars: string[];
    defaultModels: string[];
    pricing: Record<string, {
        inputPer1M: number;
        outputPer1M: number;
    }>;
    wire: "openai-compat" | "anthropic" | "gemini" | "bedrock" | "codex" | "kimi";
    specVersion?: number | undefined;
    visual?: {
        icon: string;
        fg: string;
        bg: string;
    } | undefined;
    defaultBaseURL?: string | undefined;
    defaultModel?: string | undefined;
    pricingPriority?: number | undefined;
    capabilities?: {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    } | undefined;
    semantic?: {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    } | undefined;
    wireOpts?: {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    } | undefined;
    auth?: any;
    request?: {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    } | undefined;
    discovery?: {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "chatgpt-models" | "sdk:bedrock" | "sdk:copilot" | "sdk:claude-code" | "sdk:kimi-code" | "sdk:google-oauth" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    } | undefined;
    models?: Record<string, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }> | undefined;
    test?: {
        from: "openai-models" | "anthropic-models" | "sdk:claude-code" | "sdk:kimi-code" | "gemini-key" | "gemini-oauth" | "codex-health" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    } | undefined;
    config?: {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    } | undefined;
}, {
    kind: string;
    displayName: string;
    credKind: "api-key" | "oauth" | "aws";
    envVars: string[];
    defaultModels: string[];
    pricing: Record<string, {
        inputPer1M: number;
        outputPer1M: number;
    }>;
    wire: "openai-compat" | "anthropic" | "gemini" | "bedrock" | "codex" | "kimi";
    specVersion?: number | undefined;
    visual?: {
        icon: string;
        fg: string;
        bg: string;
    } | undefined;
    defaultBaseURL?: string | undefined;
    defaultModel?: string | undefined;
    pricingPriority?: number | undefined;
    capabilities?: {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    } | undefined;
    semantic?: {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    } | undefined;
    wireOpts?: {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    } | undefined;
    auth?: any;
    request?: {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    } | undefined;
    discovery?: {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "chatgpt-models" | "sdk:bedrock" | "sdk:copilot" | "sdk:claude-code" | "sdk:kimi-code" | "sdk:google-oauth" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    } | undefined;
    models?: Record<string, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }> | undefined;
    test?: {
        from: "openai-models" | "anthropic-models" | "sdk:claude-code" | "sdk:kimi-code" | "gemini-key" | "gemini-oauth" | "codex-health" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    } | undefined;
    config?: {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    } | undefined;
}>, {
    kind: string;
    displayName: string;
    credKind: "api-key" | "oauth" | "aws";
    envVars: string[];
    defaultModels: string[];
    pricing: Record<string, {
        inputPer1M: number;
        outputPer1M: number;
    }>;
    wire: "openai-compat" | "anthropic" | "gemini" | "bedrock" | "codex" | "kimi";
    specVersion?: number | undefined;
    visual?: {
        icon: string;
        fg: string;
        bg: string;
    } | undefined;
    defaultBaseURL?: string | undefined;
    defaultModel?: string | undefined;
    pricingPriority?: number | undefined;
    capabilities?: {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    } | undefined;
    semantic?: {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    } | undefined;
    wireOpts?: {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    } | undefined;
    auth?: any;
    request?: {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    } | undefined;
    discovery?: {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "chatgpt-models" | "sdk:bedrock" | "sdk:copilot" | "sdk:claude-code" | "sdk:kimi-code" | "sdk:google-oauth" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    } | undefined;
    models?: Record<string, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }> | undefined;
    test?: {
        from: "openai-models" | "anthropic-models" | "sdk:claude-code" | "sdk:kimi-code" | "gemini-key" | "gemini-oauth" | "codex-health" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    } | undefined;
    config?: {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    } | undefined;
}, {
    kind: string;
    displayName: string;
    credKind: "api-key" | "oauth" | "aws";
    envVars: string[];
    defaultModels: string[];
    pricing: Record<string, {
        inputPer1M: number;
        outputPer1M: number;
    }>;
    wire: "openai-compat" | "anthropic" | "gemini" | "bedrock" | "codex" | "kimi";
    specVersion?: number | undefined;
    visual?: {
        icon: string;
        fg: string;
        bg: string;
    } | undefined;
    defaultBaseURL?: string | undefined;
    defaultModel?: string | undefined;
    pricingPriority?: number | undefined;
    capabilities?: {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    } | undefined;
    semantic?: {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    } | undefined;
    wireOpts?: {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    } | undefined;
    auth?: any;
    request?: {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    } | undefined;
    discovery?: {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "chatgpt-models" | "sdk:bedrock" | "sdk:copilot" | "sdk:claude-code" | "sdk:kimi-code" | "sdk:google-oauth" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    } | undefined;
    models?: Record<string, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }> | undefined;
    test?: {
        from: "openai-models" | "anthropic-models" | "sdk:claude-code" | "sdk:kimi-code" | "gemini-key" | "gemini-oauth" | "codex-health" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    } | undefined;
    config?: {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    } | undefined;
}>;
/** What a third-party PLUGIN may author — host-only capabilities rejected. */
export declare const thirdPartyProviderSpecSchema: z.ZodEffects<z.ZodObject<{
    specVersion: z.ZodOptional<z.ZodNumber>;
    kind: z.ZodString;
    displayName: z.ZodString;
    visual: z.ZodOptional<z.ZodObject<{
        icon: z.ZodString;
        fg: z.ZodString;
        bg: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        icon: string;
        fg: string;
        bg: string;
    }, {
        icon: string;
        fg: string;
        bg: string;
    }>>;
    credKind: z.ZodEnum<["api-key", "oauth", "aws"]>;
    envVars: z.ZodArray<z.ZodString, "many">;
    defaultBaseURL: z.ZodOptional<z.ZodString>;
    defaultModels: z.ZodArray<z.ZodString, "many">;
    defaultModel: z.ZodOptional<z.ZodString>;
    pricing: z.ZodRecord<z.ZodString, z.ZodObject<{
        inputPer1M: z.ZodNumber;
        outputPer1M: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        inputPer1M: number;
        outputPer1M: number;
    }, {
        inputPer1M: number;
        outputPer1M: number;
    }>>;
    pricingPriority: z.ZodOptional<z.ZodNumber>;
    capabilities: z.ZodOptional<z.ZodObject<{
        zaiCodingMode: z.ZodOptional<z.ZodBoolean>;
        supportsThinking: z.ZodOptional<z.ZodBoolean>;
        supportsVision: z.ZodOptional<z.ZodBoolean>;
        fileInput: z.ZodOptional<z.ZodEnum<["native", "pdf-only", "text", "model-dependent"]>>;
        supportsImageGen: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    }, {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    }>>;
    semantic: z.ZodOptional<z.ZodObject<{
        embedding: z.ZodOptional<z.ZodObject<{
            protocol: z.ZodEnum<["openai-embeddings", "cloudflare", "bedrock"]>;
            defaultModels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            modelPatterns: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        }, {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        }>>;
        rerank: z.ZodOptional<z.ZodObject<{
            protocol: z.ZodEnum<["cohere-rerank", "openai-rerank", "cloudflare", "bedrock"]>;
            defaultModels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            modelPatterns: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        }, {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        }>>;
    }, "strict", z.ZodTypeAny, {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    }, {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    }>>;
    wire: z.ZodEnum<["openai-compat", "anthropic", "gemini", "bedrock", "codex", "kimi"]>;
    wireOpts: z.ZodOptional<z.ZodObject<{
        vendor: z.ZodOptional<z.ZodEnum<["openai", "openrouter", "zai", "deepseek", "copilot", "fugu", "mistral"]>>;
        baseUrlTemplate: z.ZodOptional<z.ZodString>;
        baseUrlVars: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            sources: z.ZodArray<z.ZodObject<{
                from: z.ZodEnum<["extra", "env"]>;
                key: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                key: string;
                from: "extra" | "env";
            }, {
                key: string;
                from: "extra" | "env";
            }>, "many">;
            required: z.ZodOptional<z.ZodBoolean>;
            errorMessage: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }>>>;
        modelModes: z.ZodOptional<z.ZodObject<{
            map: z.ZodRecord<z.ZodString, z.ZodObject<{
                baseURL: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                baseURL: string;
            }, {
                baseURL: string;
            }>>;
            envOverride: z.ZodOptional<z.ZodString>;
            defaultModeKey: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        }, {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        }>>;
        headerSources: z.ZodOptional<z.ZodArray<z.ZodObject<{
            header: z.ZodString;
            sources: z.ZodArray<z.ZodObject<{
                from: z.ZodEnum<["extra", "env"]>;
                key: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                key: string;
                from: "extra" | "env";
            }, {
                key: string;
                from: "extra" | "env";
            }>, "many">;
            defaultValue: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }>, "many">>;
        thinkingMode: z.ZodOptional<z.ZodObject<{
            from: z.ZodLiteral<"extra">;
            key: z.ZodString;
            default: z.ZodEnum<["auto", "enabled", "disabled"]>;
        }, "strict", z.ZodTypeAny, {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        }, {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        }>>;
        defaultThinking: z.ZodOptional<z.ZodObject<{
            type: z.ZodLiteral<"enabled">;
            budget_tokens: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            type: "enabled";
            budget_tokens: number;
        }, {
            type: "enabled";
            budget_tokens: number;
        }>>;
        claudeCode: z.ZodOptional<z.ZodBoolean>;
        geminiOAuth: z.ZodOptional<z.ZodBoolean>;
        responsesApi: z.ZodOptional<z.ZodBoolean>;
        responsesStateless: z.ZodOptional<z.ZodBoolean>;
        responsesReasoningSummaryModels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        responsesReasoningFromThinking: z.ZodOptional<z.ZodBoolean>;
        responsesIncludeOrchestrationUsage: z.ZodOptional<z.ZodBoolean>;
        summaryModelDefault: z.ZodOptional<z.ZodString>;
        indexerDefaultModel: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    }, {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    }>>;
    request: z.ZodOptional<z.ZodObject<{
        auth: z.ZodOptional<z.ZodObject<{
            header: z.ZodString;
            valueTemplate: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            header: string;
            valueTemplate: string;
        }, {
            header: string;
            valueTemplate: string;
        }>>;
        headers: z.ZodOptional<z.ZodArray<z.ZodObject<{
            header: z.ZodString;
            value: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            value: string;
            header: string;
        }, {
            value: string;
            header: string;
        }>, "many">>;
        query: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        model: z.ZodOptional<z.ZodObject<{
            stripSuffix: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            map: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            template: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        }, {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        }>>;
        body: z.ZodOptional<z.ZodObject<{
            inject: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<any, z.ZodTypeDef, any>>>;
            remove: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strict", z.ZodTypeAny, {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        }, {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        }>>;
        response: z.ZodOptional<z.ZodObject<{
            reasoningDeltaKey: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            reasoningDeltaKey: string;
        }, {
            reasoningDeltaKey: string;
        }>>;
    }, "strict", z.ZodTypeAny, {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    }, {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    }>>;
    discovery: z.ZodOptional<z.ZodObject<{
        from: z.ZodEnum<["openai-models", "anthropic-models", "gemini-models", "openrouter-models", "cloudflare-models", "static"]>;
        modelsUrl: z.ZodOptional<z.ZodString>;
        queryParams: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        filterPrefixes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        requiredCapabilities: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        supportsModes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        accountIdFrom: z.ZodOptional<z.ZodObject<{
            sources: z.ZodArray<z.ZodObject<{
                from: z.ZodEnum<["extra", "env"]>;
                key: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                key: string;
                from: "extra" | "env";
            }, {
                key: string;
                from: "extra" | "env";
            }>, "many">;
            required: z.ZodOptional<z.ZodBoolean>;
            errorMessage: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }>>;
    }, "strict", z.ZodTypeAny, {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    }, {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    }>>;
    models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        contextWindow: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        canReason: z.ZodOptional<z.ZodBoolean>;
        supportsAttachments: z.ZodOptional<z.ZodBoolean>;
        inputModalities: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        supportedReasoningLevels: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodString, "many">>>;
        defaultReasoningLevel: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        applyPatchToolType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strict", z.ZodTypeAny, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }>>>;
    test: z.ZodOptional<z.ZodObject<{
        from: z.ZodEnum<["openai-models", "anthropic-models", "gemini-key", "unsupported"]>;
        fallbackBaseURL: z.ZodOptional<z.ZodString>;
        message: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        from: "openai-models" | "anthropic-models" | "gemini-key" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    }, {
        from: "openai-models" | "anthropic-models" | "gemini-key" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    }>>;
    auth: z.ZodOptional<z.ZodTypeAny>;
    config: z.ZodOptional<z.ZodObject<{
        fields: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            type: z.ZodEnum<["text", "password", "select", "toggle"]>;
            label: z.ZodString;
            storeIn: z.ZodEnum<["api_key", "base_url", "extra"]>;
            options: z.ZodOptional<z.ZodArray<z.ZodObject<{
                value: z.ZodString;
                label: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                value: string;
                label: string;
            }, {
                value: string;
                label: string;
            }>, "many">>;
            placeholder: z.ZodOptional<z.ZodString>;
            helpText: z.ZodOptional<z.ZodString>;
            optional: z.ZodOptional<z.ZodBoolean>;
            advanced: z.ZodOptional<z.ZodBoolean>;
            default: z.ZodOptional<z.ZodString>;
        }, "strict", z.ZodTypeAny, {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }, {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }>, "many">;
    }, "strict", z.ZodTypeAny, {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    }, {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    }>>;
}, "strict", z.ZodTypeAny, {
    kind: string;
    displayName: string;
    credKind: "api-key" | "oauth" | "aws";
    envVars: string[];
    defaultModels: string[];
    pricing: Record<string, {
        inputPer1M: number;
        outputPer1M: number;
    }>;
    wire: "openai-compat" | "anthropic" | "gemini" | "bedrock" | "codex" | "kimi";
    specVersion?: number | undefined;
    visual?: {
        icon: string;
        fg: string;
        bg: string;
    } | undefined;
    defaultBaseURL?: string | undefined;
    defaultModel?: string | undefined;
    pricingPriority?: number | undefined;
    capabilities?: {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    } | undefined;
    semantic?: {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    } | undefined;
    wireOpts?: {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    } | undefined;
    auth?: any;
    request?: {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    } | undefined;
    discovery?: {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    } | undefined;
    models?: Record<string, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }> | undefined;
    test?: {
        from: "openai-models" | "anthropic-models" | "gemini-key" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    } | undefined;
    config?: {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    } | undefined;
}, {
    kind: string;
    displayName: string;
    credKind: "api-key" | "oauth" | "aws";
    envVars: string[];
    defaultModels: string[];
    pricing: Record<string, {
        inputPer1M: number;
        outputPer1M: number;
    }>;
    wire: "openai-compat" | "anthropic" | "gemini" | "bedrock" | "codex" | "kimi";
    specVersion?: number | undefined;
    visual?: {
        icon: string;
        fg: string;
        bg: string;
    } | undefined;
    defaultBaseURL?: string | undefined;
    defaultModel?: string | undefined;
    pricingPriority?: number | undefined;
    capabilities?: {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    } | undefined;
    semantic?: {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    } | undefined;
    wireOpts?: {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    } | undefined;
    auth?: any;
    request?: {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    } | undefined;
    discovery?: {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    } | undefined;
    models?: Record<string, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }> | undefined;
    test?: {
        from: "openai-models" | "anthropic-models" | "gemini-key" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    } | undefined;
    config?: {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    } | undefined;
}>, {
    kind: string;
    displayName: string;
    credKind: "api-key" | "oauth" | "aws";
    envVars: string[];
    defaultModels: string[];
    pricing: Record<string, {
        inputPer1M: number;
        outputPer1M: number;
    }>;
    wire: "openai-compat" | "anthropic" | "gemini" | "bedrock" | "codex" | "kimi";
    specVersion?: number | undefined;
    visual?: {
        icon: string;
        fg: string;
        bg: string;
    } | undefined;
    defaultBaseURL?: string | undefined;
    defaultModel?: string | undefined;
    pricingPriority?: number | undefined;
    capabilities?: {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    } | undefined;
    semantic?: {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    } | undefined;
    wireOpts?: {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    } | undefined;
    auth?: any;
    request?: {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    } | undefined;
    discovery?: {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    } | undefined;
    models?: Record<string, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }> | undefined;
    test?: {
        from: "openai-models" | "anthropic-models" | "gemini-key" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    } | undefined;
    config?: {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    } | undefined;
}, {
    kind: string;
    displayName: string;
    credKind: "api-key" | "oauth" | "aws";
    envVars: string[];
    defaultModels: string[];
    pricing: Record<string, {
        inputPer1M: number;
        outputPer1M: number;
    }>;
    wire: "openai-compat" | "anthropic" | "gemini" | "bedrock" | "codex" | "kimi";
    specVersion?: number | undefined;
    visual?: {
        icon: string;
        fg: string;
        bg: string;
    } | undefined;
    defaultBaseURL?: string | undefined;
    defaultModel?: string | undefined;
    pricingPriority?: number | undefined;
    capabilities?: {
        zaiCodingMode?: boolean | undefined;
        supportsThinking?: boolean | undefined;
        supportsVision?: boolean | undefined;
        fileInput?: "text" | "native" | "pdf-only" | "model-dependent" | undefined;
        supportsImageGen?: boolean | undefined;
    } | undefined;
    semantic?: {
        embedding?: {
            protocol: "bedrock" | "openai-embeddings" | "cloudflare";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
        rerank?: {
            protocol: "bedrock" | "cloudflare" | "cohere-rerank" | "openai-rerank";
            defaultModels?: string[] | undefined;
            modelPatterns?: string[] | undefined;
        } | undefined;
    } | undefined;
    wireOpts?: {
        vendor?: "openai" | "openrouter" | "zai" | "deepseek" | "copilot" | "fugu" | "mistral" | undefined;
        baseUrlTemplate?: string | undefined;
        baseUrlVars?: Record<string, {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        }> | undefined;
        modelModes?: {
            map: Record<string, {
                baseURL: string;
            }>;
            envOverride?: string | undefined;
            defaultModeKey?: string | undefined;
        } | undefined;
        headerSources?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            header: string;
            defaultValue?: string | undefined;
        }[] | undefined;
        thinkingMode?: {
            key: string;
            from: "extra";
            default: "auto" | "enabled" | "disabled";
        } | undefined;
        defaultThinking?: {
            type: "enabled";
            budget_tokens: number;
        } | undefined;
        claudeCode?: boolean | undefined;
        geminiOAuth?: boolean | undefined;
        responsesApi?: boolean | undefined;
        responsesStateless?: boolean | undefined;
        responsesReasoningSummaryModels?: string[] | undefined;
        responsesReasoningFromThinking?: boolean | undefined;
        responsesIncludeOrchestrationUsage?: boolean | undefined;
        summaryModelDefault?: string | undefined;
        indexerDefaultModel?: string | undefined;
    } | undefined;
    auth?: any;
    request?: {
        auth?: {
            header: string;
            valueTemplate: string;
        } | undefined;
        headers?: {
            value: string;
            header: string;
        }[] | undefined;
        query?: Record<string, string> | undefined;
        model?: {
            map?: Record<string, string> | undefined;
            stripSuffix?: string[] | undefined;
            template?: string | undefined;
        } | undefined;
        body?: {
            inject?: Record<string, any> | undefined;
            remove?: string[] | undefined;
        } | undefined;
        response?: {
            reasoningDeltaKey: string;
        } | undefined;
    } | undefined;
    discovery?: {
        from: "openai-models" | "anthropic-models" | "gemini-models" | "openrouter-models" | "cloudflare-models" | "static";
        modelsUrl?: string | undefined;
        queryParams?: Record<string, string> | undefined;
        filterPrefixes?: string[] | undefined;
        requiredCapabilities?: string[] | undefined;
        supportsModes?: string[] | undefined;
        accountIdFrom?: {
            sources: {
                key: string;
                from: "extra" | "env";
            }[];
            required?: boolean | undefined;
            errorMessage?: string | undefined;
        } | undefined;
    } | undefined;
    models?: Record<string, {
        canReason?: boolean | undefined;
        contextWindow?: number | undefined;
        maxTokens?: number | undefined;
        supportsAttachments?: boolean | undefined;
        inputModalities?: string[] | undefined;
        supportedReasoningLevels?: string[] | null | undefined;
        defaultReasoningLevel?: string | null | undefined;
        applyPatchToolType?: string | null | undefined;
    }> | undefined;
    test?: {
        from: "openai-models" | "anthropic-models" | "gemini-key" | "unsupported";
        message?: string | undefined;
        fallbackBaseURL?: string | undefined;
    } | undefined;
    config?: {
        fields: {
            type: "text" | "password" | "select" | "toggle";
            key: string;
            label: string;
            storeIn: "extra" | "api_key" | "base_url";
            options?: {
                value: string;
                label: string;
            }[] | undefined;
            optional?: boolean | undefined;
            placeholder?: string | undefined;
            default?: string | undefined;
            helpText?: string | undefined;
            advanced?: boolean | undefined;
        }[];
    } | undefined;
}>;
//# sourceMappingURL=spec.schema.d.ts.map
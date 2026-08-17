# Desktop Product Boundaries

## Product role

CodeStudio Desktop is the local-first IDE product. It owns the Electron application, React workspace, local APIs, agents, indexer, provider runtime, plugin host and native agent runtime.

## Layers

| Layer | Roots | Responsibility |
| --- | --- | --- |
| Applications | `apps/*` | Executable entry points and transport composition |
| Agent platform | `packages/code-agent`, `packages/docs-agent`, `packages/candidate-pipeline`, `packages/orchestrator-host`, `packages/worker-pool` | Agent behavior and orchestration |
| Indexing | `packages/indexer`, `packages/session-storage` | Project understanding, retrieval and session persistence |
| Provider platform | `packages/provider-sdk`, `packages/provider-runtime`, `packages/provider-engine` | Provider contracts, adapters and execution |
| Plugin platform | `packages/plugin-sdk`, `packages/plugin-host`, `packages/plugin-market-client`, `packages/podman-core` | Plugin authoring, isolation and Market client |
| Contracts | `packages/api-bus`, `packages/agent-runtime-contracts`, `packages/company-contracts` | Stable process and package boundaries |
| Desktop infrastructure | `packages/secret-box`, `packages/vault-crypto`, `packages/db-drivers` | Technical capabilities without product policy |
| Native runtime | `native/agent-runtime` | Rust protocol, runner and supervisor |

## Dependency policy

Applications compose packages. Contract and SDK packages do not depend on hosts. Domain packages do not import application source. Cloud, Web and Unity source paths are forbidden in this repository. Integration with those products uses published contracts, HTTP, MCP or an explicitly versioned protocol.

## Transitional packages

`packages/shared`, `packages/services` and `packages/store` are migration surfaces, not preferred homes for new capabilities. Existing debt remains baseline-controlled. New code should use a domain-specific package, and extractions should reduce the baseline in focused commits.

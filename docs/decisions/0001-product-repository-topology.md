# ADR 0001: Product-oriented repository topology

- Status: Accepted
- Date: 2026-08-10

## Context

The former monorepo combined a desktop IDE, Cloud SaaS, Unity package and institutional site. Their deployment targets, release risks and ownership differ.

## Decision

Maintain four product repositories: `code-indexer` for CodeStudio Desktop, `codestudio-cloud`, `codestudio-unity` and `codestudio-web`. Each repository may remain an internal monorepo when its applications, services and packages share a release workflow. Repositories exchange only versioned network or package contracts.

## Consequences

Product releases and CI are independent. Source imports across repositories are prohibited. Shared behavior requires an explicit producer-owned contract rather than copied implementation code.

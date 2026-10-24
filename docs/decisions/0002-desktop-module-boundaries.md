# ADR 0002: Desktop module boundaries

- Status: Accepted
- Date: 2026-08-10

## Context

Desktop contains executable applications, reusable TypeScript packages and bundled plugins. A flat package list and generic packages make ownership and dependency direction unclear.

## Decision

Treat `apps`, `packages` and `extensions` as distinct layers. Record logical package groups in `docs/architecture/product-boundaries.md` before physical moves. Prevent new tracked product residues and new boundary violations with the repository checker. Migrate generic packages incrementally instead of performing a high-risk bulk move.

## Consequences

Current imports remain stable while new dependencies follow explicit ownership. Physical moves require focused validation and may only reduce architectural debt.

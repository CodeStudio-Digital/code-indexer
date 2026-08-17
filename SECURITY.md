# Security Policy

## Reporting

Report vulnerabilities privately through GitHub Security Advisories for `CodeStudio-Digital/code-indexer`. Do not open public issues containing credentials, exploit details or user data.

## Sensitive data

Never commit API keys, OAuth credentials, signing material, local `.env` files, `.dev.vars`, private keys, index databases or editor-local settings. Use the operating-system credential store and the repository's documented local configuration mechanisms.

## Supported code

Security fixes target the active release line and the current development branch. Plugin sandboxing, provider credentials, local process execution, MCP transports and update/release signing are security-sensitive areas and require focused tests and owner review.

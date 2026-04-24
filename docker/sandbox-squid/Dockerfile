# Egress proxy for the MCP sandbox network.
#
# Purpose: sandbox containers are attached to `mcp-sandbox-net` which
# has `internal: true` (no direct outbound). This squid container
# bridges them to the public internet, but ONLY for hosts matched by
# the allow-list in `squid.conf`. Everything else gets TCP_DENIED.
#
# Build:
#   docker build -t mcp-sandbox-squid:latest docker/sandbox-squid
#
# Run (typically by NetworkController.ensure() at first provision):
#   docker run -d --name mcp-sandbox-squid --network mcp-sandbox-net \
#     --restart=always mcp-sandbox-squid:latest
#
# Notes:
#   - We ship a minimal squid.conf with the npm/CDN allow-list baked in.
#     Operators who need extra hosts (e.g. private registries) mount
#     their own config at /etc/squid/squid.conf.
#   - HTTPS CONNECT is allowed for the allow-list hosts; no MITM, no
#     SSL bumping — the sandbox just tunnels TLS through us.

FROM ubuntu/squid:latest

COPY squid.conf /etc/squid/squid.conf

EXPOSE 3128

# Squid's own healthcheck is expensive; just verify the port binds.
HEALTHCHECK --interval=30s --timeout=3s CMD sh -c "nc -z 127.0.0.1 3128 || exit 1"

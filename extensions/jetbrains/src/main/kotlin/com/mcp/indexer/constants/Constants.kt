package com.mcp.indexer.constants

object Constants {
    const val DEFAULT_PORT = 3333
    const val DEFAULT_HOST = "localhost"
    const val SERVER_ENTRY_RELATIVE = "dist/apps/http-api/server.js"
    const val ENV_PORT_KEY = "MCP_INDEX_PORT"
    const val SERVER_START_TIMEOUT_MS = 15_000L
    const val SERVER_POLL_INTERVAL_MS = 500L
    const val STATUS_POLL_INTERVAL_MS = 5_000L
    const val SEARCH_DEBOUNCE_MS = 300L
    const val DEFAULT_PROVIDER = "anthropic"
    const val DEFAULT_MODEL = "claude-haiku-4-5-20251001"
}

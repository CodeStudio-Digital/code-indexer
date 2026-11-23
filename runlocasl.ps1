Set-Location D:\MCP
$env:MCP_DATA_DIR = Join-Path $env:USERPROFILE '.mcp-code-indexer'
$env:MCP_INDEX_DB = Join-Path $env:MCP_DATA_DIR 'index.db'
pnpm electron:dev
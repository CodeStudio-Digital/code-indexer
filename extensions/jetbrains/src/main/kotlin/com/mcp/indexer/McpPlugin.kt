package com.mcp.indexer

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.mcp.indexer.server.ServerManager
import com.mcp.indexer.settings.McpSettings

/**
 * Runs once per project open. Starts the MCP server if auto-start is enabled.
 */
class McpStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        if (McpSettings.getInstance().autoStartServer) {
            ServerManager.getInstance().ensureRunning(project)
        }
    }
}

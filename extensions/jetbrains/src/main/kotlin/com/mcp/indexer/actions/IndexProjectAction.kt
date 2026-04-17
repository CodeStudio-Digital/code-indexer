package com.mcp.indexer.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages
import com.mcp.indexer.constants.Constants
import com.mcp.indexer.server.ServerManager

class IndexProjectAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val rootPath = project.basePath ?: run {
            Messages.showErrorDialog(project, "Project has no base path.", "MCP Index")
            return
        }

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "MCP: Indexing project", false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.text = "Starting MCP server…"
                val manager = ServerManager.getInstance()
                manager.ensureRunning(project)

                val client = manager.client
                indicator.text = "Looking up project…"

                val existing = try { client.findProjectByPath(rootPath) } catch (_: Exception) { null }
                val mcpProject = existing ?: run {
                    indicator.text = "Creating project…"
                    client.createProject(rootPath, project.name)
                }

                indicator.text = "Starting indexing run…"
                client.indexProject(mcpProject.id, Constants.DEFAULT_PROVIDER, Constants.DEFAULT_MODEL)

                indicator.text = "Indexing started. Monitor progress in the status bar."
            }
        })
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project?.basePath != null
    }
}

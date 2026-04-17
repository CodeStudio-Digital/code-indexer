package com.mcp.indexer.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import com.mcp.indexer.constants.Constants
import com.mcp.indexer.server.ServerManager
import java.awt.event.MouseEvent
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class StatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = "McpStatusWidget"
    override fun getDisplayName() = "MCP Code Indexer"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project) = McpStatusWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) = widget.dispose()
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

class McpStatusWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {

    private var statusBar: StatusBar? = null
    private var text = "$(circle-slash) MCP Offline"
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "mcp-status-poll").apply { isDaemon = true }
    }
    private var pollTask: ScheduledFuture<*>? = null

    override fun ID() = "McpStatusWidget"

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        pollTask = scheduler.scheduleAtFixedRate(::poll, 0L, Constants.STATUS_POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    override fun dispose() {
        pollTask?.cancel(false)
        scheduler.shutdownNow()
        statusBar = null
    }

    override fun getText(): String = text

    override fun getAlignment() = 0.5f

    override fun getTooltipText() = "MCP Code Indexer — click to open chat"

    override fun getClickConsumer() = Consumer<MouseEvent> {
        ApplicationManager.getApplication().invokeLater {
            com.intellij.openapi.actionSystem.ActionManager.getInstance()
                .getAction("mcp.openChat")
                ?.actionPerformed(
                    com.intellij.openapi.actionSystem.AnActionEvent.createFromInputEvent(
                        it,
                        "",
                        null,
                        com.intellij.openapi.actionSystem.DataContext.EMPTY_CONTEXT,
                        false,
                        false
                    )
                )
        }
    }

    private fun poll() {
        val client = ServerManager.getInstance().client
        val alive = try { client.isAlive() } catch (_: Exception) { false }

        text = if (!alive) {
            "MCP Offline"
        } else {
            try {
                val projects = client.listProjects()
                val indexing = projects.any { it.lastIndexed == null }
                if (indexing) "MCP Indexing…" else "MCP :${ServerManager.getInstance().client.let { Constants.DEFAULT_PORT }}"
            } catch (_: Exception) {
                "MCP Connected"
            }
        }

        ApplicationManager.getApplication().invokeLater { statusBar?.updateWidget(ID()) }
    }
}

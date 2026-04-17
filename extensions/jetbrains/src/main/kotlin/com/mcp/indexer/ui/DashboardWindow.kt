package com.mcp.indexer.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import com.mcp.indexer.server.ServerManager
import com.mcp.indexer.settings.McpSettings
import javax.swing.JLabel
import javax.swing.JPanel

class DashboardWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = DashboardPanel(project)
        val content = ContentFactory.getInstance().createContent(panel.component, "", false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project) = true
}

class DashboardPanel(private val project: Project) {

    val component: javax.swing.JComponent by lazy { buildComponent() }

    private fun buildComponent(): javax.swing.JComponent {
        val port = McpSettings.getInstance().port
        return try {
            val browser = JBCefBrowser("http://localhost:$port")
            browser.component
        } catch (e: Exception) {
            // JCEF not available in some lightweight IDEs — fallback
            JPanel().apply {
                add(JLabel("JCEF not available. Open http://localhost:$port in your browser."))
            }
        }
    }

    fun reload() {
        // Browser reload logic
    }
}

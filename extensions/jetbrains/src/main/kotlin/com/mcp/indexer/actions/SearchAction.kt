package com.mcp.indexer.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBTextField
import com.mcp.indexer.server.SearchResult
import com.mcp.indexer.server.ServerManager
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.*

class SearchAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val client = ServerManager.getInstance().client

        val queryField = JBTextField().apply { preferredSize = Dimension(500, 30) }
        val resultModel = DefaultListModel<SearchResult>()
        val resultList = JBList(resultModel).apply {
            cellRenderer = SearchResultCellRenderer()
        }

        val panel = JPanel(BorderLayout(0, 4)).apply {
            preferredSize = Dimension(520, 340)
            add(queryField, BorderLayout.NORTH)
            add(JScrollPane(resultList), BorderLayout.CENTER)
        }

        val popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(panel, queryField)
            .setTitle("MCP: Search Codebase")
            .setResizable(true)
            .setMovable(true)
            .setFocusable(true)
            .setRequestFocus(true)
            .createPopup()

        var debounce: Timer? = null

        queryField.document.addDocumentListener(object : javax.swing.event.DocumentListener {
            override fun insertUpdate(e: javax.swing.event.DocumentEvent?) = enqueue()
            override fun removeUpdate(e: javax.swing.event.DocumentEvent?) = enqueue()
            override fun changedUpdate(e: javax.swing.event.DocumentEvent?) = enqueue()

            private fun enqueue() {
                debounce?.stop()
                debounce = Timer(300) {
                    val query = queryField.text.trim()
                    if (query.isEmpty()) { resultModel.clear(); return@Timer }
                    ProgressManager.getInstance().run(object : Task.Backgroundable(project, "MCP Search", false) {
                        override fun run(indicator: ProgressIndicator) {
                            val results = try { client.search(query) } catch (_: Exception) { emptyList() }
                            ApplicationManager.getApplication().invokeLater {
                                resultModel.clear()
                                results.forEach { resultModel.addElement(it) }
                            }
                        }
                    })
                }.apply { isRepeats = false; start() }
            }
        })

        resultList.addListSelectionListener {
            if (it.valueIsAdjusting) return@addListSelectionListener
            val selected = resultList.selectedValue ?: return@addListSelectionListener
            val path = selected.filePath ?: return@addListSelectionListener
            popup.closeOk(null)
            val vf = LocalFileSystem.getInstance().findFileByPath(path) ?: return@addListSelectionListener
            FileEditorManager.getInstance(project).openFile(vf, true)
        }

        popup.showCenteredInCurrentWindow(project)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

private class SearchResultCellRenderer : DefaultListCellRenderer() {
    override fun getListCellRendererComponent(
        list: JList<*>?, value: Any?, index: Int, isSelected: Boolean, cellHasFocus: Boolean,
    ): java.awt.Component {
        val result = value as? SearchResult
        val label = if (result != null) {
            val icon = if (result.type == "file") "📄" else "⚙️"
            val primary = result.filePath?.substringAfterLast('/') ?: result.name ?: "Unknown"
            val secondary = result.summary?.take(80) ?: ""
            "<html>$icon <b>$primary</b><br/><small>$secondary</small></html>"
        } else value?.toString() ?: ""
        return super.getListCellRendererComponent(list, label, index, isSelected, cellHasFocus)
    }
}

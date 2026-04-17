package com.mcp.indexer.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

class McpSettingsConfigurable : Configurable {

    private val portField = JBTextField(6)
    private val autoStartCheckbox = JBCheckBox("Auto-start server when IDE opens")
    private val binaryPathField = JBTextField()

    override fun getDisplayName() = "MCP Code Indexer"

    override fun createComponent(): JComponent {
        val settings = McpSettings.getInstance()
        portField.text = settings.port.toString()
        autoStartCheckbox.isSelected = settings.autoStartServer
        binaryPathField.text = settings.serverBinaryPath

        return FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Server port:"), portField)
            .addComponent(autoStartCheckbox)
            .addLabeledComponent(JBLabel("Server binary path (optional):"), binaryPathField)
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    override fun isModified(): Boolean {
        val settings = McpSettings.getInstance()
        return portField.text.toIntOrNull() != settings.port ||
            autoStartCheckbox.isSelected != settings.autoStartServer ||
            binaryPathField.text != settings.serverBinaryPath
    }

    override fun apply() {
        val settings = McpSettings.getInstance()
        portField.text.toIntOrNull()?.let { settings.port = it }
        settings.autoStartServer = autoStartCheckbox.isSelected
        settings.serverBinaryPath = binaryPathField.text.trim()
    }

    override fun reset() {
        val settings = McpSettings.getInstance()
        portField.text = settings.port.toString()
        autoStartCheckbox.isSelected = settings.autoStartServer
        binaryPathField.text = settings.serverBinaryPath
    }
}

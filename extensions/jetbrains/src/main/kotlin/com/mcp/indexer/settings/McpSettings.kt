package com.mcp.indexer.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.mcp.indexer.constants.Constants

@State(name = "McpSettings", storages = [Storage("McpCodeIndexer.xml")])
@Service(Service.Level.APP)
class McpSettings : PersistentStateComponent<McpSettings.State> {

    data class State(
        var port: Int = Constants.DEFAULT_PORT,
        var autoStartServer: Boolean = true,
        var serverBinaryPath: String = "",
    )

    private var state = State()

    override fun getState(): State = state
    override fun loadState(s: State) { state = s }

    var port: Int
        get() = state.port
        set(v) { state = state.copy(port = v) }

    var autoStartServer: Boolean
        get() = state.autoStartServer
        set(v) { state = state.copy(autoStartServer = v) }

    var serverBinaryPath: String
        get() = state.serverBinaryPath
        set(v) { state = state.copy(serverBinaryPath = v) }

    companion object {
        fun getInstance(): McpSettings =
            ApplicationManager.getApplication().getService(McpSettings::class.java)
    }
}

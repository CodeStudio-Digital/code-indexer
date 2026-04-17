package com.mcp.indexer.server

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.mcp.indexer.constants.Constants
import com.mcp.indexer.settings.McpSettings
import java.io.File

@Service(Service.Level.APP)
class ServerManager : Disposable {

    private val log = logger<ServerManager>()
    private var process: Process? = null
    val client = ApiClient()

    companion object {
        fun getInstance(): ServerManager =
            ApplicationManager.getApplication().getService(ServerManager::class.java)
    }

    fun ensureRunning(project: Project? = null) {
        if (client.isAlive()) return

        val serverPath = resolveServerPath(project) ?: run {
            log.warn("MCP server binary not found. Run `npm run build` in the MCP project.")
            return
        }

        val port = McpSettings.getInstance().port
        log.info("Starting MCP server on port $port…")

        val env = System.getenv().toMutableMap().apply {
            put(Constants.ENV_PORT_KEY, port.toString())
        }

        process = ProcessBuilder("node", serverPath)
            .redirectErrorStream(true)
            .apply { environment().putAll(env) }
            .start()

        // Log output asynchronously
        Thread({
            process?.inputStream?.bufferedReader()?.lines()?.forEach { log.info("[MCP] $it") }
        }, "mcp-server-log").apply { isDaemon = true }.start()

        waitForServer()
        log.info("MCP server ready on port $port.")
    }

    private fun resolveServerPath(project: Project?): String? {
        val manual = McpSettings.getInstance().serverBinaryPath
        if (manual.isNotBlank() && File(manual).exists()) return manual

        val baseDirs = listOfNotNull(
            project?.basePath,
        )
        return baseDirs
            .map { File(it, Constants.SERVER_ENTRY_RELATIVE) }
            .firstOrNull { it.exists() }
            ?.absolutePath
    }

    private fun waitForServer() {
        val deadline = System.currentTimeMillis() + Constants.SERVER_START_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (client.isAlive()) return
            Thread.sleep(Constants.SERVER_POLL_INTERVAL_MS)
        }
        log.warn("MCP server did not respond in time.")
    }

    override fun dispose() {
        process?.let {
            if (it.isAlive) {
                it.destroy()
                log.info("MCP server process terminated.")
            }
        }
        process = null
    }
}

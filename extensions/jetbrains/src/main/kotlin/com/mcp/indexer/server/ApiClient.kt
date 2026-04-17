package com.mcp.indexer.server

import com.mcp.indexer.constants.Constants
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class Project(
    val id: Int,
    val name: String,
    val rootPath: String,
    val lastIndexed: String?,
)

data class SearchResult(
    val type: String,
    val score: Double,
    val filePath: String?,
    val name: String?,
    val summary: String?,
    val kind: String?,
)

class ApiClient(
    private val host: String = Constants.DEFAULT_HOST,
    private val port: Int = Constants.DEFAULT_PORT,
) {
    private val json = "application/json; charset=utf-8".toMediaType()

    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val baseUrl get() = "http://$host:$port"

    fun isAlive(): Boolean = try {
        get("/api/projects")
        true
    } catch (_: Exception) {
        false
    }

    fun listProjects(): List<Project> {
        val obj = JSONObject(get("/api/projects"))
        return parseProjects(obj.optJSONArray("projects") ?: JSONArray())
    }

    fun findProjectByPath(rootPath: String): Project? =
        listProjects().find { it.rootPath == rootPath }

    fun createProject(rootPath: String, name: String): Project {
        val body = JSONObject().put("root_path", rootPath).put("name", name)
        val res = post("/api/projects", body)
        return parseProject(JSONObject(res))
    }

    fun indexProject(projectId: Int, provider: String, model: String) {
        val body = JSONObject().put("provider", provider).put("model", model)
        post("/api/projects/$projectId/index", body)
    }

    fun search(query: String, limit: Int = 20): List<SearchResult> {
        val res = get("/api/search?q=${encode(query)}&limit=$limit")
        val arr = JSONObject(res).optJSONArray("results") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val item = arr.getJSONObject(i)
            val data = item.optJSONObject("data") ?: JSONObject()
            SearchResult(
                type = item.optString("type", "file"),
                score = item.optDouble("score", 0.0),
                filePath = data.optString("path").ifBlank { null },
                name = data.optString("name").ifBlank { null },
                summary = data.optString("summary").ifBlank { null },
                kind = data.optString("kind").ifBlank { null },
            )
        }
    }

    private fun get(path: String): String {
        val request = Request.Builder().url("$baseUrl$path").get().build()
        return execute(request)
    }

    private fun post(path: String, body: JSONObject): String {
        val requestBody = body.toString().toRequestBody(json)
        val request = Request.Builder().url("$baseUrl$path").post(requestBody).build()
        return execute(request)
    }

    private fun execute(request: Request): String {
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}: ${request.url}")
            return response.body?.string() ?: "{}"
        }
    }

    private fun encode(value: String) = java.net.URLEncoder.encode(value, "UTF-8")

    private fun parseProjects(arr: JSONArray): List<Project> =
        (0 until arr.length()).map { parseProject(arr.getJSONObject(it)) }

    private fun parseProject(obj: JSONObject) = Project(
        id = obj.getInt("id"),
        name = obj.getString("name"),
        rootPath = obj.getString("root_path"),
        lastIndexed = obj.optString("last_indexed").ifBlank { null },
    )
}

package com.sven.linkdrop

import java.net.HttpURLConnection
import java.net.URL

data class HttpResult(
    val code: Int,
    val body: String,
    val error: String?,
)

object Http {
    fun post(
        endpoint: String,
        token: String,
        principal: String,
        idempotencyKey: String,
        json: String,
    ): HttpResult {
        val body = json.toByteArray(Charsets.UTF_8)
        val signature = Hmac.sha256Hex(body, token)
        var connection: HttpURLConnection? = null
        return try {
            val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 20_000
                instanceFollowRedirects = true
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "LinkDrop/1.0 (Android)")
                setRequestProperty("Idempotency-Key", idempotencyKey)
                setRequestProperty("X-LinkDrop-Principal", principal)
                if (signature.isNotBlank()) {
                    setRequestProperty("X-Webhook-Token", signature)
                }
            }
            connection = conn

            conn.outputStream.use { output ->
                output.write(body)
            }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            HttpResult(code, body.take(500), null)
        } catch (e: Exception) {
            HttpResult(-1, "", e.message ?: e.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }
}

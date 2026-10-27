package com.sven.linkdrop

import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

class HttpTest {

    @Test
    fun postsBodyAndSignsIt() {
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        var receivedBody = ""
        var receivedSignature = ""
        var receivedPrincipal = ""

        val serverThread = thread {
            server.accept().use { socket ->
                val reader = socket.getInputStream().bufferedReader()
                reader.readLine()
                val headers = mutableMapOf<String, String>()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    val separator = line.indexOf(':')
                    if (separator > 0) {
                        headers[line.substring(0, separator).trim().lowercase()] =
                            line.substring(separator + 1).trim()
                    }
                }

                val length = headers["content-length"]?.toIntOrNull() ?: 0
                val chars = CharArray(length)
                var read = 0
                while (read < length) {
                    val count = reader.read(chars, read, length - read)
                    if (count < 0) break
                    read += count
                }

                receivedBody = String(chars, 0, read)
                receivedSignature = headers["x-webhook-token"] ?: ""
                receivedPrincipal = headers["x-linkdrop-principal"] ?: ""

                socket.getOutputStream().write(
                    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .toByteArray(Charsets.UTF_8),
                )
                socket.getOutputStream().flush()
            }
        }

        try {
            val body = """{"id":"id-1","url":"https://example.com"}"""
            val result = Http.post(
                endpoint = "http://127.0.0.1:${server.localPort}/",
                token = "secret",
                principal = "principal-1",
                idempotencyKey = "id-1",
                json = body,
            )

            assertEquals(200, result.code)
            assertEquals(body, receivedBody)
            assertEquals(
                Hmac.sha256Hex(body.toByteArray(Charsets.UTF_8), "secret"),
                receivedSignature,
            )
            assertEquals("principal-1", receivedPrincipal)
        } finally {
            server.close()
            serverThread.join(5_000)
        }
    }
}

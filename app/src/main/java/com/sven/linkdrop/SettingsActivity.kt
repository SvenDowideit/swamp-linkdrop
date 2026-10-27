package com.sven.linkdrop

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import org.json.JSONObject
import java.net.URI
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors

class SettingsActivity : Activity() {

    private lateinit var prefs: Prefs
    private lateinit var endpoint: EditText
    private lateinit var status: TextView
    private lateinit var queueSummary: TextView
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        prefs = Prefs(this)
        endpoint = findViewById(R.id.endpoint)
        status = findViewById(R.id.status)
        queueSummary = findViewById(R.id.queue_summary)

        endpoint.setText(prefs.endpoint)

        QueueDb.get(this).resetInflight()
        DeliveryWorker.enqueueAllPending(this)
        ShortcutPublisher.publish(this)

        findViewById<Button>(R.id.save).setOnClickListener {
            saveSettings(showStatus = true)
        }
        findViewById<Button>(R.id.test).setOnClickListener {
            testReceiver()
        }
        findViewById<Button>(R.id.retry_all).setOnClickListener {
            DeliveryWorker.retryAll(this)
            status.setText(R.string.status_retry)
            refreshQueue()
        }
        findViewById<Button>(R.id.clear_sent).setOnClickListener {
            QueueDb.get(this).deleteSent()
            status.setText(R.string.status_cleared)
            refreshQueue()
        }

        refreshQueue()
    }

    override fun onResume() {
        super.onResume()
        if (::queueSummary.isInitialized) refreshQueue()
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun saveSettings(showStatus: Boolean): Boolean {
        val rawEndpoint = endpoint.text.toString().trim()
        if (rawEndpoint.isNotEmpty() && !isValidHttpsUrl(rawEndpoint)) {
            status.setText(R.string.status_invalid_url)
            return false
        }

        prefs.endpoint = rawEndpoint
        endpoint.setText(prefs.endpoint)

        if (showStatus) status.setText(R.string.status_saved)
        DeliveryWorker.enqueueAllPending(this)
        return true
    }

    private fun testReceiver() {
        if (!saveSettings(showStatus = false)) return

        val target = prefs.endpoint
        val principal = prefs.principal
        status.setText(R.string.status_testing)

        io.execute {
            val payload = JSONObject().apply {
                put("id", UUID.randomUUID().toString())
                put("url", "https://example.com/linkdrop-test")
                put("title", "LinkDrop test")
                put("text", "LinkDrop test https://example.com/linkdrop-test")
                put("principal", principal)
                put("source", "linkdrop-test")
                put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
                put("sharedAt", Instant.now().toString())
            }.toString()

            val result = Http.post(
                endpoint = target,
                principal = principal,
                idempotencyKey = UUID.randomUUID().toString(),
                json = payload,
            )

            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                status.text = if (result.code in 200..299) {
                    getString(R.string.status_test_ok, result.code)
                } else {
                    getString(
                        R.string.status_test_failed,
                        result.error ?: "HTTP ${result.code}",
                    )
                }
            }
        }
    }

    private fun refreshQueue() {
        val stats = QueueDb.get(this).stats()
        queueSummary.text = getString(
            R.string.queue_summary,
            stats.pending,
            stats.failed,
            stats.sent,
        )
    }

    private fun isValidHttpsUrl(value: String): Boolean {
        return try {
            val uri = URI(value)
            uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()
        } catch (_: Exception) {
            false
        }
    }
}

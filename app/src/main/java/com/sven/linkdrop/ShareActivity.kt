package com.sven.linkdrop

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import java.util.UUID

class ShareActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val incoming = intent ?: run {
            finish()
            return
        }
        if (incoming.action != Intent.ACTION_SEND) {
            finish()
            return
        }

        val text = incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            ?: incoming.getStringExtra(Intent.EXTRA_TEXT)
        val url = LinkExtractor.firstUrl(text)
        if (url == null) {
            Toast.makeText(this, R.string.no_url_toast, Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        val title = incoming.getStringExtra(Intent.EXTRA_SUBJECT)
            ?: incoming.getStringExtra(Intent.EXTRA_TITLE)
        val prefs = Prefs(this)
        val share = Share(
            id = UUID.randomUUID().toString(),
            principal = prefs.principal,
            url = url,
            title = title,
            text = text ?: url,
            device = "${Build.MANUFACTURER} ${Build.MODEL}",
            sharedAt = System.currentTimeMillis(),
            status = QueueDb.STATUS_PENDING,
            attempts = 0,
            lastError = null,
            lastStatus = null,
        )

        try {
            QueueDb.get(this).insert(share)
            DeliveryWorker.enqueue(this, share.id)
            Toast.makeText(this, R.string.queued_toast, Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {
            Toast.makeText(this, R.string.status_queue_failed, Toast.LENGTH_SHORT).show()
        }

        finish()
    }
}

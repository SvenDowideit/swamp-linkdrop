package com.sven.linkdrop

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

class DeliveryWorker(
    appContext: Context,
    params: WorkerParameters,
) : Worker(appContext, params) {

    override fun doWork(): Result {
        val id = inputData.getString(KEY_ID) ?: return Result.failure()
        val db = QueueDb.get(applicationContext)
        val share = db.get(id) ?: return Result.success()

        if (share.status == QueueDb.STATUS_SENT || share.status == QueueDb.STATUS_FAILED) {
            return Result.success()
        }

        val prefs = Prefs(applicationContext)
        val payload = JSONObject().apply {
            put("id", share.id)
            put("url", share.url)
            put("title", share.title ?: "")
            put("text", share.text)
            put("principal", share.principal)
            put("source", "android-share")
            put("device", share.device)
            put("sharedAt", Instant.ofEpochMilli(share.sharedAt).toString())
        }.toString()

        db.markInflight(id)
        val result = Http.post(
            endpoint = prefs.endpoint,
            token = prefs.token,
            principal = share.principal,
            idempotencyKey = share.id,
            json = payload,
        )

        if (result.code in 200..299) {
            db.markSent(id, result.code)
            return Result.success()
        }

        val error = result.error ?: "HTTP ${result.code}: ${result.body.take(200)}"
        val permanent = result.code in 400..499 &&
            result.code != 408 &&
            result.code != 429
        if (permanent) {
            db.markFailed(id, error, result.code)
            return Result.failure()
        }

        val attempts = db.markAttempt(id, error, result.code)
        if (attempts >= MAX_ATTEMPTS) {
            db.markFailed(id, error, result.code)
            return Result.failure()
        }
        return Result.retry()
    }

    companion object {
        const val KEY_ID = "share_id"
        const val MAX_ATTEMPTS = 30
        private const val TAG = "linkdrop-delivery"

        fun enqueue(context: Context, id: String, replace: Boolean = false) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = OneTimeWorkRequestBuilder<DeliveryWorker>()
                .setInputData(workDataOf(KEY_ID to id))
                .setConstraints(constraints)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    30,
                    TimeUnit.SECONDS,
                )
                .addTag(TAG)
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                "share-$id",
                if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                request,
            )
        }

        fun enqueueAllPending(context: Context) {
            QueueDb.get(context).pendingIds().forEach { enqueue(context, it) }
        }

        fun retryAll(context: Context) {
            val db = QueueDb.get(context)
            db.resetFailed()
            db.pendingIds().forEach { enqueue(context, it, replace = true) }
        }
    }
}

package com.sven.linkdrop

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class Share(
    val id: String,
    val principal: String,
    val url: String,
    val title: String?,
    val text: String,
    val device: String,
    val sharedAt: Long,
    val status: String,
    val attempts: Int,
    val lastError: String?,
    val lastStatus: Int?,
)

data class QueueStats(
    val pending: Int,
    val failed: Int,
    val sent: Int,
)

class QueueDb private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS shares (
                id TEXT PRIMARY KEY,
                principal TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT,
                text TEXT NOT NULL,
                device TEXT NOT NULL,
                shared_at INTEGER NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_status INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_shares_status ON shares(status, created_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        onCreate(db)
    }

    fun insert(share: Share) {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put("id", share.id)
            put("principal", share.principal)
            put("url", share.url)
            put("title", share.title)
            put("text", share.text)
            put("device", share.device)
            put("shared_at", share.sharedAt)
            put("status", share.status)
            put("attempts", share.attempts)
            put("last_error", share.lastError)
            put("last_status", share.lastStatus)
            put("created_at", now)
            put("updated_at", now)
        }
        writableDatabase.insertOrThrow("shares", null, values)
    }

    fun get(id: String): Share? {
        readableDatabase.query(
            "shares",
            null,
            "id = ?",
            arrayOf(id),
            null,
            null,
            null,
        ).use { cursor ->
            return if (cursor.moveToFirst()) cursor.toShare() else null
        }
    }

    fun pendingIds(): List<String> {
        readableDatabase.query(
            "shares",
            arrayOf("id"),
            "status IN (?, ?)",
            arrayOf(STATUS_PENDING, STATUS_INFLIGHT),
            null,
            null,
            "created_at ASC",
        ).use { cursor ->
            val ids = ArrayList<String>(cursor.count)
            while (cursor.moveToNext()) ids.add(cursor.getString(0))
            return ids
        }
    }

    fun markInflight(id: String) {
        updateStatus(id, STATUS_INFLIGHT)
    }

    fun markSent(id: String, httpStatus: Int) {
        val values = ContentValues().apply {
            put("status", STATUS_SENT)
            put("last_status", httpStatus)
            putNull("last_error")
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.update("shares", values, "id = ?", arrayOf(id))
    }

    fun markAttempt(id: String, error: String, httpStatus: Int): Int {
        val db = writableDatabase
        db.beginTransaction()
        return try {
            val attempts = db.query(
                "shares",
                arrayOf("attempts"),
                "id = ?",
                arrayOf(id),
                null,
                null,
                null,
            ).use { cursor ->
                if (cursor.moveToFirst()) cursor.getInt(0) else 0
            } + 1

            val values = ContentValues().apply {
                put("status", STATUS_PENDING)
                put("attempts", attempts)
                put("last_error", error)
                if (httpStatus > 0) put("last_status", httpStatus) else putNull("last_status")
                put("updated_at", System.currentTimeMillis())
            }
            db.update("shares", values, "id = ?", arrayOf(id))
            db.setTransactionSuccessful()
            attempts
        } finally {
            db.endTransaction()
        }
    }

    fun markFailed(id: String, error: String, httpStatus: Int) {
        val values = ContentValues().apply {
            put("status", STATUS_FAILED)
            put("last_error", error)
            if (httpStatus > 0) put("last_status", httpStatus) else putNull("last_status")
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.update("shares", values, "id = ?", arrayOf(id))
    }

    fun resetFailed(): Int {
        val values = ContentValues().apply {
            put("status", STATUS_PENDING)
            put("attempts", 0)
            putNull("last_error")
            putNull("last_status")
            put("updated_at", System.currentTimeMillis())
        }
        return writableDatabase.update(
            "shares",
            values,
            "status = ?",
            arrayOf(STATUS_FAILED),
        )
    }

    fun resetInflight(): Int {
        val values = ContentValues().apply {
            put("status", STATUS_PENDING)
            put("updated_at", System.currentTimeMillis())
        }
        return writableDatabase.update(
            "shares",
            values,
            "status = ?",
            arrayOf(STATUS_INFLIGHT),
        )
    }

    fun deleteSent(): Int {
        return writableDatabase.delete("shares", "status = ?", arrayOf(STATUS_SENT))
    }

    fun stats(): QueueStats {
        val db = readableDatabase
        return QueueStats(
            pending = count(db, STATUS_PENDING) + count(db, STATUS_INFLIGHT),
            failed = count(db, STATUS_FAILED),
            sent = count(db, STATUS_SENT),
        )
    }

    private fun count(db: SQLiteDatabase, status: String): Int {
        return DatabaseUtils.queryNumEntries(
            db,
            "shares",
            "status = ?",
            arrayOf(status),
        ).toInt()
    }

    private fun updateStatus(id: String, status: String) {
        val values = ContentValues().apply {
            put("status", status)
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.update("shares", values, "id = ?", arrayOf(id))
    }

    private fun Cursor.toShare(): Share {
        return Share(
            id = getString(getColumnIndexOrThrow("id")),
            principal = getString(getColumnIndexOrThrow("principal")),
            url = getString(getColumnIndexOrThrow("url")),
            title = textOrNull("title"),
            text = getString(getColumnIndexOrThrow("text")),
            device = getString(getColumnIndexOrThrow("device")),
            sharedAt = getLong(getColumnIndexOrThrow("shared_at")),
            status = getString(getColumnIndexOrThrow("status")),
            attempts = getInt(getColumnIndexOrThrow("attempts")),
            lastError = textOrNull("last_error"),
            lastStatus = intOrNull("last_status"),
        )
    }

    private fun Cursor.textOrNull(column: String): String? {
        val index = getColumnIndexOrThrow(column)
        return if (isNull(index)) null else getString(index)
    }

    private fun Cursor.intOrNull(column: String): Int? {
        val index = getColumnIndexOrThrow(column)
        return if (isNull(index)) null else getInt(index)
    }

    companion object {
        const val STATUS_PENDING = "pending"
        const val STATUS_INFLIGHT = "inflight"
        const val STATUS_SENT = "sent"
        const val STATUS_FAILED = "failed"

        private const val DB_NAME = "linkdrop.db"
        private const val DB_VERSION = 1

        @Volatile
        private var instance: QueueDb? = null

        fun get(context: Context): QueueDb {
            return instance ?: synchronized(this) {
                instance ?: QueueDb(context).also { instance = it }
            }
        }
    }
}

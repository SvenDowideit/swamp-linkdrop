package com.sven.linkdrop

import android.content.Context
import android.provider.Settings
import java.util.UUID

class Prefs(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("linkdrop", Context.MODE_PRIVATE)

    var endpoint: String
        get() = prefs.getString(KEY_ENDPOINT, null)
            ?.takeIf { it.isNotBlank() }
            ?: BuildConfig.LINKDROP_ENDPOINT
        set(value) {
            prefs.edit().putString(KEY_ENDPOINT, value.trim()).apply()
        }

    var token: String
        get() = Crypto.decrypt(prefs.getString(KEY_TOKEN, "") ?: "")
        set(value) {
            prefs.edit().putString(KEY_TOKEN, Crypto.encrypt(value.trim())).apply()
        }

    val principal: String
        get() {
            prefs.getString(KEY_PRINCIPAL, null)?.takeIf { it.isNotBlank() }?.let {
                return it
            }

            val androidId = Settings.Secure.getString(
                appContext.contentResolver,
                Settings.Secure.ANDROID_ID,
            )
            val id = androidId
                ?.takeIf { it.isNotBlank() && it != "9774d56d682e549c" }
                ?: UUID.randomUUID().toString()
            prefs.edit().putString(KEY_PRINCIPAL, id).apply()
            return id
        }

    private companion object {
        const val KEY_ENDPOINT = "endpoint"
        const val KEY_TOKEN = "token"
        const val KEY_PRINCIPAL = "principal"
    }
}

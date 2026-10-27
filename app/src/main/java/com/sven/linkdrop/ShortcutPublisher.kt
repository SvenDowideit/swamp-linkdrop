package com.sven.linkdrop

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build

object ShortcutPublisher {
    fun publish(context: Context) {
        try {
            val manager = context.getSystemService(Context.SHORTCUT_SERVICE) as ShortcutManager
            val intent = Intent(context, ShareActivity::class.java).apply {
                action = Intent.ACTION_SEND
                type = "text/plain"
            }
            val builder = ShortcutInfo.Builder(context, "linkdrop-share")
                .setShortLabel(context.getString(R.string.share_short_label))
                .setLongLabel(context.getString(R.string.share_label))
                .setIcon(Icon.createWithResource(context, R.drawable.ic_linkdrop))
                .setCategories(setOf("com.sven.linkdrop.share"))
                .setIntent(intent)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setLongLived(true)
            }

            manager.pushDynamicShortcut(builder.build())
        } catch (_: Exception) {
            // Direct Share placement is best-effort; the normal share target still works.
        }
    }
}

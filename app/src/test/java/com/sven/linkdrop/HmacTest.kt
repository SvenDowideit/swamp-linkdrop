package com.sven.linkdrop

import org.junit.Assert.assertEquals
import org.junit.Test

class HmacTest {

    @Test
    fun matchesKnownSha256Vector() {
        val body = """
            {"id":"wh-hmac-1","url":"https://example.com/webhook","title":"Webhook","text":"Webhook https://example.com/webhook","principal":"webhook-test","source":"android-share","device":"curl","sharedAt":"2026-10-27T09:00:00Z"}
        """.trimIndent()
        assertEquals(
            "f858983bb02821207ce99283b3f9194f32ba91f4952e9f8853b78af25016ab64",
            Hmac.sha256Hex(body.toByteArray(Charsets.UTF_8), "test-token"),
        )
    }
}

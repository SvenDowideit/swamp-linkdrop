package com.sven.linkdrop

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Hmac {
    fun sha256Hex(body: ByteArray, secret: String): String {
        if (secret.isEmpty()) return ""
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(body).joinToString("") { byte -> "%02x".format(byte) }
    }
}

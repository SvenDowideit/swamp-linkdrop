package com.sven.linkdrop

object LinkExtractor {
    private val URL_REGEX = Regex("""https?://[^\s<>"']+""", RegexOption.IGNORE_CASE)

    fun firstUrl(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val match = URL_REGEX.find(text)?.value ?: return null
        var url = match.trimEnd('.', ',', ';', ':', '!', '?', '\'', '"')
        while (url.endsWith(")") && url.count { it == ')' } > url.count { it == '(' }) {
            url = url.dropLast(1)
        }
        return url.takeIf { it.length > "https://".length }
    }
}

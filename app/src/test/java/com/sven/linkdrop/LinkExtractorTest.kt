package com.sven.linkdrop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinkExtractorTest {

    @Test
    fun findsBareUrl() {
        assertEquals(
            "https://example.com/path?q=1",
            LinkExtractor.firstUrl("https://example.com/path?q=1"),
        )
    }

    @Test
    fun findsUrlAfterTitle() {
        assertEquals(
            "https://example.com/article",
            LinkExtractor.firstUrl("A useful article\nhttps://example.com/article"),
        )
    }

    @Test
    fun takesFirstOfSeveral() {
        assertEquals(
            "https://first.example/a",
            LinkExtractor.firstUrl("https://first.example/a and https://second.example/b"),
        )
    }

    @Test
    fun trimsTrailingPunctuation() {
        assertEquals(
            "https://example.com/a",
            LinkExtractor.firstUrl("See https://example.com/a)."),
        )
    }

    @Test
    fun keepsBalancedParentheses() {
        assertEquals(
            "https://en.wikipedia.org/wiki/Foo_(bar)",
            LinkExtractor.firstUrl("https://en.wikipedia.org/wiki/Foo_(bar)"),
        )
    }

    @Test
    fun rejectsTextWithoutUrl() {
        assertNull(LinkExtractor.firstUrl("no link here"))
        assertNull(LinkExtractor.firstUrl(""))
        assertNull(LinkExtractor.firstUrl(null))
    }
}

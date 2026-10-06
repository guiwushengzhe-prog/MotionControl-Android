package cn.motioncontrol.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

public class ListingDigestTest {
    private static String repeat(String text, int count) {
        StringBuilder out = new StringBuilder();
        for (int index = 0; index < count; index++) out.append(text);
        return out.toString();
    }

    @Test
    public void matchesThePcFormula() {
        // 电脑端 _listing_digest 对同一份清单算出来的值。
        String digest = new ListingDigest()
                .add("index.html", 12, repeat("ab", 32))
                .add("assets/中文.js", 0, repeat("cd", 32))
                .hex();
        assertEquals("abf7521f0e4efe9327a3e61a0c13f5d14f89c79eaec1bb39ef2114fb5a43c5f3", digest);
    }

    @Test
    public void anyChangeToTheListingChangesTheDigest() {
        String original = new ListingDigest().add("index.html", 12, repeat("ab", 32)).hex();
        assertNotEquals(original, new ListingDigest().add("index.html", 13, repeat("ab", 32)).hex());
        assertNotEquals(original, new ListingDigest().add("evil.html", 12, repeat("ab", 32)).hex());
        assertNotEquals(original, new ListingDigest().add("index.html", 12, repeat("ef", 32)).hex());
    }
}

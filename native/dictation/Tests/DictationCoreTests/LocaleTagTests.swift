import XCTest
@testable import DictationCore

/// Same strings as `localeAccepts` / `localeRejects` in electron/dictation.test.mjs.
final class LocaleTagTests: XCTestCase {
    private let accepts = [
        "en", "fr", "yue", "fr-FR", "en-US", "yue-CN", "zh-Hans", "zh-Hans-CN", "zh-Hant-HK",
        "en-US-posix", "en-US-posix-variant", "sr-Latn-RS", "es-419",
    ]
    private let rejects = [
        "", "FR", "fr_FR", "fr-FR;rm -rf", "--locale", "fr-FR\n", "en-US-posix-variant-extra",
        "a", "abcd", "en-", "en-U", "en-123456789", "Fr-FR", "en US", "en\n", "i-en", "en-US-x-private",
    ]

    func testPatternMatchesTheJavaScriptLocale() {
        XCTAssertEqual(LocaleTag.pattern, "^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$")
    }

    func testAcceptsTheSharedTags() {
        for tag in accepts {
            XCTAssertTrue(LocaleTag.isValid(tag), tag)
        }
    }

    func testRejectsTheSharedTags() {
        for tag in rejects {
            XCTAssertFalse(LocaleTag.isValid(tag), tag)
        }
    }
}

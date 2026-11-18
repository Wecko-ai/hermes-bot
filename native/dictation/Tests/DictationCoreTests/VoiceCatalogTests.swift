import XCTest
@testable import DictationCore

final class VoiceCatalogTests: XCTestCase {
    private func voice(_ name: String, _ language: String, _ quality: SpeechVoiceQuality) -> SpeechVoice {
        SpeechVoice(id: "id.\(name)", name: name, language: language, quality: quality)
    }

    func testOnlyFrenchAndEnglish() {
        let kept = VoiceCatalog.select([
            voice("Thomas", "fr-FR", .standard), voice("Daniel", "en-GB", .standard),
            voice("Kyoko", "ja-JP", .standard), voice("Filipino", "fil-PH", .standard), voice("Plain", "en", .standard),
        ])
        XCTAssertEqual(Set(kept.map(\.name)), ["Thomas", "Daniel", "Plain"])
    }

    func testOrderQualityThenLanguageThenName() {
        let sorted = VoiceCatalog.select([
            voice("Zoe", "en-US", .standard), voice("Amelie", "fr-CA", .premium), voice("Daniel", "en-GB", .enhanced),
            voice("Alex", "en-US", .standard), voice("Thomas", "fr-FR", .premium), voice("Aaron", "en-GB", .premium),
        ])
        XCTAssertEqual(sorted.map(\.name), ["Aaron", "Amelie", "Thomas", "Daniel", "Alex", "Zoe"])
    }

    func testLine() {
        XCTAssertEqual(VoiceCatalog.line([voice("Daniel", "en-GB", .enhanced)]),
                       #"{"voices":[{"id":"id.Daniel","name":"Daniel","language":"en-GB","quality":"enhanced"}]}"#)
        XCTAssertEqual(VoiceCatalog.line([]), #"{"voices":[]}"#)
    }
}

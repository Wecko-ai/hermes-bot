import XCTest
@testable import DictationCore

final class TranscriptMergerTests: XCTestCase {
    /// Feeds results as (text, seconds since the previous one) and returns every transcript sent.
    private func run(_ results: [(String, TimeInterval)]) -> [String] {
        var merger = TranscriptMerger()
        return results.map { merger.update($0.0, gap: $0.1) }
    }

    func testRecognizerThatKeepsEverythingIsLeftAlone() {
        let sent = run([("Bonjour", 0.2), ("Bonjour il", 0.2), ("Bonjour, il faut", 0.2), ("Bonjour, il faut partir. Demain", 1.6)])
        XCTAssertEqual(sent.last, "Bonjour, il faut partir. Demain")
    }

    func testRestartAfterPauseKeepsTheFirstSentence() {
        let sent = run([
            ("Première", 0.3), ("Première phrase de test", 0.3), ("Première phrase de test.", 0.4),
            ("Deuxième", 2.4), ("Deuxième phrase après", 0.3), ("Deuxième phrase après une pause.", 1.0),
        ])
        XCTAssertEqual(sent, [
            "Première", "Première phrase de test", "Première phrase de test.",
            "Première phrase de test. Deuxième", "Première phrase de test. Deuxième phrase après",
            "Première phrase de test. Deuxième phrase après une pause.",
        ])
    }

    func testEnglishRestartAndSeveralPauses() {
        let sent = run([("First test sentence.", 0.3), ("Second", 3.0), ("Second sentence after a pause.", 0.3), ("And a third", 2.0)])
        XCTAssertEqual(sent.last, "First test sentence. Second sentence after a pause. And a third")
    }

    func testFinalResultGatheringEverySegmentIsNotDuplicated() {
        let sent = run([("Première phrase.", 0.3), ("Deuxième", 2.0), ("Première phrase. Deuxième phrase.", 1.5)])
        XCTAssertEqual(sent.last, "Première phrase. Deuxième phrase.")
    }

    func testRevisionWhileSpeakingIsNoRestart() {
        XCTAssertEqual(run([("Je veux", 0.2), ("Jeux vidéo", 0.1)]).last, "Jeux vidéo")
        XCTAssertEqual(run([("Il faudra", 0.2), ("Il faut", 0.2)]).last, "Il faut")
    }

    func testPunctuationAddedAfterPauseIsNoRestart() {
        XCTAssertEqual(run([("Première phrase de test", 0.3), ("Première phrase de test.", 1.5)]).last, "Première phrase de test.")
    }

    func testNewSentenceStartingWithTheSameWord() {
        XCTAssertEqual(run([("Je pense que oui.", 0.3), ("Je", 2.0), ("Je veux partir", 0.3)]).last, "Je pense que oui. Je veux partir")
    }

    func testEmptyResultKeepsWhatIsShown() {
        XCTAssertEqual(run([("Bonjour", 0.3), ("", 1.0), ("  ", 0.5), ("Encore", 2.0)]), ["Bonjour", "Bonjour", "Bonjour", "Bonjour Encore"])
    }

    func testWhatCameBeforeARestartNeverShrinks() {
        var merger = TranscriptMerger()
        merger.update("Première phrase.", gap: 0.3)
        merger.update("Deuxième", gap: 2.0)
        merger.update("Deuxièmement", gap: 0.2)
        XCTAssertEqual(merger.committed, "Première phrase.")
        XCTAssertTrue(merger.transcript.hasPrefix("Première phrase."))
    }
}

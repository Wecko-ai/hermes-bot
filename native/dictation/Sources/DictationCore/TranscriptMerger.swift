import Foundation

/// The whole transcript of a dictation, from the recognizer's successive results.
///
/// Each result carries the recognizer's best transcription so far. On some system versions that transcription
/// starts over after a pause in the speech: it then holds only the words said since the pause, and sent as is,
/// the first sentence would vanish from the field. This keeps the text from before such a restart, and tells a
/// restart apart from the recognizer merely revising its last words, which it does while the speech goes on.
/// A recognizer that keeps the whole text is left alone: its results always start with what was said before.
///
/// What came before a restart is never shortened; the current segment may still be revised by the recognizer.
public struct TranscriptMerger {
    /// Silence before a result, in seconds, from which a new start of the transcription may be a restart.
    /// Revisions arrive while the speech goes on, a few hundred milliseconds apart.
    public static let restartGap: TimeInterval = 0.8

    /// Segments the recognizer no longer reports.
    public private(set) var committed = ""
    private var last = ""

    public init() {}

    /// The whole transcript so far.
    public var transcript: String { Self.join(committed, last) }

    /// The whole transcript after one more result. `gap`: seconds since the previous result.
    @discardableResult
    public mutating func update(_ result: String, gap: TimeInterval) -> String {
        let text = result.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty result says nothing new: what is shown stays.
        guard !text.isEmpty else { return transcript }
        if gap >= Self.restartGap && Self.isRestart(from: last, to: text) {
            committed = Self.join(committed, last)
        }
        last = text
        // A result that already holds the earlier segments (a final result gathering them) stands alone.
        if !committed.isEmpty && Self.words(text).starts(with: Self.words(committed)) { committed = "" }
        return transcript
    }

    /// Whether `next` starts a new segment rather than revising `previous`.
    static func isRestart(from previous: String, to next: String) -> Bool {
        let before = words(previous)
        let after = words(next)
        guard !before.isEmpty, !after.isEmpty else { return false }
        let common = zip(before, after).prefix { $0 == $1 }.count
        if common == 0 { return true }
        // "Je" after "Je pense que oui.": the same first word, but a new sentence much shorter than the last.
        return after.count * 2 <= before.count && common * 2 <= before.count
    }

    /// Words compared without case or punctuation: a revision that only adds a comma or a capital is no restart.
    static func words(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    static func join(_ head: String, _ tail: String) -> String {
        if head.isEmpty { return tail }
        if tail.isEmpty { return head }
        return "\(head) \(tail)"
    }
}

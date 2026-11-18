import Foundation

public enum SpeechVoiceQuality: Int, Comparable, Sendable {
    case standard = 0, enhanced = 1, premium = 2

    public static func < (lhs: SpeechVoiceQuality, rhs: SpeechVoiceQuality) -> Bool { lhs.rawValue < rhs.rawValue }

    /// The word of the protocol (`default`, `enhanced`, `premium`).
    public var label: String {
        switch self {
        case .standard: return "default"
        case .enhanced: return "enhanced"
        case .premium: return "premium"
        }
    }
}

public struct SpeechVoice: Equatable, Sendable {
    public let id: String
    public let name: String
    public let language: String
    public let quality: SpeechVoiceQuality

    public init(id: String, name: String, language: String, quality: SpeechVoiceQuality) {
        self.id = id
        self.name = name
        self.language = language
        self.quality = quality
    }
}

/// The voices offered by the app: French and English only, best quality first.
public enum VoiceCatalog {
    public static func isSupported(language: String) -> Bool {
        let lower = language.lowercased().replacingOccurrences(of: "_", with: "-")
        return lower == "fr" || lower == "en" || lower.hasPrefix("fr-") || lower.hasPrefix("en-")
    }

    /// premium > enhanced > default, then language, then name.
    public static func select(_ voices: [SpeechVoice]) -> [SpeechVoice] {
        voices.filter { isSupported(language: $0.language) }.sorted { a, b in
            if a.quality != b.quality { return a.quality > b.quality }
            if a.language != b.language { return a.language < b.language }
            let order = a.name.caseInsensitiveCompare(b.name)
            if order != .orderedSame { return order == .orderedAscending }
            return a.id < b.id
        }
    }

    public static func line(_ voices: [SpeechVoice]) -> String {
        let items = voices.map {
            "{\"id\":\(SpeakJSON.quote($0.id)),\"name\":\(SpeakJSON.quote($0.name)),"
                + "\"language\":\(SpeakJSON.quote($0.language)),\"quality\":\"\($0.quality.label)\"}"
        }
        return "{\"voices\":[\(items.joined(separator: ","))]}"
    }
}

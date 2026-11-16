import Foundation

/// Language tag accepted by this helper and by `electron/dictation.cjs` (`LOCALE`).
/// Language is 2–3 lower-case letters, then up to three subtags (script, region, variant),
/// each 2–8 letters or digits. The pattern string is the same one the JavaScript test locks.
public enum LocaleTag {
    public static let pattern = "^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$"

    public static func isValid(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: range) else { return false }
        return match.range.location == range.location && match.range.length == range.length
    }

    private static let regex = try! NSRegularExpression(pattern: pattern)
}

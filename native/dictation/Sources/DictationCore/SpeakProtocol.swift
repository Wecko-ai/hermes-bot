import Foundation

/// A line of stdin for `speak`, once checked.
public enum SpeakCommand: Equatable, Sendable {
    case say(id: Int, text: String, voice: String?, language: String?, rate: Double)
    case pcm(id: Int, sampleRate: Int, data: Data, last: Bool)
    case stop
}

/// A line that could not be used. `id` is there when it could be read.
public struct SpeakRejection: Error, Equatable, Sendable {
    public let id: Int?
    public let code: String
}

/// An event on stdout. `line` is one JSON object with a fixed key order, no trailing newline.
public enum SpeakEvent: Equatable, Sendable {
    case ready
    case start(id: Int)
    case level(id: Int, rms: Double, bands: [Double])
    case end(id: Int, interrupted: Bool)
    case error(id: Int?, code: String)

    public var line: String {
        switch self {
        case .ready:
            return "{\"type\":\"ready\"}"
        case .start(let id):
            return "{\"type\":\"start\",\"id\":\(id)}"
        case .level(let id, let rms, let bands):
            return "{\"type\":\"level\",\"id\":\(id),\"rms\":\(SpeakJSON.number(rms)),\"bands\":[\(bands.map(SpeakJSON.number).joined(separator: ","))]}"
        case .end(let id, let interrupted):
            return "{\"type\":\"end\",\"id\":\(id),\"interrupted\":\(interrupted)}"
        case .error(let id, let code):
            let safe = SpeakJSON.isErrorCode(code) ? code : "error_unknown"
            let idPart = id.map { ",\"id\":\($0)" } ?? ""
            return "{\"type\":\"error\"\(idPart),\"code\":\"\(safe)\"}"
        }
    }
}

public enum SpeakJSON {
    public static func number(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        let rounded = SpeechLevels.round3(value)
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }

    public static func quote(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }

    public static func isErrorCode(_ code: String) -> Bool {
        guard code.hasPrefix("error_"), code.count > 6 else { return false }
        return code.unicodeScalars.allSatisfy { ($0.value >= 97 && $0.value <= 122) || $0 == "_" }
    }
}

public enum SpeakInput {
    public static let maxIdValue = 2_147_483_647
    public static let maxTextUnits = 4000
    public static let maxChunkBytes = 2 * 1024 * 1024
    /// A chunk of 2 MB in base64, plus the JSON around it.
    public static let maxLineBytes = 2_900_000
    public static let minRate = 0.5
    public static let maxRate = 2.0

    /// nil for an empty line.
    public static func parse(_ line: String) -> Result<SpeakCommand?, SpeakRejection> {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .success(nil) }
        guard trimmed.utf8.count <= maxLineBytes else { return .failure(.init(id: nil, code: "error_bad_input")) }
        guard let data = trimmed.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = object["op"] as? String
        else { return .failure(.init(id: nil, code: "error_bad_input")) }
        if op == "stop" { return .success(.stop) }
        guard op == "say" || op == "pcm" else { return .failure(.init(id: nil, code: "error_bad_input")) }
        guard let rawID = object["id"], let id = integer(rawID), (1...maxIdValue).contains(id) else {
            return .failure(.init(id: nil, code: "error_bad_input"))
        }
        func bad(_ code: String = "error_bad_input") -> Result<SpeakCommand?, SpeakRejection> { .failure(.init(id: id, code: code)) }

        if op == "say" {
            guard let text = object["text"] as? String, !text.isEmpty else { return bad() }
            guard text.utf16.count <= maxTextUnits else { return bad("error_text_too_long") }
            var voice: String?
            if let raw = object["voice"], !(raw is NSNull) {
                guard let value = raw as? String, !value.isEmpty, value.utf8.count <= 256 else { return bad() }
                voice = value
            }
            var language: String?
            if let raw = object["language"], !(raw is NSNull) {
                guard let value = raw as? String, LocaleTag.isValid(value) else { return bad() }
                language = value
            }
            var rate = 1.0
            if let raw = object["rate"], !(raw is NSNull) {
                guard let value = number(raw) else { return bad() }
                rate = min(max(value, minRate), maxRate)
            }
            return .success(.say(id: id, text: text, voice: voice, language: language, rate: rate))
        }

        guard let rawRate = object["rate"], let sampleRate = integer(rawRate), (8000...96000).contains(sampleRate) else { return bad() }
        var last = false
        if let raw = object["last"], !(raw is NSNull) {
            guard isBool(raw), let value = raw as? Bool else { return bad() }
            last = value
        }
        var bytes = Data()
        if let raw = object["data"], !(raw is NSNull) {
            guard let encoded = raw as? String, encoded.utf8.count <= maxLineBytes,
                  let decoded = Data(base64Encoded: encoded) else { return bad() }
            bytes = decoded
        }
        guard bytes.count <= maxChunkBytes, bytes.count % 2 == 0, !bytes.isEmpty || last else { return bad() }
        return .success(.pcm(id: id, sampleRate: sampleRate, data: bytes, last: last))
    }

    private static func isBool(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func number(_ value: Any) -> Double? {
        guard let number = value as? NSNumber, !isBool(value) else { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }

    private static func integer(_ value: Any) -> Int? {
        guard let double = number(value), double == double.rounded(), abs(double) < 1e15 else { return nil }
        return Int(double)
    }
}

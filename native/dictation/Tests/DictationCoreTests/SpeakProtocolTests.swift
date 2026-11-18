import XCTest
@testable import DictationCore

final class SpeakProtocolTests: XCTestCase {
    private func command(_ line: String) -> SpeakCommand? {
        guard case .success(let command) = SpeakInput.parse(line) else { return nil }
        return command
    }

    private func rejection(_ line: String) -> SpeakRejection? {
        guard case .failure(let rejection) = SpeakInput.parse(line) else { return nil }
        return rejection
    }

    func testSayWithDefaults() {
        XCTAssertEqual(command(#"{"op":"say","id":1,"text":"Bonjour"}"#),
                       .say(id: 1, text: "Bonjour", voice: nil, language: nil, rate: 1))
    }

    func testSayWithEverything() {
        XCTAssertEqual(command(#"{"op":"say","id":2147483647,"text":"Hi","voice":"com.apple.voice.compact.en-GB.Daniel","language":"en-GB","rate":1.5}"#),
                       .say(id: 2147483647, text: "Hi", voice: "com.apple.voice.compact.en-GB.Daniel", language: "en-GB", rate: 1.5))
    }

    func testRateIsClamped() {
        XCTAssertEqual(command(#"{"op":"say","id":1,"text":"a","rate":9}"#),
                       .say(id: 1, text: "a", voice: nil, language: nil, rate: 2))
        XCTAssertEqual(command(#"{"op":"say","id":1,"text":"a","rate":0.01}"#),
                       .say(id: 1, text: "a", voice: nil, language: nil, rate: 0.5))
    }

    func testStopAndBlankLines() {
        XCTAssertEqual(command(#"{"op":"stop"}"#), .stop)
        XCTAssertNil(command("   "))
        XCTAssertNotNil(SpeakInput.parse("  "))
    }

    func testBadLinesAreRejectedWithTheIdWhenKnown() {
        XCTAssertEqual(rejection("not json"), .init(id: nil, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","text":"x"}"#), .init(id: nil, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","id":0,"text":"x"}"#), .init(id: nil, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","id":2147483648,"text":"x"}"#), .init(id: nil, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","id":1.5,"text":"x"}"#), .init(id: nil, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","id":true,"text":"x"}"#), .init(id: nil, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"fly","id":1}"#), .init(id: nil, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","id":3}"#), .init(id: 3, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","id":3,"text":""}"#), .init(id: 3, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","id":3,"text":"x","language":"fr_FR;ls"}"#), .init(id: 3, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"say","id":3,"text":"x","rate":"fast"}"#), .init(id: 3, code: "error_bad_input"))
    }

    func testTextLengthIsInUTF16Units() {
        let limit = String(repeating: "a", count: 4000)
        XCTAssertNotNil(command(#"{"op":"say","id":1,"text":"\#(limit)"}"#))
        XCTAssertEqual(rejection(#"{"op":"say","id":4,"text":"\#(limit)a"}"#), .init(id: 4, code: "error_text_too_long"))
        // 2001 emoji = 4002 UTF-16 units.
        let emoji = String(repeating: "😀", count: 2001)
        XCTAssertEqual(rejection(#"{"op":"say","id":5,"text":"\#(emoji)"}"#), .init(id: 5, code: "error_text_too_long"))
    }

    func testPcmChunks() {
        let bytes = Data([1, 0, 2, 0])
        XCTAssertEqual(command(#"{"op":"pcm","id":7,"rate":24000,"data":"\#(bytes.base64EncodedString())","last":false}"#),
                       .pcm(id: 7, sampleRate: 24000, data: bytes, last: false))
        XCTAssertEqual(command(#"{"op":"pcm","id":7,"rate":24000,"last":true}"#),
                       .pcm(id: 7, sampleRate: 24000, data: Data(), last: true))
    }

    func testBadPcmChunks() {
        let odd = Data([1, 0, 2]).base64EncodedString()
        XCTAssertEqual(rejection(#"{"op":"pcm","id":7,"rate":24000,"data":"\#(odd)"}"#), .init(id: 7, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"pcm","id":7,"rate":24000}"#), .init(id: 7, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"pcm","id":7,"rate":5,"last":true}"#), .init(id: 7, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"pcm","id":7,"rate":24000,"data":"%%%","last":true}"#), .init(id: 7, code: "error_bad_input"))
        XCTAssertEqual(rejection(#"{"op":"pcm","id":7,"rate":24000,"data":"AAAA","last":"yes"}"#), .init(id: 7, code: "error_bad_input"))
        let big = Data(count: SpeakInput.maxChunkBytes + 2).base64EncodedString()
        XCTAssertEqual(rejection(#"{"op":"pcm","id":7,"rate":24000,"data":"\#(big)"}"#), .init(id: 7, code: "error_bad_input"))
        let max = Data(count: SpeakInput.maxChunkBytes).base64EncodedString()
        XCTAssertNotNil(command(#"{"op":"pcm","id":7,"rate":24000,"data":"\#(max)"}"#))
    }

    func testEventLinesHaveAStableKeyOrder() {
        XCTAssertEqual(SpeakEvent.ready.line, #"{"type":"ready"}"#)
        XCTAssertEqual(SpeakEvent.start(id: 3).line, #"{"type":"start","id":3}"#)
        XCTAssertEqual(SpeakEvent.level(id: 3, rms: 0.4237, bands: [0, 1, 0.5, 0.1234]).line,
                       #"{"type":"level","id":3,"rms":0.424,"bands":[0,1,0.5,0.123]}"#)
        XCTAssertEqual(SpeakEvent.end(id: 3, interrupted: true).line, #"{"type":"end","id":3,"interrupted":true}"#)
        XCTAssertEqual(SpeakEvent.error(id: 3, code: "error_audio").line, #"{"type":"error","id":3,"code":"error_audio"}"#)
        XCTAssertEqual(SpeakEvent.error(id: nil, code: "error_bad_input").line, #"{"type":"error","code":"error_bad_input"}"#)
        XCTAssertEqual(SpeakEvent.error(id: nil, code: "Bad Code").line, #"{"type":"error","code":"error_unknown"}"#)
    }

    func testQuoteEscapes() {
        XCTAssertEqual(SpeakJSON.quote("a\"b\\c\nd\u{01}é"), "\"a\\\"b\\\\c\\nd\\u0001é\"")
    }
}

import XCTest
@testable import DictationCore

final class SpeechLevelsTests: XCTestCase {
    private func sine(_ hertz: Double, rate: Double, count: Int, amplitude: Float = 0.5) -> [Float] {
        (0..<count).map { amplitude * Float(sin(2 * Double.pi * hertz * Double($0) / rate)) }
    }

    func testRmsMappingEndpoints() {
        XCTAssertEqual(SpeechLevels.rmsLevel(rms: 0), 0)
        XCTAssertEqual(SpeechLevels.rmsLevel(rms: pow(10, -50 / 20)), 0, accuracy: 1e-9)
        XCTAssertEqual(SpeechLevels.rmsLevel(rms: pow(10, -30 / 20)), 0.5, accuracy: 1e-9)
        XCTAssertEqual(SpeechLevels.rmsLevel(rms: pow(10, -10 / 20)), 1, accuracy: 1e-9)
        XCTAssertEqual(SpeechLevels.rmsLevel(rms: 1), 1)
    }

    func testBandEdgesAreLogSpacedFrom80To8000() {
        let edges = SpeechLevels.bandEdges()
        XCTAssertEqual(edges.count, 13)
        XCTAssertEqual(edges[0], 80, accuracy: 1e-9)
        XCTAssertEqual(edges[12], 8000, accuracy: 1e-6)
        let ratios = zip(edges, edges.dropFirst()).map { $1 / $0 }
        for ratio in ratios { XCTAssertEqual(ratio, ratios[0], accuracy: 1e-9) }
        XCTAssertEqual(SpeechLevels.bandIndex(hertz: 440), 4)
        XCTAssertNil(SpeechLevels.bandIndex(hertz: 50))
    }

    func testSilenceGivesZeroBands() {
        let bands = BandAnalyzer().bands(samples: [Float](repeating: 0, count: 2048), sampleRate: 24000)
        XCTAssertEqual(bands, [Double](repeating: 0, count: 12))
    }

    func testSineDominatesItsBand() {
        let analyzer = BandAnalyzer()
        for (hertz, rate) in [(440.0, 24000.0), (440.0, 22050.0), (1000.0, 24000.0), (3000.0, 24000.0)] {
            let bands = analyzer.bands(samples: sine(hertz, rate: rate, count: 2048), sampleRate: rate)
            let expected = SpeechLevels.bandIndex(hertz: hertz)!
            let loudest = bands.indices.max { bands[$0] < bands[$1] }!
            XCTAssertEqual(loudest, expected, "\(hertz) Hz at \(rate)")
            // 0.5 amplitude is -6 dB full scale: far above the -15 dB ceiling.
            XCTAssertEqual(bands[expected], 1, accuracy: 0.001)
            for band in bands.indices where abs(band - expected) > 1 { XCTAssertLessThan(bands[band], 0.2) }
        }
    }

    func testAShortWindowIsPaddedNotRejected() {
        let bands = BandAnalyzer().bands(samples: sine(440, rate: 24000, count: 800), sampleRate: 24000)
        XCTAssertEqual(bands.indices.max { bands[$0] < bands[$1] }, 4)
    }

    func testMeterCutsFramesOfAThirtiethOfASecond() {
        let meter = LevelMeter(sampleRate: 24000)
        XCTAssertEqual(meter.frameSize, 800)
        XCTAssertEqual(meter.feed(sine(440, rate: 24000, count: 799)).count, 0)
        let frames = meter.feed(sine(440, rate: 24000, count: 1 + 800 * 2 + 100))
        XCTAssertEqual(frames.count, 3)
        for frame in frames {
            XCTAssertEqual(frame.bands.count, 12)
            XCTAssertGreaterThan(frame.rms, 0.5)
        }
        XCTAssertEqual(meter.flush().count, 1)
        XCTAssertEqual(meter.flush().count, 0)
    }

    func testMeterReadsSilenceAsZero() {
        let frames = LevelMeter(sampleRate: 22050).feed([Float](repeating: 0, count: 22050))
        XCTAssertEqual(frames.count, 30)
        XCTAssertTrue(frames.allSatisfy { $0.rms == 0 && $0.bands.allSatisfy { $0 == 0 } })
    }
}

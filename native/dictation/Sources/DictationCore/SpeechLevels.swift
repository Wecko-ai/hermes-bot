import Accelerate
import Foundation

/// Levels of the voice mode: what the animation reacts to. Pure maths on samples, no audio device.
public enum SpeechLevels {
    public static let bandCount = 12
    public static let lowestHz = 80.0
    public static let highestHz = 8000.0
    /// FFT window, in samples (a power of two).
    public static let windowSize = 2048
    /// Overall level: RMS in dB mapped from -50...-10 onto 0...1.
    public static let rmsFloorDb = -50.0
    public static let rmsCeilingDb = -10.0
    /// One band: dB of its amplitude mapped from -60...-15 onto 0...1.
    public static let bandFloorDb = -60.0
    public static let bandCeilingDb = -15.0

    /// Linear position of `decibels` between `floor` and `ceiling`, clamped to 0...1.
    public static func unit(decibels: Double, floor: Double, ceiling: Double) -> Double {
        guard decibels.isFinite else { return 0 }
        return min(max((decibels - floor) / (ceiling - floor), 0), 1)
    }

    public static func decibels(amplitude: Double) -> Double {
        20 * log10(max(amplitude, 1e-9))
    }

    /// 0...1 from a linear RMS amplitude (1.0 = full scale).
    public static func rmsLevel(rms: Double) -> Double {
        unit(decibels: decibels(amplitude: rms), floor: rmsFloorDb, ceiling: rmsCeilingDb)
    }

    public static func rms(of samples: ArraySlice<Float>) -> Double {
        guard !samples.isEmpty else { return 0 }
        var sum = 0.0
        for sample in samples { sum += Double(sample) * Double(sample) }
        return (sum / Double(samples.count)).squareRoot()
    }

    public static func rmsLevel(of samples: [Float]) -> Double {
        rmsLevel(rms: rms(of: samples[...]))
    }

    /// `bandCount + 1` edges, log-spaced from `lowestHz` to `highestHz`.
    public static func bandEdges() -> [Double] {
        let ratio = pow(highestHz / lowestHz, 1 / Double(bandCount))
        return (0...bandCount).map { lowestHz * pow(ratio, Double($0)) }
    }

    /// Index of the band that holds `hertz`, nil outside 80 Hz...8 kHz.
    public static func bandIndex(hertz: Double) -> Int? {
        let edges = bandEdges()
        guard hertz >= edges[0], hertz < edges[bandCount] else { return nil }
        return (0..<bandCount).first { hertz < edges[$0 + 1] }
    }

    public static func round3(_ value: Double) -> Double {
        (value * 1000).rounded() / 1000
    }
}

/// Spectrum of the last window of samples, in `SpeechLevels.bandCount` log-spaced bands, each 0...1.
/// Holds an FFT setup: use it from one place at a time.
public final class BandAnalyzer {
    private let log2n = vDSP_Length(11)
    private let setup: FFTSetup
    private var windows: [Int: ([Float], Float)] = [:]
    private var real = [Float](repeating: 0, count: SpeechLevels.windowSize / 2)
    private var imag = [Float](repeating: 0, count: SpeechLevels.windowSize / 2)
    private var frame = [Float](repeating: 0, count: SpeechLevels.windowSize)
    private let edges = SpeechLevels.bandEdges()

    public init() {
        precondition(1 << 11 == SpeechLevels.windowSize)
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    private func window(_ count: Int) -> ([Float], Float) {
        if let cached = windows[count] { return cached }
        var values = [Float](repeating: 0, count: count)
        vDSP_hann_window(&values, vDSP_Length(count), Int32(vDSP_HANN_DENORM))
        let made = (values, values.reduce(0, +))
        windows[count] = made
        return made
    }

    /// The last `windowSize` samples of `samples` (fewer: zero-padded after them), Hann window.
    /// A sine of amplitude A lands near A in its band, so `decibels(amplitude:)` reads as dB full scale.
    public func bands(samples: [Float], sampleRate: Double) -> [Double] {
        let count = min(samples.count, SpeechLevels.windowSize)
        guard count >= 16, sampleRate > 0 else { return [Double](repeating: 0, count: SpeechLevels.bandCount) }
        let (hann, sum) = window(count)
        let tail = samples.suffix(count)
        var index = 0
        for sample in tail {
            frame[index] = sample * hann[index]
            index += 1
        }
        for rest in count..<SpeechLevels.windowSize { frame[rest] = 0 }
        let half = SpeechLevels.windowSize / 2
        var amplitudes = [Double](repeating: 0, count: half)
        real.withUnsafeMutableBufferPointer { realPointer in
            imag.withUnsafeMutableBufferPointer { imagPointer in
                var split = DSPSplitComplex(realp: realPointer.baseAddress!, imagp: imagPointer.baseAddress!)
                frame.withUnsafeBufferPointer { framePointer in
                    framePointer.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                        vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(kFFTDirection_Forward))
                // Real FFT output is twice the DFT: |out| / sum(window) is the sine amplitude. Bin 0 packs the
                // Nyquist term, skipped.
                for bin in 1..<half {
                    let re = Double(realPointer[bin]), im = Double(imagPointer[bin])
                    amplitudes[bin] = (re * re + im * im).squareRoot() / Double(sum)
                }
            }
        }
        let binWidth = sampleRate / Double(SpeechLevels.windowSize)
        var result = [Double](repeating: 0, count: SpeechLevels.bandCount)
        for band in 0..<SpeechLevels.bandCount {
            let low = max(1, Int((edges[band] / binWidth).rounded(.up)))
            let high = min(half - 1, Int((edges[band + 1] / binWidth).rounded(.up)) - 1)
            var energy = 0.0
            if low <= high {
                for bin in low...high { energy += amplitudes[bin] * amplitudes[bin] }
            } else {
                // Narrower than one bin (very low sample rate or high band): the nearest bin stands for it.
                let nearest = min(max(Int(((edges[band] + edges[band + 1]) / 2 / binWidth).rounded()), 1), half - 1)
                energy = amplitudes[nearest] * amplitudes[nearest]
            }
            let dB = SpeechLevels.decibels(amplitude: energy.squareRoot())
            result[band] = SpeechLevels.round3(
                SpeechLevels.unit(decibels: dB, floor: SpeechLevels.bandFloorDb, ceiling: SpeechLevels.bandCeilingDb))
        }
        return result
    }
}

public struct LevelFrame: Equatable, Sendable {
    public let rms: Double
    public let bands: [Double]
}

/// Cuts a stream of mono samples into frames of 1/30 s and measures each.
/// The RMS comes from the frame, the bands from the last window of samples up to its end.
public final class LevelMeter {
    public let sampleRate: Double
    public let frameSize: Int
    private let analyzer = BandAnalyzer()
    private var pending: [Float] = []
    private var history: [Float] = []

    public init(sampleRate: Double, framesPerSecond: Double = 30) {
        self.sampleRate = sampleRate
        frameSize = max(1, Int((sampleRate / framesPerSecond).rounded()))
    }

    public func reset() {
        pending.removeAll(keepingCapacity: true)
        history.removeAll(keepingCapacity: true)
    }

    public func feed(_ samples: [Float]) -> [LevelFrame] {
        pending.append(contentsOf: samples)
        var frames: [LevelFrame] = []
        var offset = 0
        while pending.count - offset >= frameSize {
            frames.append(measure(pending[offset..<offset + frameSize]))
            offset += frameSize
        }
        if offset > 0 { pending.removeFirst(offset) }
        return frames
    }

    /// The samples left over (less than a frame), measured as a last frame.
    public func flush() -> [LevelFrame] {
        guard !pending.isEmpty else { return [] }
        let frame = measure(pending[...])
        pending.removeAll(keepingCapacity: true)
        return [frame]
    }

    private func measure(_ slice: ArraySlice<Float>) -> LevelFrame {
        history.append(contentsOf: slice)
        if history.count > SpeechLevels.windowSize { history.removeFirst(history.count - SpeechLevels.windowSize) }
        let level = SpeechLevels.round3(SpeechLevels.rmsLevel(rms: SpeechLevels.rms(of: slice)))
        return LevelFrame(rms: level, bands: analyzer.bands(samples: history, sampleRate: sampleRate))
    }
}

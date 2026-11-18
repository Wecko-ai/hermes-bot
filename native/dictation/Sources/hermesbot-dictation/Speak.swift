// The `voices` and `speak` commands of hermesbot-dictation: the voice mode's speaker. See the protocol header
// in main.swift. Nothing the bot says is ever written to a log: --trace prints event types and text lengths.
import AVFoundation
import Foundation
#if canImport(DictationCore)
import DictationCore
#endif

// MARK: - Output

private let speakOutputLock = NSLock()

func speakEmit(_ event: SpeakEvent) {
    var bytes = Array((event.line + "\n").utf8)
    speakOutputLock.lock()
    defer { speakOutputLock.unlock() }
    // POSIX write: a closed pipe is an error to ignore here, not an exception.
    var offset = 0
    while offset < bytes.count {
        let written = bytes.withUnsafeMutableBytes { write(1, $0.baseAddress! + offset, $0.count - offset) }
        if written <= 0 { return }
        offset += written
    }
}

/// Runs `work` on the main actor after everything already queued on the main queue (FIFO).
func onMain(_ work: @escaping @MainActor @Sendable () -> Void) {
    DispatchQueue.main.async { MainActor.assumeIsolated(work) }
}

// MARK: - voices

func printVoices() {
    var voices: [SpeechVoice] = []
    for voice in AVSpeechSynthesisVoice.speechVoices() {
        if #available(macOS 14, *), voice.voiceTraits.contains(.isNoveltyVoice) { continue }
        let quality: SpeechVoiceQuality
        switch voice.quality {
        case .premium: quality = .premium
        case .enhanced: quality = .enhanced
        default: quality = .standard
        }
        voices.append(SpeechVoice(id: voice.identifier, name: voice.name, language: voice.language, quality: quality))
    }
    FileHandle.standardOutput.write(Data((VoiceCatalog.line(VoiceCatalog.select(voices)) + "\n").utf8))
}

// MARK: - Conversion

/// The one format everything is converted to before it is played or measured.
let speakFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!

/// Turns buffers of any format into mono float samples at 24 kHz, keeping the converter's state between chunks.
/// Used from the synthesizer's callback thread or from the main actor, one at a time.
final class StreamConverter: @unchecked Sendable {
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?

    private final class Feed: @unchecked Sendable {
        var buffer: AVAudioPCMBuffer?
        init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
    }

    /// nil if the format cannot be converted.
    func convert(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        lock.lock()
        defer { lock.unlock() }
        guard buffer.frameLength > 0 else { return [] }
        if inputFormat != buffer.format {
            inputFormat = buffer.format
            converter = AVAudioConverter(from: buffer.format, to: speakFormat)
        }
        guard let converter else { return nil }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * speakFormat.sampleRate / buffer.format.sampleRate) + 512
        guard let out = AVAudioPCMBuffer(pcmFormat: speakFormat, frameCapacity: capacity) else { return nil }
        let feed = Feed(buffer)
        var failure: NSError?
        converter.convert(to: out, error: &failure) { _, status in
            if let next = feed.buffer {
                feed.buffer = nil
                status.pointee = .haveData
                return next
            }
            status.pointee = .noDataNow
            return nil
        }
        if failure != nil { return nil }
        guard let channel = out.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
    }
}

/// Little-endian int16 mono bytes as a buffer of `sampleRate`.
func int16Buffer(_ data: Data, sampleRate: Int) -> AVAudioPCMBuffer? {
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(sampleRate), channels: 1, interleaved: true),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(data.count / 2, 1))),
          let channel = buffer.int16ChannelData?[0]
    else { return nil }
    let count = data.count / 2
    data.withUnsafeBytes { raw in
        for index in 0..<count { channel[index] = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self)) }
    }
    buffer.frameLength = AVAudioFrameCount(count)
    return buffer
}

func floatBuffer(_ samples: [Float]) -> AVAudioPCMBuffer? {
    guard let buffer = AVAudioPCMBuffer(pcmFormat: speakFormat, frameCapacity: AVAudioFrameCount(samples.count)),
          let channel = buffer.floatChannelData?[0]
    else { return nil }
    samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    return buffer
}

// MARK: - Fallback delegate

/// Reports the system speaker (`speak()`) back to the main actor. Only used when `write` gives no audio.
final class FallbackDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    let onStart: @Sendable () -> Void
    let onWord: @Sendable () -> Void
    let onDone: @Sendable () -> Void
    init(onStart: @escaping @Sendable () -> Void, onWord: @escaping @Sendable () -> Void, onDone: @escaping @Sendable () -> Void) {
        self.onStart = onStart
        self.onWord = onWord
        self.onDone = onDone
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) { onStart() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) { onWord() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { onDone() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { onDone() }
}

// MARK: - Speaker

@MainActor
final class Speaker {
    enum Kind {
        case speech(text: String, voice: AVSpeechSynthesisVoice?, rate: Float)
        case pcm
    }

    enum State { case queued, synthesizing, synthesized }

    @MainActor
    final class Job {
        let id: Int
        let kind: Kind
        var state = State.queued
        var cancelled = false
        var startEmitted = false
        var hasAudio = false
        // speech
        var synthesizer: AVSpeechSynthesizer?
        var receivedBuffer = false
        var isFallback = false
        var fallbackSynthesizer: AVSpeechSynthesizer?
        var fallbackDelegate: FallbackDelegate?
        var fallbackStarted = false
        // pcm
        var chunks: [(rate: Int, data: Data)] = []
        var pcmRate: Int?
        var pcmClosed = false
        // both
        let converter = StreamConverter()
        let meter = LevelMeter(sampleRate: speakFormat.sampleRate)

        init(id: Int, kind: Kind) {
            self.id = id
            self.kind = kind
        }

        var isPCM: Bool { if case .pcm = kind { return true } else { return false } }
    }

    let noPlay: Bool
    let trace: Bool
    private var jobs: [Job] = []
    private var synthesizing: Job?
    private var playingID: Int?
    private var interruptedPCM: Set<Int> = []
    private var inputClosed = false
    // playback
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var liveMeter = LevelMeter(sampleRate: speakFormat.sampleRate)
    // fallback pulse
    private var pulse = 0.0
    private var pulseCount = 0
    private var pulseTimer: DispatchSourceTimer?

    static let fallbackAfter = 2.0

    init(noPlay: Bool, trace: Bool) {
        self.noPlay = noPlay
        self.trace = trace
    }

    func log(_ message: String) {
        guard trace else { return }
        FileHandle.standardError.write(Data("hermesbot-dictation speak: \(message)\n".utf8))
    }

    func emit(_ event: SpeakEvent) {
        switch event {
        case .level: break
        default: log("event \(event.line)")
        }
        speakEmit(event)
    }

    // MARK: Input

    func handle(_ command: SpeakCommand) {
        switch command {
        case .stop:
            log("op stop")
            stopAll()
        case .say(let id, let text, let voice, let language, let rate):
            log("op say id=\(id) chars=\(text.utf16.count) voice=\(voice != nil) language=\(language ?? "-") rate=\(rate)")
            guard !jobs.contains(where: { $0.id == id }) else { return emit(.error(id: id, code: "error_bad_input")) }
            var resolved: AVSpeechSynthesisVoice?
            if let voice {
                resolved = AVSpeechSynthesisVoice(identifier: voice)
                if resolved == nil { return emit(.error(id: id, code: "error_voice_unavailable")) }
            } else if let language {
                resolved = AVSpeechSynthesisVoice(language: language)
                if resolved == nil { return emit(.error(id: id, code: "error_voice_unavailable")) }
            }
            let base = Double(AVSpeechUtteranceDefaultSpeechRate) * rate
            let clamped = Float(min(max(base, Double(AVSpeechUtteranceMinimumSpeechRate)), Double(AVSpeechUtteranceMaximumSpeechRate)))
            jobs.append(Job(id: id, kind: .speech(text: text, voice: resolved, rate: clamped)))
            pump()
        case .pcm(let id, let sampleRate, let data, let last):
            log("op pcm id=\(id) bytes=\(data.count) rate=\(sampleRate) last=\(last)")
            if interruptedPCM.contains(id) {
                if last { interruptedPCM.remove(id) }
                return
            }
            let job: Job
            if let existing = jobs.first(where: { $0.id == id }) {
                guard existing.isPCM, !existing.pcmClosed else { return emit(.error(id: id, code: "error_bad_input")) }
                job = existing
            } else {
                guard !jobs.contains(where: { $0.isPCM && !$0.pcmClosed }) else { return emit(.error(id: id, code: "error_bad_input")) }
                job = Job(id: id, kind: .pcm)
                jobs.append(job)
            }
            if !data.isEmpty { job.chunks.append((sampleRate, data)) }
            if last { job.pcmClosed = true }
            pump()
        }
    }

    func reject(_ rejection: SpeakRejection) {
        log("rejected \(rejection.code)")
        emit(.error(id: rejection.id, code: rejection.code))
    }

    /// End of stdin: what is queued is spoken, then the process leaves.
    func inputDidClose() {
        inputClosed = true
        for job in jobs where job.isPCM && !job.pcmClosed { job.pcmClosed = true }
        pump()
        exitIfIdle()
    }

    func exitIfIdle() {
        if inputClosed && jobs.isEmpty {
            log("idle after end of input, leaving")
            exit(0)
        }
    }

    // MARK: Queue

    /// Synthesis runs one job at a time and may run ahead of playback; playback is the order of `jobs`.
    func pump() {
        if synthesizing == nil, let next = jobs.first(where: { $0.state == .queued && !$0.cancelled }) {
            // A system-voice fallback speaks outside the engine: it must not overlap an earlier job's audio.
            next.state = .synthesizing
            synthesizing = next
            switch next.kind {
            case .speech: beginSynthesis(next)
            case .pcm: break
            }
        }
        if let current = synthesizing, current.isPCM { drainPCM(current) }
        if let head = jobs.first, head.isFallback, !head.fallbackStarted { startFallbackSpeech(head) }
        refreshPlaying()
    }

    /// The first job of the queue is the one heard: it gets its `start` once audio of it is scheduled.
    func refreshPlaying() {
        guard let head = jobs.first, head.hasAudio, !head.startEmitted, !head.isFallback else { return }
        head.startEmitted = true
        playingID = head.id
        liveMeter.reset()
        emit(.start(id: head.id))
    }

    func finish(_ job: Job, interrupted: Bool = false) {
        guard !job.cancelled else { return }
        job.cancelled = true
        job.synthesizer?.stopSpeaking(at: .immediate)
        job.fallbackSynthesizer?.stopSpeaking(at: .immediate)
        if synthesizing === job { synthesizing = nil }
        jobs.removeAll { $0 === job }
        if playingID == job.id { playingID = nil }
        emit(.end(id: job.id, interrupted: interrupted))
        if job.isFallback { updatePulseTimer() }
        pump()
        exitIfIdle()
    }

    func fail(_ job: Job, _ code: String) {
        guard !job.cancelled else { return }
        job.cancelled = true
        job.synthesizer?.stopSpeaking(at: .immediate)
        job.fallbackSynthesizer?.stopSpeaking(at: .immediate)
        if synthesizing === job { synthesizing = nil }
        let wasHead = jobs.first === job
        jobs.removeAll { $0 === job }
        if playingID == job.id { playingID = nil }
        emit(.error(id: job.id, code: code))
        if job.startEmitted || wasHead { /* the client saw an error for this id: no end follows */ }
        if job.isFallback { updatePulseTimer() }
        pump()
        exitIfIdle()
    }

    func stopAll() {
        let head = jobs.first
        for job in jobs {
            job.cancelled = true
            job.synthesizer?.stopSpeaking(at: .immediate)
            job.fallbackSynthesizer?.stopSpeaking(at: .immediate)
            if job.isPCM && !job.pcmClosed { interruptedPCM.insert(job.id) }
        }
        jobs.removeAll()
        synthesizing = nil
        playingID = nil
        player?.stop()
        liveMeter.reset()
        updatePulseTimer()
        if let head { emit(.end(id: head.id, interrupted: true)) }
        exitIfIdle()
    }

    // MARK: Synthesis

    func beginSynthesis(_ job: Job) {
        guard case .speech(let text, let voice, let rate) = job.kind else { return }
        let synthesizer = AVSpeechSynthesizer()
        job.synthesizer = synthesizer
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = rate
        let converter = job.converter
        let sink = SynthesisSink(job: job, speaker: self)
        synthesizer.write(utterance) { buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                sink.deliver(nil, failed: false)
            } else if let samples = converter.convert(pcm) {
                sink.deliver(samples, failed: false)
            } else {
                sink.deliver(nil, failed: true)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.fallbackAfter) {
            MainActor.assumeIsolated {
                guard !job.cancelled, !job.receivedBuffer, !job.isFallback else { return }
                self.log("write gave no buffer after \(Self.fallbackAfter) s: system speaker for id=\(job.id)")
                self.useFallback(job)
            }
        }
    }

    func synthesisBuffer(_ job: Job, samples: [Float]?, failed: Bool) {
        guard !job.cancelled, !job.isFallback else { return }
        if failed { return fail(job, "error_audio") }
        guard let samples else { return synthesisDone(job) }
        job.receivedBuffer = true
        deliver(job, samples)
    }

    func drainPCM(_ job: Job) {
        while !job.chunks.isEmpty && !job.cancelled {
            let chunk = job.chunks.removeFirst()
            if let rate = job.pcmRate, rate != chunk.rate { emit(.error(id: job.id, code: "error_bad_input")); continue }
            job.pcmRate = chunk.rate
            guard let input = int16Buffer(chunk.data, sampleRate: chunk.rate), let samples = job.converter.convert(input) else {
                return fail(job, "error_audio")
            }
            deliver(job, samples)
        }
        if job.pcmClosed && job.chunks.isEmpty && !job.cancelled && job.state == .synthesizing { synthesisDone(job) }
    }

    func synthesisDone(_ job: Job) {
        guard job.state == .synthesizing else { return }
        job.state = .synthesized
        if synthesizing === job { synthesizing = nil }
        if noPlay {
            for frame in job.meter.flush() { emitLevel(job.id, frame) }
            if !job.startEmitted { job.startEmitted = true; emit(.start(id: job.id)) }
            finish(job)
            return
        }
        // A short silence after the last sample: its `dataPlayedBack` is the end of the utterance.
        guard ensureEngine(), let tail = floatBuffer([Float](repeating: 0, count: 240)) else { return fail(job, "error_audio") }
        job.hasAudio = true
        player?.scheduleBuffer(tail, completionCallbackType: .dataPlayedBack) { _ in
            onMain {
                guard !job.cancelled else { return }
                self.finish(job)
            }
        }
        startPlayer()
        pump()
    }

    func deliver(_ job: Job, _ samples: [Float]) {
        guard !samples.isEmpty else { return }
        log("audio id=\(job.id) samples=\(samples.count)")
        if noPlay {
            if !job.startEmitted { job.startEmitted = true; emit(.start(id: job.id)) }
            for frame in job.meter.feed(samples) { emitLevel(job.id, frame) }
            return
        }
        guard ensureEngine(), let buffer = floatBuffer(samples) else { return fail(job, "error_audio") }
        job.hasAudio = true
        player?.scheduleBuffer(buffer, completionHandler: nil)
        startPlayer()
        refreshPlaying()
    }

    func emitLevel(_ id: Int, _ frame: LevelFrame) {
        speakEmit(.level(id: id, rms: frame.rms, bands: frame.bands))
    }

    // MARK: Playback

    func ensureEngine() -> Bool {
        if let engine, engine.isRunning { return true }
        if engine == nil {
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: speakFormat)
            Self.installTap(on: player, speaker: self)
            self.engine = engine
            self.player = player
            NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
                onMain { self.engineConfigurationChanged() }
            }
        }
        guard let engine else { return false }
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            log("audio engine: \(error)")
            return false
        }
    }

    func engineConfigurationChanged() {
        log("audio configuration changed")
        guard let engine, !engine.isRunning, !jobs.isEmpty else { return }
        if (try? engine.start()) != nil { player?.play() }
    }

    func startPlayer() {
        if let player, !player.isPlaying { player.play() }
    }

    /// The tap runs on the audio thread: it only copies samples and hops.
    nonisolated static func installTap(on player: AVAudioPlayerNode, speaker: Speaker) {
        player.installTap(onBus: 0, bufferSize: 800, format: speakFormat) { buffer, _ in
            guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
            let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
            onMain { speaker.tapped(samples) }
        }
    }

    func tapped(_ samples: [Float]) {
        guard let id = playingID else { return }
        for frame in liveMeter.feed(samples) { emitLevel(id, frame) }
    }

    // MARK: Fallback (system speaker)

    func useFallback(_ job: Job) {
        job.isFallback = true
        job.synthesizer?.stopSpeaking(at: .immediate)
        if noPlay {
            // No audio device in this mode: one decaying pulse stands for the utterance.
            job.startEmitted = true
            emit(.start(id: job.id))
            var value = 0.6
            for tick in 0..<6 {
                speakEmit(.level(id: job.id, rms: value, bands: Self.pulseBands(value, tick: tick)))
                value *= 0.7
            }
            finish(job)
            return
        }
        pump()
    }

    func startFallbackSpeech(_ job: Job) {
        guard case .speech(let text, let voice, let rate) = job.kind else { return }
        job.fallbackStarted = true
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = rate
        let synthesizer = AVSpeechSynthesizer()
        let delegate = FallbackDelegate(
            onStart: { onMain { self.fallbackStarted(job) } },
            onWord: { onMain { self.fallbackWord(job) } },
            onDone: { onMain {
                guard !job.cancelled else { return }
                self.finish(job)
            } })
        job.fallbackSynthesizer = synthesizer
        job.fallbackDelegate = delegate
        synthesizer.delegate = delegate
        synthesizer.speak(utterance)
    }

    func fallbackStarted(_ job: Job) {
        guard !job.cancelled, !job.startEmitted else { return }
        job.startEmitted = true
        playingID = job.id
        pulse = 0.6
        emit(.start(id: job.id))
        updatePulseTimer()
    }

    func fallbackWord(_ job: Job) {
        guard !job.cancelled, job.startEmitted else { return }
        pulse = 0.6
    }

    func updatePulseTimer() {
        let active = jobs.first.map { $0.isFallback && $0.startEmitted && !$0.cancelled } ?? false
        if active, pulseTimer == nil {
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + 0.033, repeating: 1.0 / 30)
            timer.setEventHandler { MainActor.assumeIsolated { self.pulseTick() } }
            timer.resume()
            pulseTimer = timer
        } else if !active, let timer = pulseTimer {
            timer.cancel()
            pulseTimer = nil
        }
    }

    func pulseTick() {
        guard let head = jobs.first, head.isFallback, head.startEmitted else { return }
        pulseCount += 1
        speakEmit(.level(id: head.id, rms: pulse, bands: Self.pulseBands(pulse, tick: pulseCount)))
        pulse *= 0.9
        if pulse < 0.01 { pulse = 0 }
    }

    nonisolated static func pulseBands(_ value: Double, tick: Int) -> [Double] {
        (0..<SpeechLevels.bandCount).map { band in
            let shape = 0.75 + 0.25 * sin(Double(band) * 0.8 + Double(tick) * 0.35)
            return SpeechLevels.round3(min(max(value * shape, 0), 1))
        }
    }
}

/// Carries what the synthesizer's callback thread produced to the main actor, in order.
final class SynthesisSink: @unchecked Sendable {
    private let job: Speaker.Job
    private let speaker: Speaker
    init(job: Speaker.Job, speaker: Speaker) {
        self.job = job
        self.speaker = speaker
    }
    func deliver(_ samples: [Float]?, failed: Bool) {
        let job = job, speaker = speaker
        onMain { speaker.synthesisBuffer(job, samples: samples, failed: failed) }
    }
}

// MARK: - Entry

@MainActor
func runSpeak(_ options: Options) -> Never {
    signal(SIGPIPE, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let speaker = Speaker(noPlay: options.noPlay, trace: options.trace)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminate.setEventHandler { MainActor.assumeIsolated { speaker.stopAll(); exit(0) } }
    terminate.resume()
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            switch SpeakInput.parse(line) {
            case .success(nil): break
            case .success(let command?): onMain { speaker.handle(command) }
            case .failure(let rejection): onMain { speaker.reject(rejection) }
            }
        }
        onMain { speaker.inputDidClose() }
    }
    DispatchQueue.main.async { MainActor.assumeIsolated { speakEmit(.ready) } }
    withExtendedLifetime(terminate) { dispatchMain() }
}

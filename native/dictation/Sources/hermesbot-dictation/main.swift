// hermesbot-dictation: speech to text with the operating system's own recognizer (Speech framework), for the
// desktop app's dictation. It talks JSON, one object per line on stdout; the app's main process owns it
// (electron/dictation.cjs). No audio is stored or sent anywhere by this tool: recognition runs on the device
// when the language has a local model, otherwise through the system's own recognition service.
//
//   probe --locale fr-FR       one line: access, microphone, exists, onDevice, available. Never prompts.
//   authorize --locale fr-FR   asks the system for microphone and speech recognition if not decided yet,
//                              then prints the probe line.
//   listen --locale fr-FR [--on-device] [--listen-for-ms 60000] [--pause-for-ms 4500] [--file <audio>]
//       {"type":"listening"}                       the microphone runs (or the file is being read)
//       {"type":"words","text":"…","final":false}  the whole transcript so far, not a delta
//       {"type":"level","value":0.42}              microphone level, 0 (silence) to 1, about 15 per second
//       {"type":"audioEnd"}                        the microphone is closed; the final result may still come
//       {"type":"words","text":"…","final":true}
//       {"type":"done"}                            nothing more will come; exit 0
//       {"type":"error","code":"error_…"}          instead of the final result; exit 1
//   While listening, a line "stop" on stdin (or SIGTERM) closes the microphone and lets the final result come;
//   "cancel" (or SIGINT, or stdin closed) ends at once. Every path ends with "done" or "error", then exits.
import AVFoundation
import Foundation
import Speech
// A separate module in the Swift package (for its tests); the same module when swiftc builds both files at once.
#if canImport(DictationCore)
import DictationCore
#endif

// MARK: - Output

let stdoutLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
    stdoutLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    stdoutLock.unlock()
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("hermesbot-dictation: \(message)\n".utf8))
}

// MARK: - Arguments

struct Options {
    var command = ""
    var locale = "en-US"
    var onDevice = false
    var listenForMs = 60_000
    var pauseForMs = 4_500
    var file: String?
    /// Diagnostics on stderr: each raw result of the recognizer, before the merge (never used by the app).
    var trace = false
}

func parseOptions(_ arguments: [String]) -> Options? {
    var options = Options()
    var rest = arguments[...]
    guard let command = rest.popFirst(), ["probe", "authorize", "listen"].contains(command) else { return nil }
    options.command = command
    while let flag = rest.popFirst() {
        switch flag {
        case "--on-device": options.onDevice = true
        case "--trace": options.trace = true
        case "--locale":
            guard let value = rest.popFirst(), value.range(of: "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$", options: .regularExpression) != nil else { return nil }
            options.locale = value
        case "--listen-for-ms":
            guard let value = rest.popFirst().flatMap(Int.init) else { return nil }
            options.listenForMs = min(max(value, 1_000), 300_000)
        case "--pause-for-ms":
            guard let value = rest.popFirst().flatMap(Int.init) else { return nil }
            options.pauseForMs = min(max(value, 500), 60_000)
        case "--file":
            guard let value = rest.popFirst() else { return nil }
            options.file = value
        default: return nil
        }
    }
    return options
}

// MARK: - Access

/// Access to both the microphone and speech recognition, as far as the system has decided.
func accessState() -> String {
    let speech = SFSpeechRecognizer.authorizationStatus()
    let microphone = AVCaptureDevice.authorizationStatus(for: .audio)
    if speech == .restricted || microphone == .restricted { return "unavailable" }
    if speech == .denied || microphone == .denied { return "denied" }
    if speech == .authorized && microphone == .authorized { return "granted" }
    return "undetermined"
}

func hasMicrophone() -> Bool {
    AVCaptureDevice.default(for: .audio) != nil
}

func probeLine(locale: String) -> [String: Any] {
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
    return [
        "access": accessState(),
        "microphone": hasMicrophone(),
        "exists": recognizer != nil,
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "available": recognizer?.isAvailable ?? false,
    ]
}

/// Asks what is still undecided, microphone first, then speech recognition. Never asks again after a refusal:
/// the system would not show its prompt a second time anyway.
func authorize(locale: String) {
    let done = DispatchSemaphore(value: 0)
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }
        done.wait()
    }
    if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
        SFSpeechRecognizer.requestAuthorization { _ in done.signal() }
        done.wait()
    }
    emit(probeLine(locale: locale))
}

// MARK: - Errors

/// The error codes of the app's dictation, from what the Speech framework reports.
func errorCode(for error: Error) -> String {
    let error = error as NSError
    if error.domain == NSURLErrorDomain { return "error_network" }
    switch (error.domain, error.code) {
    case ("kAFAssistantErrorDomain", 1110), ("kAFAssistantErrorDomain", 203): return "error_no_match"
    case ("kAFAssistantErrorDomain", 1100), ("kAFAssistantErrorDomain", 1107), ("kAFAssistantErrorDomain", 1101): return "error_network"
    case ("kLSRErrorDomain", 201), ("kAFAssistantErrorDomain", 1700): return "error_permission"
    default: return "error_listen_failed"
    }
}

// MARK: - Listening

/// Microphone level 0..1 from a buffer: full-scale decibels of its RMS, -55 dB (silence) to -15 dB (loud speech).
func level(of buffer: AVAudioPCMBuffer) -> Double {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
    let samples = channels[0]
    var sum: Float = 0
    for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
    let rms = sqrt(sum / Float(buffer.frameLength))
    guard rms > 0 else { return 0 }
    let decibels = 20 * log10(Double(rms))
    return min(max((decibels + 55) / 40, 0), 1)
}

/// One dictation session. Everything runs on the main queue; the recognizer's callbacks hop onto it.
final class Session {
    let options: Options
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    var request: SFSpeechRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var transcript = ""
    /// The recognizer's results merged into one transcript (it may start over after a pause).
    var merger = TranscriptMerger()
    var lastResultAt: Date?
    var lastRaw = ""
    var startedAt = Date()
    var lastChangeAt = Date()
    var lastLevelAt = Date.distantPast
    var audioEndedAt: Date?
    var finished = false
    var timer: DispatchSourceTimer?

    /// After the microphone closes, how long the final result may take before the last partial stands for it.
    static let finalWaitSeconds = 1.5

    init(options: Options, recognizer: SFSpeechRecognizer) {
        self.options = options
        self.recognizer = recognizer
    }

    func start() {
        if let path = options.file {
            startFile(URL(fileURLWithPath: path))
        } else {
            startMicrophone()
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    func configure(_ request: SFSpeechRecognitionRequest) {
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.requiresOnDeviceRecognition = options.onDevice
        if #available(macOS 13, *) { request.addsPunctuation = true }
    }

    func startFile(_ url: URL) {
        let request = SFSpeechURLRecognitionRequest(url: url)
        configure(request)
        self.request = request
        emit(["type": "listening"])
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result: result, error: error) }
        }
    }

    func startMicrophone() {
        guard hasMicrophone() else { return fail("error_no_microphone") }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return fail("error_no_microphone") }
        let request = SFSpeechAudioBufferRecognitionRequest()
        configure(request)
        self.request = request
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            let value = level(of: buffer)
            DispatchQueue.main.async { self?.report(level: value) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            log("audio engine: \(error)")
            input.removeTap(onBus: 0)
            return fail("error_listen_failed")
        }
        startedAt = Date()
        lastChangeAt = startedAt
        emit(["type": "listening"])
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result: result, error: error) }
        }
    }

    func report(level value: Double) {
        guard !finished, audioEndedAt == nil else { return }
        let now = Date()
        // About 15 per second: enough for a wave, little for the pipe.
        guard now.timeIntervalSince(lastLevelAt) >= 0.066 else { return }
        lastLevelAt = now
        emit(["type": "level", "value": (value * 100).rounded() / 100])
    }

    func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        guard !finished else { return }
        if let result {
            let now = Date()
            let raw = result.bestTranscription.formattedString
            let gap = lastResultAt.map { now.timeIntervalSince($0) } ?? 0
            if !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { lastResultAt = now }
            if options.trace {
                let previous = lastRaw
                lastRaw = raw
                // Recorded files only: the words of a live session never leave the process this way.
                let shown = options.file != nil ? " \"\(raw)\"" : ""
                log("raw length=\(raw.count) continues=\(raw.hasPrefix(previous)) gap=\(String(format: "%.2f", gap)) final=\(result.isFinal)\(shown)")
            }
            let text = merger.update(raw, gap: gap)
            let changed = text != transcript
            if changed {
                transcript = text
                lastChangeAt = Date()
            }
            if result.isFinal { return finish() }
            if changed && !text.isEmpty { emit(["type": "words", "text": text, "final": false]) }
        }
        if let error {
            log("recognition: \((error as NSError).domain) \((error as NSError).code) \(error.localizedDescription)")
            // Words already heard stand as the result: the error only ends the session early.
            if !transcript.isEmpty { return finish() }
            fail(errorCode(for: error))
        }
    }

    /// Closes the microphone (stop asked, silence, time limit). The final result follows.
    func endAudio() {
        guard !finished, audioEndedAt == nil else { return }
        audioEndedAt = Date()
        if options.file == nil {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            (request as? SFSpeechAudioBufferRecognitionRequest)?.endAudio()
        }
        emit(["type": "audioEnd"])
    }

    func tick() {
        guard !finished else { return }
        let now = Date()
        if let ended = audioEndedAt {
            // The final result is late: the last partial stands for it.
            if now.timeIntervalSince(ended) >= Session.finalWaitSeconds { finish() }
            return
        }
        guard options.file == nil else {
            // A file is read as fast as the recognizer goes; still never forever.
            if now.timeIntervalSince(startedAt) * 1000 >= Double(options.listenForMs) + 120_000 { fail("error_speech_timeout") }
            return
        }
        if now.timeIntervalSince(startedAt) * 1000 >= Double(options.listenForMs) { return endAudio() }
        if now.timeIntervalSince(lastChangeAt) * 1000 >= Double(options.pauseForMs) { endAudio() }
    }

    func finish() {
        guard !finished else { return }
        if audioEndedAt == nil { endAudio() }
        if transcript.isEmpty { return fail("error_no_match") }
        finished = true
        emit(["type": "words", "text": transcript, "final": true])
        emit(["type": "done"])
        exit(0)
    }

    func fail(_ code: String) {
        guard !finished else { return }
        finished = true
        task?.cancel()
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        emit(["type": "error", "code": code])
        exit(1)
    }

    /// Abandon: no final result. Still a last line, so the reader knows the session is over.
    func cancel() {
        guard !finished else { return }
        finished = true
        task?.cancel()
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        emit(["type": "done"])
        exit(0)
    }
}

func listen(_ options: Options) -> Never {
    if options.file == nil {
        guard accessState() == "granted" else {
            emit(["type": "error", "code": "error_permission"])
            exit(1)
        }
    } else if SFSpeechRecognizer.authorizationStatus() != .authorized {
        emit(["type": "error", "code": "error_permission"])
        exit(1)
    }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: options.locale)) else {
        emit(["type": "error", "code": "error_language_unavailable"])
        exit(1)
    }
    if options.onDevice && !recognizer.supportsOnDeviceRecognition {
        emit(["type": "error", "code": "error_language_unavailable"])
        exit(1)
    }
    if !options.onDevice && !recognizer.isAvailable {
        emit(["type": "error", "code": "error_network"])
        exit(1)
    }
    let session = Session(options: options, recognizer: recognizer)

    // "stop" closes the microphone, "cancel" or the end of stdin ends at once.
    Thread.detachNewThread {
        while let line = readLine() {
            let command = line.trimmingCharacters(in: .whitespaces)
            if command == "stop" { DispatchQueue.main.async { session.endAudio() } }
            if command == "cancel" { DispatchQueue.main.async { session.cancel() } }
        }
        DispatchQueue.main.async { session.cancel() }
    }
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminate.setEventHandler { session.endAudio() }
    terminate.resume()
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    interrupt.setEventHandler { session.cancel() }
    interrupt.resume()

    DispatchQueue.main.async { session.start() }
    // Last resort: whatever happens, the process does not outlive its session.
    let limit = Double(options.listenForMs) / 1000 + (options.file == nil ? 15 : 150)
    DispatchQueue.main.asyncAfter(deadline: .now() + limit) {
        log("watchdog: no end after \(Int(limit)) s")
        session.fail("error_speech_timeout")
    }
    withExtendedLifetime([terminate, interrupt]) { dispatchMain() }
}

// MARK: - Entry

guard let options = parseOptions(Array(CommandLine.arguments.dropFirst())) else {
    log("usage: hermesbot-dictation probe|authorize|listen --locale xx-XX [--on-device] [--listen-for-ms N] [--pause-for-ms N] [--file path]")
    emit(["type": "error", "code": "error_usage"])
    exit(2)
}
switch options.command {
case "probe":
    emit(probeLine(locale: options.locale))
case "authorize":
    authorize(locale: options.locale)
default:
    listen(options)
}

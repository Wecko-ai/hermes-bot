/// One dictation session as far as the microphone goes: it opens once at most, never after a stop or a cancel
/// came first, and closes once. Requests can reach the helper before its session started (a "stop" read from
/// stdin while the main queue had not run the start yet): the microphone must then never open.
public struct SessionGate {
    public enum Phase: Equatable {
        /// Not started: the microphone has not opened.
        case waiting
        /// The microphone is open (or the file is being read).
        case listening
        /// The microphone is closed; the final result may still come.
        case closed
        /// Over: nothing more happens.
        case ended
    }

    public enum StopOutcome: Equatable {
        /// Close the open microphone, then wait for the final result.
        case closeMicrophone
        /// The session had not started: end it without ever opening the microphone.
        case endBeforeStart
        /// Already closed or over.
        case nothing
    }

    public private(set) var phase: Phase = .waiting

    public init() {}

    /// The session starts. True if the microphone may open now: never once a stop or a cancel came first.
    public mutating func open() -> Bool {
        guard phase == .waiting else { return false }
        phase = .listening
        return true
    }

    /// A stop request, or the end of the listening time.
    public mutating func stop() -> StopOutcome {
        switch phase {
        case .waiting:
            phase = .ended
            return .endBeforeStart
        case .listening:
            phase = .closed
            return .closeMicrophone
        case .closed, .ended:
            return .nothing
        }
    }

    /// The session ends (result, error, cancel). True the first time only.
    public mutating func end() -> Bool {
        guard phase != .ended else { return false }
        phase = .ended
        return true
    }

    public var isOver: Bool { phase == .ended }
}

import os

/// Set on the thread that reads stdin when `cancel` arrives, including before `start` runs on the main queue.
/// `start` reads it under the same lock, so a cancel already taken off the pipe cannot lose to the gate opening.
public final class EarlyCancel: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: false)

    public init() {}

    public func mark() {
        state.withLock { $0 = true }
    }

    public var isSet: Bool {
        state.withLock { $0 }
    }
}

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

    /// What `start` does with the gate. `.exitClean` must leave the process (a `done` line, exit 0).
    /// Returning into `dispatchMain` waits for the watchdog instead.
    public enum SessionStart: Equatable, Sendable {
        /// The microphone may open.
        case open
        /// Cancel won, or the gate is no longer waiting.
        case exitClean
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

    /// `start`'s decision. A cancel already read, or a gate that is no longer waiting, does not open
    /// the microphone: the caller exits with a clean status instead of sitting until the watchdog.
    public mutating func begin(cancelled: Bool) -> SessionStart {
        if cancelled || phase != .waiting { return .exitClean }
        phase = .listening
        return .open
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

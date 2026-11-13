import XCTest
@testable import DictationCore

final class SessionGateTests: XCTestCase {
    func testNormalSession() {
        var gate = SessionGate()
        XCTAssertTrue(gate.open())
        XCTAssertEqual(gate.stop(), .closeMicrophone)
        XCTAssertEqual(gate.phase, .closed)
        XCTAssertEqual(gate.stop(), .nothing)
        XCTAssertTrue(gate.end())
        XCTAssertFalse(gate.end())
    }

    func testStopBeforeStartNeverOpensTheMicrophone() {
        var gate = SessionGate()
        XCTAssertEqual(gate.stop(), .endBeforeStart)
        XCTAssertTrue(gate.isOver)
        XCTAssertFalse(gate.open())
    }

    func testCancelBeforeStartNeverOpensTheMicrophone() {
        var gate = SessionGate()
        XCTAssertTrue(gate.end())
        XCTAssertFalse(gate.open())
        XCTAssertEqual(gate.stop(), .nothing)
    }

    func testOpensOnceOnly() {
        var gate = SessionGate()
        XCTAssertTrue(gate.open())
        XCTAssertFalse(gate.open())
    }

    func testErrorWhileListeningEndsOnce() {
        var gate = SessionGate()
        XCTAssertTrue(gate.open())
        XCTAssertTrue(gate.end())
        XCTAssertEqual(gate.stop(), .nothing)
        XCTAssertFalse(gate.open())
    }
}

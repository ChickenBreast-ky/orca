import XCTest

final class AgentEntrypointSourceSafetyTests: XCTestCase {
    func testAgentEntrypointDoesNotUnlinkCallerSuppliedPaths() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let mainPath = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("OrcaComputerUseMacOS")
            .appendingPathComponent("main.swift")
        let source = try String(contentsOf: mainPath, encoding: .utf8)

        // Why: --agent accepts caller-supplied paths; deleting them in the
        // helper can remove user files if argument validation is bypassed.
        XCTAssertFalse(source.contains("unlink(tokenPath)"))
        XCTAssertFalse(source.contains("unlink(socketPath)"))
    }

    func testSyntheticModifiersHaveGuaranteedReleaseAndModifiedClicksUseFlags() throws {
        let source = try agentEntrypointSource()

        XCTAssertTrue(source.contains("var pressedModifiers: [KeyModifier] = []"))
        XCTAssertTrue(source.contains(
            """
            defer {
                        for modifier in pressedModifiers.reversed() {
                            flags.remove(modifier.flag)
                            try? keyEvent(modifier.keyCode, down: false, flags: flags, pid: pid)
            """
        ))
        XCTAssertTrue(source.contains("event.flags = flags\n        event.postToPid(pid)"))
    }

    func testTrustedPeerBundleAllowlistUsesExactProductIdentityBoundaries() throws {
        let source = try agentEntrypointSource()

        // Why: peer authorization must distinguish the product/helper family from lookalike IDs.
        let allowedRules = [
            #"bundleId == "com.chickenbreastky.orca-kyle""#,
            #"bundleId.hasPrefix("com.chickenbreastky.orca-kyle.")"#,
            #"bundleId == "com.stablyai.orca""#,
            #"bundleId.hasPrefix("com.stablyai.orca.dev.")"#,
            #"bundleId == "com.github.Electron""#,
        ]
        for rule in allowedRules {
            XCTAssertTrue(source.contains(rule), "Missing trusted peer rule: \(rule)")
        }

        let rejectedLookalikeRules = [
            #"bundleId == "com.chickenbreastky""#,
            #"bundleId == "com.chickenbreastky.orca-kyle-other""#,
            #"bundleId == "com.chickenbreastky.orca-kylex""#,
            #"bundleId.hasPrefix("com.chickenbreastky")"#,
            #"bundleId.hasPrefix("com.chickenbreastky.orca-kyle")"#,
        ]
        for rule in rejectedLookalikeRules {
            XCTAssertFalse(source.contains(rule), "Unexpected trusted peer rule: \(rule)")
        }
    }

    private func agentEntrypointSource() throws -> String {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let mainPath = packageRoot
            .appendingPathComponent("Sources")
            .appendingPathComponent("OrcaComputerUseMacOS")
            .appendingPathComponent("main.swift")
        return try String(contentsOf: mainPath, encoding: .utf8)
    }
}

import AppKit
import ApplicationServices
import Darwin
import Foundation

/// Desktop-wide input ownership and a durable write-ahead record of injected downs.
/// A guardian/new owner performs recovery under the same lock before accepting input.
final class DesktopLeaseGuard {
    private struct Journal: Codable {
        let version: Int
        let ownerId: String
        let keys: [UInt16]
        let mouseButtons: [UInt32]
        let targetPid: Int32?
        let targetLaunchedAt: TimeInterval?
    }
    private let directory: URL
    private var descriptor: Int32 = -1
    private var guardian: Process?
    private var guardianInput: FileHandle?
    private(set) var ownerId: String?
    private var lastRecord: Data?

    init() throws {
        directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/QiuYaTools/computer-lease", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    private func lock() throws {
        let path = directory.appendingPathComponent("desktop.lock").path
        let fd = Darwin.open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ComputerError("DESKTOP_LOCK_FAILED", "The desktop input lock is unavailable.") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & S_IFMT) == S_IFREG else {
            Darwin.close(fd); throw ComputerError("DESKTOP_LOCK_FAILED", "The desktop input lock has an unexpected owner or type.")
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd); throw ComputerError("DESKTOP_BUSY", "Another QiuYaTools companion owns this desktop. Pause it before taking control.")
        }
        descriptor = fd
    }

    func acquire() throws {
        guard descriptor < 0 else { throw ComputerError("DESKTOP_BUSY", "This companion already owns a desktop input lease.") }
        try lock()
        do {
            try recoverJournal()
            ownerId = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            try record(keys: [], mouse: nil, targetPid: nil)
            try startGuardian()
        } catch { unlock(); throw error }
    }

    func record(keys: Set<CGKeyCode>, mouse: CGMouseButton?, targetPid: pid_t?) throws {
        guard descriptor >= 0, let ownerId else { throw ComputerError("DESKTOP_LEASE_REQUIRED", "A desktop input lease is required.") }
        let journal = Journal(version: 1, ownerId: ownerId, keys: keys.sorted(), mouseButtons: mouse.map { [$0.rawValue] } ?? [],
            targetPid: targetPid, targetLaunchedAt: targetPid.flatMap { NSRunningApplication(processIdentifier: $0)?.launchDate?.timeIntervalSince1970 })
        let data = try JSONEncoder().encode(journal)
        guard lastRecord != data else { return }
        let temporary = directory.appendingPathComponent("journal-\(getpid())-\(UUID().uuidString).tmp").path
        let fd = Darwin.open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ComputerError("INPUT_JOURNAL_FAILED", "Owned input could not be recorded before injection.") }
        defer { Darwin.close(fd); unlink(temporary) }
        let written = data.withUnsafeBytes { bytes in Darwin.write(fd, bytes.baseAddress, bytes.count) }
        guard written == data.count, fsync(fd) == 0,
              rename(temporary, directory.appendingPathComponent("owned-input.json").path) == 0 else {
            throw ComputerError("INPUT_JOURNAL_FAILED", "Owned input could not be durably recorded. Control remains blocked.")
        }
        let directoryFD = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC)
        if directoryFD >= 0 { _ = fsync(directoryFD); Darwin.close(directoryFD) }
        lastRecord = data
    }

    private func recoverJournal() throws {
        let path = directory.appendingPathComponent("owned-input.json")
        guard FileManager.default.fileExists(atPath: path.path) else { return }
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path.path), let size = attributes[.size] as? NSNumber, size.intValue <= 16_384,
              let data = try? Data(contentsOf: path), let journal = try? JSONDecoder().decode(Journal.self, from: data), journal.version == 1,
              journal.ownerId.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil, journal.keys.count <= 32, journal.keys.allSatisfy({ $0 <= 255 }),
              journal.mouseButtons.count <= 3, journal.mouseButtons.allSatisfy({ $0 <= 2 }) else {
            throw ComputerError("INPUT_JOURNAL_INVALID", "The previous owner's input journal cannot be read safely. Control remains blocked.")
        }
        if !journal.keys.isEmpty || !journal.mouseButtons.isEmpty {
            guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw ComputerError("INPUT_CLEANUP_FAILED", "Accessibility permission is required to recover the previous owner's input.") }
            let source = CGEventSource(stateID: .hidSystemState)
            let point = CGEvent(source: nil)?.location ?? .zero
            for raw in journal.mouseButtons {
                guard let button = CGMouseButton(rawValue: raw), let event = CGEvent(mouseEventSource: source,
                    mouseType: button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp,
                    mouseCursorPosition: point, mouseButton: button) else { throw ComputerError("INPUT_CLEANUP_FAILED", "The previous owner's mouse release could not be created.") }
                event.post(tap: .cghidEventTap)
            }
            if let pid = journal.targetPid, let process = NSRunningApplication(processIdentifier: pid),
               process.launchDate?.timeIntervalSince1970 == journal.targetLaunchedAt {
                for key in journal.keys {
                    guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else { throw ComputerError("INPUT_CLEANUP_FAILED", "The previous owner's key release could not be created.") }
                    event.flags = []; event.postToPid(pid)
                }
            }
            // CGEvent posting has no delivery acknowledgement. Verify the observable button
            // state before granting a new owner, and retain the journal if cleanup is uncertain.
            for _ in 0..<20 {
                if journal.mouseButtons.allSatisfy({ !CGEventSource.buttonState(.combinedSessionState, button: CGMouseButton(rawValue: $0)!) }) { break }
                usleep(10_000)
            }
            guard journal.mouseButtons.allSatisfy({ !CGEventSource.buttonState(.combinedSessionState, button: CGMouseButton(rawValue: $0)!) }) else {
                throw ComputerError("INPUT_CLEANUP_FAILED", "The previous owner's mouse release is not confirmed. Control remains blocked.")
            }
        }
        try FileManager.default.removeItem(at: path)
    }

    func release() throws {
        guard descriptor >= 0 else { return }
        let path = directory.appendingPathComponent("owned-input.json")
        if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
        unlock()
    }

    private func unlock() {
        ownerId = nil; lastRecord = nil
        if descriptor >= 0 { _ = flock(descriptor, LOCK_UN); Darwin.close(descriptor); descriptor = -1 }
    }

    private func startGuardian() throws {
        if guardian?.isRunning == true { return }
        let pipe = Pipe(), child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["--input-guardian"]
        child.standardInput = pipe
        child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        try child.run()
        pipe.fileHandleForReading.closeFile()
        guardian = child; guardianInput = pipe.fileHandleForWriting
    }

    static func runGuardian() {
        _ = FileHandle.standardInput.readDataToEndOfFile()
        do {
            let guardFile = try DesktopLeaseGuard()
            try guardFile.lock()
            try guardFile.recoverJournal()
        } catch let error as ComputerError where error.code == "DESKTOP_BUSY" {
            // A new owner already recovers the journal before input under this same lock.
        } catch { exit(1) }
    }

    deinit { unlock(); guardianInput?.closeFile() }
}

import Darwin
import Foundation

/// LaunchServices owns the application process; the authenticated socket owns
/// its lifetime. Standard input remains the default for existing test helpers.
struct MacTransportArguments: Equatable {
    let socketPath: String
    let nonce: String
    let ownerPid: Int32

    static func parse(_ arguments: [String]) throws -> Self? {
        let names = ["--qiuya-control-socket", "--qiuya-control-nonce", "--qiuya-owner-pid"]
        guard arguments.contains(where: { $0.hasPrefix("--qiuya-") }) else { return nil }
        guard arguments.count == 6 else { throw invalid() }
        var values: [String: String] = [:]
        for index in stride(from: 0, to: arguments.count, by: 2) {
            guard names.contains(arguments[index]), values[arguments[index]] == nil else { throw invalid() }
            values[arguments[index]] = arguments[index + 1]
        }
        guard let path = values[names[0]], path.hasPrefix("/"), path.utf8.count <= 103,
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              let nonce = values[names[1]], nonce.utf8.count == 64,
              nonce.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let rawPid = values[names[2]], !rawPid.isEmpty, rawPid.first != "0",
              rawPid.utf8.allSatisfy({ (48...57).contains($0) }), let pid = Int32(rawPid), pid > 1 else { throw invalid() }
        return Self(socketPath: path, nonce: nonce, ownerPid: pid)
    }

    private static func invalid() -> ComputerError {
        ComputerError("NATIVE_TRANSPORT_ARGUMENTS", "The application control connection is invalid.")
    }
}

struct MacProcessIdentity: Equatable {
    let pid: Int32
    let uid: UInt32
    let startSeconds: UInt64
    let startMicroseconds: UInt64
    let uniqueId: UInt64

    static func read(_ pid: Int32) -> Self? {
        guard pid > 1, kill(pid, 0) == 0 else { return nil }
        var first = proc_bsdinfo(), after = proc_bsdinfo()
        let count = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &first, count) == count, first.pbi_uid == getuid() else { return nil }
        // PROC_PIDUNIQIDENTIFIERINFO is also used by the independent lifetime
        // fixtures. Fail closed if the kernel cannot provide a birth identity.
        var identifiers = [UInt64](repeating: 0, count: 7)
        let bytes = identifiers.withUnsafeMutableBytes { proc_pidinfo(pid, 17, 0, $0.baseAddress, Int32($0.count)) }
        guard bytes == 56, identifiers[2] > 0,
              proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, count) == count,
              first.pbi_start_tvsec == after.pbi_start_tvsec, first.pbi_start_tvusec == after.pbi_start_tvusec,
              first.pbi_uid == after.pbi_uid, kill(pid, 0) == 0 else { return nil }
        return Self(pid: pid, uid: first.pbi_uid, startSeconds: first.pbi_start_tvsec,
                    startMicroseconds: first.pbi_start_tvusec, uniqueId: identifiers[2])
    }

    var birth: [String: String] {
        ["startSeconds": String(startSeconds), "startMicroseconds": String(startMicroseconds), "uniqueId": String(uniqueId)]
    }
}

enum MacOwnerPolicy {
    static func current(expected: MacProcessIdentity, actual: MacProcessIdentity?, alive: Bool) -> Bool {
        alive && actual == expected
    }
}

enum MacSocketPathPolicy {
    /// Foundation rewrites /private/tmp back to /tmp on some macOS versions.
    /// Use POSIX realpath, matching Node's fs.realpath at the socket owner.
    static func canonicalDirectory(_ path: String) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard Darwin.realpath(path, &buffer) != nil else { return nil }
        return String(cString: buffer)
    }
}

struct MacTransportLifetime {
    enum Phase { case prepared, ready, retired, closed }
    private(set) var phase: Phase = .prepared
    mutating func markReady() -> Bool { guard phase == .prepared else { return false }; phase = .ready; return true }
    mutating func markRetired() -> Bool { guard phase == .ready else { return false }; phase = .retired; return true }
    mutating func markClosed() { phase = .closed }
}

/// Bounded before UTF-8 or JSON decoding, including a line without a newline.
struct MacJSONLineDecoder {
    let maximumBytes: Int
    private var buffer = Data()

    init(maximumBytes: Int = 2_000_000) { self.maximumBytes = maximumBytes }

    mutating func append(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let end = buffer.firstIndex(of: 10) {
            guard buffer.distance(from: buffer.startIndex, to: end) <= maximumBytes else { throw oversized() }
            if end > buffer.startIndex { lines.append(Data(buffer[..<end])) }
            buffer.removeSubrange(...end)
        }
        guard buffer.count <= maximumBytes else { throw oversized() }
        return lines
    }

    mutating func finish() throws -> Data? {
        guard buffer.count <= maximumBytes else { throw oversized() }
        defer { buffer.removeAll() }
        return buffer.isEmpty ? nil : buffer
    }

    private func oversized() -> ComputerError {
        ComputerError("NATIVE_MESSAGE_LIMIT", "The application control message exceeds its limit.")
    }
}

// Immutable peer/file identities cross queues. One background reader owns line
// decoding; Wire serializes writes, and the close lock protects lifecycle state.
final class MacControlTransport: @unchecked Sendable {
    let arguments: MacTransportArguments?
    let owner: MacProcessIdentity?
    private let connection: FileHandle?
    private let ownIdentity: MacProcessIdentity?
    private let closeLock = NSLock()
    private var lifetime = MacTransportLifetime()

    init(arguments: [String]) throws {
        self.arguments = try MacTransportArguments.parse(arguments)
        guard let configuration = self.arguments else { owner = nil; ownIdentity = nil; connection = nil; return }
        guard Bundle.main.bundleIdentifier == "com.qiuya.tools.computer-use",
              configuration.ownerPid != getpid(), let owner = MacProcessIdentity.read(configuration.ownerPid),
              let own = MacProcessIdentity.read(getpid()) else { throw Self.unavailable() }
        let original = try Self.validateSocket(configuration.socketPath)
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw Self.unavailable() }
        var connected = false
        defer { if !connected { Darwin.close(descriptor) } }
        var noSignal: Int32 = 1
        guard setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw Self.unavailable() }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(configuration.socketPath.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { destination in destination.copyBytes(from: pathBytes) }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        address.sun_len = UInt8(length)
        let flags = fcntl(descriptor, F_GETFL)
        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { throw Self.unavailable() }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(descriptor, $0, length) }
        }
        if result != 0 {
            guard errno == EINPROGRESS || errno == EAGAIN else { throw Self.unavailable() }
            var pending = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
            guard poll(&pending, 1, 3000) > 0, pending.revents & Int16(POLLOUT) != 0 else { throw Self.unavailable() }
            var error: Int32 = 0, errorSize = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &error, &errorSize) == 0, error == 0 else { throw Self.unavailable() }
        }
        guard fcntl(descriptor, F_SETFL, flags) == 0 else { throw Self.unavailable() }
        var peer: Int32 = 0, peerSize = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &peer, &peerSize) == 0,
              peerSize == MemoryLayout<Int32>.size, peer == owner.pid,
              MacOwnerPolicy.current(expected: owner, actual: MacProcessIdentity.read(owner.pid), alive: kill(owner.pid, 0) == 0) else { throw Self.unavailable() }
        let after = try Self.validateSocket(configuration.socketPath)
        guard original == after else { throw Self.unavailable() }
        self.owner = owner; ownIdentity = own
        connection = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        connected = true
    }

    var isLaunchServices: Bool { arguments != nil }
    var output: FileHandle { connection ?? FileHandle.standardOutput }

    func ownerIsCurrent() -> Bool {
        guard let owner else { return true }
        return MacOwnerPolicy.current(expected: owner, actual: MacProcessIdentity.read(owner.pid), alive: kill(owner.pid, 0) == 0)
    }

    func ready() -> [String: Any]? {
        closeLock.lock(); defer { closeLock.unlock() }
        guard let arguments, let ownIdentity else { return nil }
        guard lifetime.markReady() else { return nil }
        return ["event": "launchReady", "nonce": arguments.nonce, "pid": Int(getpid()), "ownerPid": Int(arguments.ownerPid),
                "bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "nativeBirth": ownIdentity.birth]
    }

    func retired(inputReleased: Bool, captureStopped: Bool) -> [String: Any]? {
        closeLock.lock(); defer { closeLock.unlock() }
        guard let arguments else { return nil }
        guard lifetime.markRetired() else { return nil }
        return ["event": "launchRetired", "nonce": arguments.nonce, "pid": Int(getpid()), "ownerPid": Int(arguments.ownerPid),
                "inputReleased": inputReleased, "captureStopped": captureStopped]
    }

    func readCommands(_ receive: @escaping ([String: Any]) -> Void) throws {
        let descriptor = connection?.fileDescriptor ?? STDIN_FILENO
        var decoder = MacJSONLineDecoder(), bytes = [UInt8](repeating: 0, count: 8192)
        func deliver(_ line: Data) {
            guard let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
            receive(command)
        }
        while true {
            let count = Darwin.read(descriptor, &bytes, bytes.count)
            if count < 0 { if errno == EINTR { continue }; throw Self.unavailable() }
            if count == 0 { if let tail = try decoder.finish() { deliver(tail) }; return }
            for line in try decoder.append(Data(bytes[0..<count])) { deliver(line) }
        }
    }

    func close() {
        closeLock.lock(); defer { closeLock.unlock() }
        guard lifetime.phase != .closed else { return }; lifetime.markClosed()
        guard let connection else { return }
        _ = Darwin.shutdown(connection.fileDescriptor, SHUT_RDWR)
        try? connection.close()
    }

    private struct SocketIdentity: Equatable { let device: Int32; let inode: UInt64 }
    private static func validateSocket(_ path: String) throws -> SocketIdentity {
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent()
        guard MacSocketPathPolicy.canonicalDirectory(parent.path) == parent.path else { throw unavailable() }
        var directory = stat(), socket = stat()
        guard lstat(parent.path, &directory) == 0, directory.st_uid == getuid(), directory.st_mode & S_IFMT == S_IFDIR,
              directory.st_mode & 0o777 == 0o700,
              lstat(path, &socket) == 0, socket.st_uid == getuid(), socket.st_mode & S_IFMT == S_IFSOCK,
              socket.st_mode & 0o777 == 0o600 else { throw unavailable() }
        return SocketIdentity(device: socket.st_dev, inode: socket.st_ino)
    }

    private static func unavailable() -> ComputerError {
        ComputerError("NATIVE_TRANSPORT_UNAVAILABLE", "The application control connection could not be verified.")
    }

    deinit { close() }
}

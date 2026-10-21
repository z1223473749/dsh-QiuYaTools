import AppKit
import Darwin
import Foundation

struct NativeApplicationMetadata {
    let appId: String
    let name: String
    let running: Bool
    let launchable: Bool
    var json: [String: Any] { ["appId": appId, "name": name, "running": running, "launchable": launchable] }
}

private struct ApplicationFileIdentity: Equatable {
    let device: Int64, inode: UInt64, size: Int64, modifiedSeconds: Int64, modifiedNanoseconds: Int64, changedSeconds: Int64, changedNanoseconds: Int64
    init?(_ path: String, directory: Bool) {
        var value = stat()
        guard lstat(path, &value) == 0, (value.st_mode & S_IFMT) == (directory ? S_IFDIR : S_IFREG) else { return nil }
        device = Int64(value.st_dev); inode = UInt64(value.st_ino); size = Int64(value.st_size)
        modifiedSeconds = Int64(value.st_mtimespec.tv_sec); modifiedNanoseconds = Int64(value.st_mtimespec.tv_nsec)
        changedSeconds = Int64(value.st_ctimespec.tv_sec); changedNanoseconds = Int64(value.st_ctimespec.tv_nsec)
    }
}

private struct RegisteredApplication {
    let appId: String, name: String, url: URL, executable: String
    let bundleIdentity: ApplicationFileIdentity, infoIdentity: ApplicationFileIdentity, executableIdentity: ApplicationFileIdentity
    func sameInstallation(_ other: RegisteredApplication) -> Bool {
        appId == other.appId && url == other.url && executable == other.executable && bundleIdentity == other.bundleIdentity && infoIdentity == other.infoIdentity && executableIdentity == other.executableIdentity
    }
}

/// Standard application directories only. App paths stay inside this process;
/// callers receive bounded identity/display metadata, never command lines.
@MainActor final class NativeApplicationCatalog {
    private var listed: [String: RegisteredApplication] = [:]
    private var listing = false
    private var roots: [URL] {
        [URL(fileURLWithPath: "/Applications", isDirectory: true), URL(fileURLWithPath: "/System/Applications", isDirectory: true),
         URL(fileURLWithPath: "/System/Library/CoreServices", isDirectory: true),
         FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true)]
    }
    nonisolated static func validAppId(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\\z", options: .regularExpression) != nil }
    nonisolated static func displayName(_ value: String) -> String {
        let scalars = value.unicodeScalars.lazy.map { CharacterSet.controlCharacters.contains($0) ? UnicodeScalar(32)! : $0 }.prefix(160)
        return String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private nonisolated static func read(_ input: URL, roots: [URL]) -> RegisteredApplication? {
        guard input.pathExtension.lowercased() == "app", let bundleIdentity = ApplicationFileIdentity(input.path, directory: true) else { return nil }
        let url = input.resolvingSymlinksInPath().standardizedFileURL
        let infoURL = url.appendingPathComponent("Contents/Info.plist")
        guard url.path == input.standardizedFileURL.path, roots.contains(where: { url.path.hasPrefix($0.path + "/") }),
              infoURL.resolvingSymlinksInPath().path == infoURL.path,
              let infoIdentity = ApplicationFileIdentity(infoURL.path, directory: false),
              infoIdentity.size > 0, infoIdentity.size <= 1024 * 1024,
              let data = try? Data(contentsOf: url.appendingPathComponent("Contents/Info.plist")),
              let info = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let appId = info["CFBundleIdentifier"] as? String, validAppId(appId),
              let file = info["CFBundleExecutable"] as? String, !file.isEmpty, file.utf8.count <= 255,
              file != ".", file != "..", !file.contains("/"), !file.contains("\\") else { return nil }
        let executable = url.appendingPathComponent("Contents/MacOS").appendingPathComponent(file).path
        guard URL(fileURLWithPath: executable).resolvingSymlinksInPath().path == executable,
              let executableIdentity = ApplicationFileIdentity(executable, directory: false), access(executable, X_OK) == 0 else { return nil }
        let rawName = info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? input.deletingPathExtension().lastPathComponent
        let name = displayName(rawName)
        guard !name.isEmpty else { return nil }
        return RegisteredApplication(appId: appId, name: name, url: url, executable: executable,
            bundleIdentity: bundleIdentity, infoIdentity: infoIdentity, executableIdentity: executableIdentity)
    }
    func applications() async throws -> [String: Any] {
        guard !listing else { throw ComputerError("APPLICATIONS_BUSY", "An application list is already being prepared.") }
        listing = true; defer { listing = false }
        let running = NSWorkspace.shared.runningApplications.compactMap { application -> (String, String)? in
            guard !application.isTerminated, let id = application.bundleIdentifier, Self.validAppId(id) else { return nil }
            let name = Self.displayName(application.localizedName ?? id); return name.isEmpty ? nil : (id, name)
        }
        let roots = self.roots.map { $0.resolvingSymlinksInPath().standardizedFileURL }
        let result = await Task.detached(priority: .utility) { () -> ([String: RegisteredApplication], Bool) in
            let deadline = ProcessInfo.processInfo.systemUptime + 2
            var found: [String: RegisteredApplication] = [:], ambiguous = Set<String>(), visited = 0, truncated = false
            for root in roots {
                guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
                while let url = enumerator.nextObject() as? URL {
                    visited += 1
                    if visited > 6000 || found.count >= 512 || ProcessInfo.processInfo.systemUptime >= deadline { truncated = true; break }
                    if enumerator.level > 3 { enumerator.skipDescendants(); continue }
                    if (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true { enumerator.skipDescendants(); continue }
                    guard url.pathExtension.lowercased() == "app" else { continue }
                    enumerator.skipDescendants()
                    guard let application = Self.read(url, roots: roots), !ambiguous.contains(application.appId) else { continue }
                    if let previous = found[application.appId], previous.url != application.url {
                        found.removeValue(forKey: application.appId); ambiguous.insert(application.appId)
                    } else { found[application.appId] = application }
                }
                if truncated { break }
            }
            return (found, truncated)
        }.value
        listed = result.0
        var metadata = listed.mapValues { NativeApplicationMetadata(appId: $0.appId, name: $0.name, running: false, launchable: true) }
        for (id, name) in running { metadata[id] = NativeApplicationMetadata(appId: id, name: name, running: true, launchable: listed[id] != nil) }
        let ordered = metadata.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return ["applications": ordered.prefix(512).map { $0.json }, "truncated": result.1 || ordered.count > 512]
    }
    func launch(_ appId: String) async throws -> [String: Any] {
        guard Self.validAppId(appId), let expected = listed[appId] else { throw ComputerError("APPLICATION_NOT_LISTED", "Refresh applications and select a launchable installed application.") }
        let roots = self.roots.map { $0.resolvingSymlinksInPath().standardizedFileURL }
        let current = await Task.detached(priority: .utility) { Self.read(expected.url, roots: roots) }.value
        guard let current, expected.sameInstallation(current) else { listed.removeValue(forKey: appId); throw ComputerError("APPLICATION_CHANGED", "The selected application changed. Refresh the application list.") }
        let configuration = NSWorkspace.OpenConfiguration(); configuration.arguments = []; configuration.activates = true
        let launched = await withCheckedContinuation { continuation in
            NSWorkspace.shared.openApplication(at: expected.url, configuration: configuration) { app, error in continuation.resume(returning: app != nil && error == nil) }
        }
        guard launched else { throw ComputerError("APPLICATION_LAUNCH_FAILED", "The selected application could not be opened.") }
        return ["launched": true, "appId": appId]
    }
    static func settingsURL(_ kind: Any?) throws -> (String, URL) {
        guard let kind = kind as? String else { throw ComputerError("INVALID_PERMISSION_KIND", "Select a supported system permission.") }
        let pane: String
        switch kind {
        case "screenRecording": pane = "Privacy_ScreenCapture"
        case "accessibility": pane = "Privacy_Accessibility"
        case "inputMonitoring": pane = "Privacy_ListenEvent"
        default: throw ComputerError("INVALID_PERMISSION_KIND", "Select a supported system permission.")
        }
        return (kind, URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
    }
    static func openSystemSettings(_ kind: Any?) throws -> [String: Any] {
        let (kind, url) = try settingsURL(kind)
        let opened = NSWorkspace.shared.open(url)
        return ["opened": opened, "kind": kind, "supported": true]
    }
}

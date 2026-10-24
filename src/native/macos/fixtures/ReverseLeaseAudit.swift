import Darwin
import Foundation

// Test-only post-exit observation. Never creates a lock/journal, recovers input,
// starts a companion, requests TCC or sends an event/signal.
let scope = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/QiuYaTools/computer-lease", isDirectory: true)
var result: [String: Any] = ["passed": false, "inputPosted": false, "leaseScopeExists": false, "lockFileVerified": false, "leaseFree": false, "journalAbsent": false]
func fail(_ reason: String) -> Never {
    result["reason"] = reason
    let bytes = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes + Data([10])); exit(1)
}
var directoryInfo = stat()
guard lstat(scope.path, &directoryInfo) == 0, directoryInfo.st_uid == getuid(), (directoryInfo.st_mode & S_IFMT) == S_IFDIR, directoryInfo.st_mode & 0o077 == 0 else { fail("LEASE_SCOPE_UNVERIFIED") }
result["leaseScopeExists"] = true
let directoryFD = open(scope.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY)
guard directoryFD >= 0 else { fail("LEASE_SCOPE_UNREADABLE") }
var pinnedDirectory = stat()
guard fstat(directoryFD, &pinnedDirectory) == 0, pinnedDirectory.st_dev == directoryInfo.st_dev, pinnedDirectory.st_ino == directoryInfo.st_ino else { close(directoryFD); fail("LEASE_SCOPE_CHANGED") }
let fd = openat(directoryFD, "desktop.lock", O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
guard fd >= 0 else { close(directoryFD); fail("LEASE_LOCK_UNREADABLE") }
var lockInfo = stat()
guard fstat(fd, &lockInfo) == 0, lockInfo.st_uid == getuid(), (lockInfo.st_mode & S_IFMT) == S_IFREG, lockInfo.st_mode & 0o077 == 0 else { close(fd); close(directoryFD); fail("LEASE_LOCK_UNVERIFIED") }
result["lockFileVerified"] = true
guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); close(directoryFD); fail("LEASE_STILL_OWNED") }
result["leaseFree"] = true
var journal = stat()
let journalResult = fstatat(directoryFD, "owned-input.json", &journal, AT_SYMLINK_NOFOLLOW)
let journalErrno = errno
var currentLock = stat(), currentDirectory = stat()
let stable = fstatat(directoryFD, "desktop.lock", &currentLock, AT_SYMLINK_NOFOLLOW) == 0 && currentLock.st_dev == lockInfo.st_dev && currentLock.st_ino == lockInfo.st_ino && lstat(scope.path, &currentDirectory) == 0 && currentDirectory.st_dev == directoryInfo.st_dev && currentDirectory.st_ino == directoryInfo.st_ino
let unlocked = flock(fd, LOCK_UN) == 0
close(fd); close(directoryFD)
guard unlocked, stable else { fail("LEASE_AUDIT_IDENTITY_CHANGED") }
guard journalResult != 0, journalErrno == ENOENT else { fail(journalResult == 0 ? "INPUT_JOURNAL_PRESENT" : "INPUT_JOURNAL_UNREADABLE") }
result["journalAbsent"] = true; result["passed"] = true
let bytes = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(bytes + Data([10]))

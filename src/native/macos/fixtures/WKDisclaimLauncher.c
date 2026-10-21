// Test carrier only: preserve the NativeDriver PID, parent and stdio by exec.
// This SPI is also dynamically resolved by LLVM LLDB's
// lldb/source/Host/macosx/objcxx/PosixSpawnResponsible.h. It changes macOS TCC
// responsibility; production helpers and installed-Host tests do not use it.
// https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/posix_spawnattr_getflags.3.html
#include <crt_externs.h>
#include <dlfcn.h>
#include <errno.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef int (*SetDisclaim)(posix_spawnattr_t *, bool);

static int fail(const char *stage, int code) {
    // stdout remains exclusively the unchanged production helper's protocol.
    fprintf(stderr, "{\"testCarrier\":\"wk-responsibility-setexec\",\"stage\":\"%s\",\"code\":%d}\n", stage, code);
    return 71;
}

int main(int argc, char *argv[]) {
    if (argc < 2 || argv[1][0] != '/' || strlen(argv[1]) > 4095) return fail("absolute-target-required", EINVAL);
    SetDisclaim disclaim = (SetDisclaim)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
    if (!disclaim) return fail("responsibility-spi-unavailable", ENOSYS);
    posix_spawnattr_t attributes;
    int result = posix_spawnattr_init(&attributes);
    if (result) return fail("spawnattr-init", result);
    result = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT);
    if (result) { posix_spawnattr_destroy(&attributes); return fail("spawnattr-flags", result); }
    result = disclaim(&attributes, true);
    if (result) { posix_spawnattr_destroy(&attributes); return fail("responsibility-disclaim", result); }
    posix_spawn_file_actions_t actions;
    result = posix_spawn_file_actions_init(&actions);
    if (result) { posix_spawnattr_destroy(&attributes); return fail("file-actions-init", result); }
    for (int fd = STDIN_FILENO; fd <= STDERR_FILENO; fd++) {
        result = posix_spawn_file_actions_addinherit_np(&actions, fd);
        if (result) { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes); return fail("inherit-stdio", result); }
    }
    pid_t pid = -1;
    result = posix_spawn(&pid, argv[1], &actions, &attributes, &argv[1], *_NSGetEnviron());
    posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes);
    // Successful SETEXEC never returns. No fallback to an ordinary spawn is
    // allowed, since that would invalidate the attribution experiment.
    return fail("setexec-returned", result ? result : EIO);
}

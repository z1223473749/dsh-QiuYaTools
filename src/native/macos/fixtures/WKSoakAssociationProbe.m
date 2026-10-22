// Test-only soak instrumentation, explicitly inserted into an owned helper. No production protocol,
// WebKit state, TCC policy, process responsibility or window ordering is changed.
// SPI sources (runtime availability/ABI must still be checked):
// https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm
// https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebsiteDataStore.mm
// https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebsiteData/WebsiteDataStore.cpp
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <libproc.h>
#import <sys/proc_info.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <mach/mach_time.h>

static NSDictionary *ProcessIdentity(pid_t pid) {
    struct proc_bsdinfo first = {0}, after = {0}; uint64_t unique[7] = {0}, last[7] = {0}; char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &first, sizeof first) != sizeof first || first.pbi_uid != getuid() ||
        proc_pidinfo(pid, 17, 0, unique, sizeof unique) != sizeof unique || !unique[2] ||
        proc_pidpath(pid, path, sizeof path) <= 0) return nil;
    struct stat file = {0}; if (stat(path, &file) || !S_ISREG(file.st_mode)) return nil;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof after) != sizeof after ||
        proc_pidinfo(pid, 17, 0, last, sizeof last) != sizeof last || unique[2] != last[2] ||
        first.pbi_start_tvsec != after.pbi_start_tvsec || first.pbi_start_tvusec != after.pbi_start_tvusec) return nil;
    return @{ @"pid": @(pid), @"parentPid": @(first.pbi_ppid), @"uid": @(first.pbi_uid),
        @"birthMicros": [NSString stringWithFormat:@"%llu", (uint64_t)first.pbi_start_tvsec * 1000000ULL + first.pbi_start_tvusec],
        @"uniqueId": [NSString stringWithFormat:@"%llu", unique[2]], @"path": @(path),
        @"device": [NSString stringWithFormat:@"%llu", (uint64_t)file.st_dev], @"inode": [NSString stringWithFormat:@"%llu", (uint64_t)file.st_ino] };
}
static NSString *SystemKind(NSDictionary *identity) {
    if (!identity) return nil;
    for (NSString *kind in @[@"WebContent", @"Networking", @"GPU"]) {
        NSString *name = [@"com.apple.WebKit." stringByAppendingString:kind];
        NSString *path = [NSString stringWithFormat:@"/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/%@.xpc/Contents/MacOS/%@", name, name];
        struct stat file = {0};
        if (!stat(path.fileSystemRepresentation, &file) && file.st_uid == 0 && S_ISREG(file.st_mode) &&
            [identity[@"device"] isEqual:[NSString stringWithFormat:@"%llu", (uint64_t)file.st_dev]] &&
            [identity[@"inode"] isEqual:[NSString stringWithFormat:@"%llu", (uint64_t)file.st_ino]]) return kind;
    }
    return nil;
}
static BOOL GetterABI(id object, SEL selector, const char *returnType) {
    Method method = class_getInstanceMethod([object class], selector);
    if (!method || method_getNumberOfArguments(method) != 2) return NO;
    char *type = method_copyReturnType(method); BOOL valid = type && !strcmp(type, returnType); free(type); return valid;
}
static NSNumber *ReadPID(id object, NSString *name) {
    SEL selector = NSSelectorFromString(name);
    if (!GetterABI(object, selector, @encode(pid_t))) return nil;
    @try { pid_t value = ((pid_t (*)(id, SEL))objc_msgSend)(object, selector); return value > 0 ? @(value) : nil; }
    @catch (__unused NSException *error) { return nil; }
}
static NSNumber *ReadExists(id store) {
    SEL selector = NSSelectorFromString(@"_networkProcessExists");
    if (!GetterABI(store, selector, @encode(BOOL))) return nil;
    @try { return @(((BOOL (*)(id, SEL))objc_msgSend)(store, selector)); }
    @catch (__unused NSException *error) { return nil; }
}
static NSDictionary *ReadNetworkPID(id store) {
    if (!NSThread.isMainThread) return @{ @"verified": @NO, @"reason": @"network-getter-not-on-main-thread" };
    // All calls stay on this same synchronous MainActor/run-loop stack. Reading
    // _networkProcessIdentifier without an existing proxy can launch one; NEVER
    // call it in that case. No event-loop spin, async hop or retry-create here.
    NSNumber *before = ReadExists(store);
    if (!before || !before.boolValue) return @{ @"verified": @NO, @"reason": @"network-proxy-not-confirmed-existing", @"existsBefore": before ?: NSNull.null };
    uint64_t getterBefore = clock_gettime_nsec_np(CLOCK_REALTIME) / 1000;
    NSNumber *first = ReadPID(store, @"_networkProcessIdentifier"), *after = ReadExists(store);
    NSNumber *second = after.boolValue ? ReadPID(store, @"_networkProcessIdentifier") : nil;
    NSDictionary *identity = first ? ProcessIdentity(first.intValue) : nil;
    BOOL verified = first && second && [first isEqual:second] && after.boolValue && [SystemKind(identity) isEqual:@"Networking"] &&
        [identity[@"birthMicros"] longLongValue] < getterBefore;
    return @{ @"verified": @(verified), @"reason": verified ? @"existing-proxy-stable-pid" : @"network-getter-unverified", @"existsBefore": before,
        @"existsAfter": after ?: NSNull.null, @"pid": first ?: NSNull.null, @"pidAfter": second ?: NSNull.null,
        @"getterBeforeUnixMicros": [NSString stringWithFormat:@"%llu", getterBefore], @"identity": identity ?: NSNull.null };
}
static BOOL OwnPage(NSString *title, NSURL *current, NSDictionary *config) {
    NSURL *expected = [NSURL URLWithString:config[@"url"] ?: @""];
    return [title isEqual:config[@"title"]] && expected && [expected.scheme isEqual:@"http"] &&
        [expected.host isEqual:@"127.0.0.1"] && expected.port && !expected.user && !expected.password &&
        [current.absoluteString isEqual:expected.absoluteString];
}

#if !defined(QIUYA_WK_ASSOC_SELFTEST)
static NSDictionary *Config;
static int Output = -1;
static NSTimer *ProbeTimer;
static NSUInteger Samples, Sequence, Pending;
static void Emit(NSDictionary *value) {
    if (Output < 0 || Sequence >= 4000) return;
    NSMutableDictionary *row = value.mutableCopy; row[@"schemaVersion"] = @1; row[@"sequence"] = @(++Sequence);
    row[@"nonce"] = Config[@"nonce"]; row[@"helper"] = ProcessIdentity(getpid()) ?: NSNull.null;
    NSError *error = nil; NSData *data = [NSJSONSerialization dataWithJSONObject:row options:NSJSONWritingSortedKeys error:&error];
    if (!data || data.length > 16384) return;
    NSMutableData *line = data.mutableCopy; [line appendBytes:"\n" length:1];
    const char *bytes = line.bytes; NSUInteger offset = 0;
    while (offset < line.length) { ssize_t written = write(Output, bytes + offset, line.length - offset); if (written <= 0) break; offset += written; }
}
static void CollectViews(NSView *view, NSMutableArray<WKWebView *> *found, NSUInteger depth) {
    if (!view || depth > 12 || found.count > 1) return;
    if ([view isKindOfClass:WKWebView.class]) { [found addObject:(WKWebView *)view]; return; }
    for (NSView *child in view.subviews) CollectViews(child, found, depth + 1);
}
static void Probe(void) {
    NSCAssert(NSThread.isMainThread, @"WK getter reads must stay on the UI thread");
    if (Pending || Samples >= 3600) return;
    NSMutableArray<WKWebView *> *views = NSMutableArray.new; NSWindow *window = nil;
    for (NSWindow *candidate in NSApp.windows) {
        if ([candidate.title isEqual:Config[@"title"]]) { window = candidate; CollectViews(candidate.contentView, views, 0); }
    }
    if (views.count != 1 || !window || !OwnPage(window.title, views[0].URL, Config)) return;
    WKWebView *view = views[0]; Pending = 1;
    // Only a test-owned nonce/clock document is read. No DOM text, URL query,
    // cookies, titles from other windows, credentials or page content is saved.
    [view evaluateJavaScript:@"({nonce:document.documentElement.dataset.qytAssociationNonce||'',tick:Number(document.documentElement.dataset.qytAssociationTick||0),visibility:document.visibilityState,iframes:document.querySelectorAll('iframe').length})" completionHandler:^(id value, NSError *error) {
        Pending = 0;
        if (!NSThread.isMainThread) { Emit(@{ @"event": @"association-unverified", @"reason": @"WK-callback-not-on-main-thread" }); return; }
        if (!error && [value isKindOfClass:NSDictionary.class] && [value[@"nonce"] isEqual:@""] && [value[@"tick"] integerValue] == 0) return; // Committed URL can precede the own document script.
        if (error || !OwnPage(window.title, view.URL, Config) || ![value isKindOfClass:NSDictionary.class] ||
            ![value[@"nonce"] isEqual:Config[@"nonce"]] || [value[@"iframes"] integerValue] != 0 || ![value[@"visibility"] isEqual:@"visible"]) {
            Emit(@{ @"event": @"association-unverified", @"reason": @"own-page-nonce-not-confirmed" }); return;
        }
        NSMutableArray *associated = NSMutableArray.new, *errors = NSMutableArray.new;
        for (NSArray *entry in @[@[@"WebContent", @"_webProcessIdentifier"], @[@"GPU", @"_gpuProcessIdentifier"]]) {
            NSNumber *first = ReadPID(view, entry[1]), *second = ReadPID(view, entry[1]);
            NSDictionary *identity = first ? ProcessIdentity(first.intValue) : nil;
            BOOL valid = first && [first isEqual:second] && [SystemKind(identity) isEqual:entry[0]];
            if (!valid) [errors addObject:[entry[0] stringByAppendingString:@"-pid-unverified"]];
            else [associated addObject:@{ @"role": entry[0], @"selector": entry[1], @"identity": identity }];
        }
        NSDictionary *network = ReadNetworkPID(view.configuration.websiteDataStore);
        if (![network[@"verified"] boolValue]) [errors addObject:@"Networking-pid-unverified"];
        else [associated addObject:@{ @"role": @"Networking", @"selector": @"_networkProcessIdentifier", @"identity": network[@"identity"] }];
        Samples++;
        Emit(@{ @"event": @"association", @"sample": @(Samples), @"verified": errors.count == 0 ? @YES : @NO, @"errors": errors,
            @"windowId": @(window.windowNumber), @"page": @{ @"nonceVerified": @YES, @"tick": value[@"tick"], @"visibility": @"visible", @"iframes": @0 },
            @"associated": associated, @"networkFence": network, @"ownershipClaim": @"associated-with-this-own-WK-instance; independently-pin-before-resource-accounting" });
        if (Samples >= 3600) { [ProbeTimer invalidate]; ProbeTimer = nil; Emit(@{ @"event": @"probe-ended", @"reason": @"sample-bound" }); }
    }];
}
__attribute__((constructor)) static void Install(void) {
    @autoreleasepool {
        NSString *configPath = NSProcessInfo.processInfo.environment[@"QIUYA_WK_SOAK_ASSOC_CONFIG"];
        if (!configPath || [NSProcessInfo.processInfo.arguments containsObject:@"--input-guardian"]) return;
        int fd = open(configPath.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); struct stat file = {0};
        if (fd < 0 || fstat(fd, &file) || file.st_uid != getuid() || !S_ISREG(file.st_mode) || (file.st_mode & 0777) != 0600 || file.st_size <= 0 || file.st_size > 8192) { if (fd >= 0) close(fd); return; }
        NSMutableData *bytes = [NSMutableData dataWithLength:(NSUInteger)file.st_size]; ssize_t count = read(fd, bytes.mutableBytes, bytes.length); close(fd);
        if (count != bytes.length) return;
        NSDictionary *config = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
        if (![config isKindOfClass:NSDictionary.class] || ![config[@"nonce"] isKindOfClass:NSString.class] || ![[NSUUID alloc] initWithUUIDString:config[@"nonce"]] ||
            ![config[@"title"] isEqual:[@"QiuYaTools WK soak association " stringByAppendingString:config[@"nonce"]]]) return;
        NSDictionary *selfIdentity = ProcessIdentity(getpid()); struct stat expected = {0};
        NSString *helper = config[@"helper"];
        if (![helper isKindOfClass:NSString.class] || stat(helper.fileSystemRepresentation, &expected) || !selfIdentity ||
            ![selfIdentity[@"device"] isEqual:[NSString stringWithFormat:@"%llu", (uint64_t)expected.st_dev]] ||
            ![selfIdentity[@"inode"] isEqual:[NSString stringWithFormat:@"%llu", (uint64_t)expected.st_ino]] ||
            [config[@"parentPid"] intValue] != getppid()) return;
        NSString *output = config[@"output"], *directory = configPath.stringByDeletingLastPathComponent;
        struct stat parent = {0};
        if (![output isKindOfClass:NSString.class] || ![output.stringByDeletingLastPathComponent isEqual:directory] ||
            lstat(directory.fileSystemRepresentation, &parent) || !S_ISDIR(parent.st_mode) || parent.st_uid != getuid() || (parent.st_mode & 0777) != 0700) return;
        Output = open(output.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (Output < 0) return;
        Config = config;
        dispatch_async(dispatch_get_main_queue(), ^{
            Emit(@{ @"event": @"probe-ready", @"carrier": @"explicit-test-only-DYLD-readonly-WK-soak-getters", @"changesResponsibility": @NO });
            ProbeTimer = [NSTimer timerWithTimeInterval:2.0 repeats:YES block:^(__unused NSTimer *timer) { Probe(); }];
            [NSRunLoop.mainRunLoop addTimer:ProbeTimer forMode:NSRunLoopCommonModes];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 7200LL * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                if (ProbeTimer) { [ProbeTimer invalidate]; ProbeTimer = nil; Emit(@{ @"event": @"probe-ended", @"reason": @"deadline", @"samples": @(Samples) }); }
            });
        });
    }
}
#else
@interface FakeGetter : NSObject
@property BOOL exists;
@property NSUInteger networkCalls;
- (pid_t)_webProcessIdentifier;
- (BOOL)_networkProcessExists;
- (pid_t)_networkProcessIdentifier;
@end
@implementation FakeGetter
- (pid_t)_webProcessIdentifier { return getpid(); }
- (BOOL)_networkProcessExists { return self.exists; }
- (pid_t)_networkProcessIdentifier { self.networkCalls++; return getpid(); }
@end
@interface WrongGetter : NSObject
- (NSString *)_webProcessIdentifier;
@end
@implementation WrongGetter
- (NSString *)_webProcessIdentifier { return @"not-a-pid"; }
@end
int main(void) {
    @autoreleasepool {
        FakeGetter *fake = FakeGetter.new;
        NSCAssert([ReadPID(fake, @"_webProcessIdentifier") intValue] == getpid(), @"Correct pid_t getter ABI");
        NSCAssert(!ReadPID(WrongGetter.new, @"_webProcessIdentifier") && !ReadPID(fake, @"_missing"), @"Missing/wrong ABI never called");
        NSDictionary *none = ReadNetworkPID(fake);
        NSCAssert(![none[@"verified"] boolValue] && fake.networkCalls == 0, @"No network PID getter unless exists=true");
        fake.exists = YES; NSDictionary *own = ReadNetworkPID(fake);
        NSCAssert(fake.networkCalls == 2 && ![own[@"verified"] boolValue], @"Same-user unrelated executable cannot pretend to be Apple Networking");
        NSDictionary *identity = ProcessIdentity(getpid()); NSCAssert(identity && !SystemKind(identity), @"Exact self identity never classified by a spoofed role/name");
        NSDictionary *config = @{ @"title": @"own", @"url": @"http://127.0.0.1:1234/own" };
        NSCAssert(OwnPage(@"own", [NSURL URLWithString:config[@"url"]], config), @"Exact own page accepted");
        NSCAssert(!OwnPage(@"other", [NSURL URLWithString:config[@"url"]], config) && !OwnPage(@"own", [NSURL URLWithString:@"http://127.0.0.1:1234/other"], config), @"Other title/path refused");
        NSMutableArray *errors = NSMutableArray.new;
        NSDictionary *receipt = @{ @"verified": errors.count == 0 ? @YES : @NO };
        NSData *serialized = [NSJSONSerialization dataWithJSONObject:receipt options:0 error:nil];
        NSDictionary *decoded = [NSJSONSerialization JSONObjectWithData:serialized options:0 error:nil];
        NSCAssert(CFGetTypeID((__bridge CFTypeRef)decoded[@"verified"]) == CFBooleanGetTypeID() && [decoded[@"verified"] boolValue], @"The emitted verified field must be a JSON boolean, never numeric 1");
        puts("{\"passed\":true,\"checks\":7,\"gui\":false,\"realWK\":false,\"productionHelperSpawned\":false}");
    }
    return 0;
}
#endif

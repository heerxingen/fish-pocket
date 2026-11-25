import Foundation

/// What the app and its screen broadcast extension (`DshScreenShare`) share while the user shows
/// their screen on a voice call: files in `ScreenShare/` in the App Group container, and Darwin
/// notifications (no payload) to say something changed.
///
/// - The app marks a call on (`callActive`) as it starts and off as it ends; the extension
///   refuses to broadcast without one.
/// - The extension writes the screen as it is now to `frame.jpg` (a scaled-down JPEG, at most
///   about once a second, only when the screen changes), keeps `sharing` while it broadcasts,
///   and posts `started` and `stopped`.
/// - The app posts `stopForUser` (停止共享) or `stopForCallEnd` (the call ended); the extension
///   finishes the broadcast, saying why.
enum ScreenShareChannel {
    enum Signal: String, CaseIterable {
        case started, stopped
        case stopForUser = "stop.user"
        case stopForCallEnd = "stop.call-end"
    }

    private static var group: String? {
        Bundle.main.object(forInfoDictionaryKey: "DshAppGroup") as? String
    }

    static var folder: URL? {
        guard let group, let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return container.appending(path: "ScreenShare")
    }

    static var frameURL: URL? { folder?.appending(path: "frame.jpg") }
    private static var callURL: URL? { folder?.appending(path: "call") }
    private static var sharingURL: URL? { folder?.appending(path: "sharing") }

    /// A call is on in the app: the extension may broadcast.
    static var callActive: Bool {
        get { callURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false }
        set { mark(callURL, newValue) }
    }

    /// The extension is broadcasting.
    static var sharing: Bool {
        get { sharingURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false }
        set { mark(sharingURL, newValue) }
    }

    /// The screen as it was last captured.
    static func latestFrame() -> Data? {
        frameURL.flatMap { try? Data(contentsOf: $0) }
    }

    static func writeFrame(_ data: Data) {
        guard let url = frameURL else { return }
        ensureFolder()
        try? data.write(to: url, options: .atomic)
    }

    static func removeFrame() {
        if let url = frameURL { try? FileManager.default.removeItem(at: url) }
    }

    private static func mark(_ url: URL?, _ on: Bool) {
        guard let url else { return }
        if on {
            ensureFolder()
            FileManager.default.createFile(atPath: url.path, contents: Data())
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private static func ensureFolder() {
        if let folder { try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    }

    // MARK: Darwin notifications

    private static func name(_ signal: Signal) -> String? {
        group.map { "\($0).screen-share.\(signal.rawValue)" }
    }

    static func post(_ signal: Signal) {
        guard let name = name(signal) else { return }
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    }

    /// Call `handler` (on an arbitrary thread) whenever `signal` is posted, until the token is
    /// passed to `stopObserving`.
    static func observe(_ signal: Signal, _ handler: @escaping @Sendable () -> Void) -> UUID? {
        guard let name = name(signal) else { return nil }
        return DarwinObservers.shared.add(name, handler)
    }

    static func stopObserving(_ token: UUID?) {
        if let token { DarwinObservers.shared.remove(token) }
    }
}

/// Darwin notifications carry nothing but their name, and their callback is a C function: one
/// observer per name, which hands each post to the closures registered for it.
private final class DarwinObservers: @unchecked Sendable {
    static let shared = DarwinObservers()

    private let lock = NSLock()
    private var handlers: [String: [UUID: @Sendable () -> Void]] = [:]

    func add(_ name: String, _ handler: @escaping @Sendable () -> Void) -> UUID {
        let token = UUID()
        lock.lock()
        let first = handlers[name] == nil
        handlers[name, default: [:]][token] = handler
        lock.unlock()
        if first {
            CFNotificationCenterAddObserver(
                CFNotificationCenterGetDarwinNotifyCenter(),
                Unmanaged.passUnretained(self).toOpaque(),
                { _, _, name, _, _ in
                    guard let name = name?.rawValue as String? else { return }
                    DarwinObservers.shared.fire(name)
                },
                name as CFString, nil, .deliverImmediately
            )
        }
        return token
    }

    func remove(_ token: UUID) {
        lock.lock()
        var emptied: String?
        for (name, var registered) in handlers where registered.removeValue(forKey: token) != nil {
            handlers[name] = registered.isEmpty ? nil : registered
            if registered.isEmpty { emptied = name }
        }
        lock.unlock()
        if let emptied {
            CFNotificationCenterRemoveObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(),
                                               CFNotificationName(emptied as CFString), nil)
        }
    }

    private func fire(_ name: String) {
        lock.lock()
        let registered = handlers[name].map { Array($0.values) } ?? []
        lock.unlock()
        for handler in registered { handler() }
    }
}

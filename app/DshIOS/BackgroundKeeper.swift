import AVFoundation
import BackgroundTasks
import SwiftUI
import UIKit

/// Keeps the engine running while the app is off screen and something needs it. iOS suspends
/// the whole process shortly after the app leaves the screen, and with it Node: agent turns,
/// automations and dev servers all freeze until the app comes back.
///
/// - Always: a UIKit background task gives in-flight turns the usual ~30 s grace, ended early
///   once nothing is running.
/// - The 设置 → 后台运行 →「有后台任务时保持运行」switch (on by default): while the 待办 tab
///   lists work that needs this engine (a running session, a background job, a switched-on
///   automation; `AppModel.keepsAppAlive`), silent, mixable audio keeps the process alive (the
///   `audio` background mode). Once that list stays empty for `linger`, the audio stops and the
///   system suspends the app as it would any other; nothing wakes it until the user is back.
/// - The 设置 → 后台运行 →「任务续跑」switch (iOS 26+, off by default): a
///   `BGContinuedProcessingTask` when the app leaves the screen with sessions running, so a turn
///   can finish off screen; the system shows its progress and the user can stop it there. Not
///   submitted for work the user watches to the end.
@MainActor
final class BackgroundKeeper {
    static let shared = BackgroundKeeper()
    static let enabledKey = "backgroundKeepAlive"
    static let continuedKey = "continuedProcessing"
    /// Matches `BGTaskSchedulerPermittedIdentifiers` in project.yml.
    private static let taskPrefix = (Bundle.main.bundleIdentifier ?? "com.wsw.dsh-ios") + ".task"
    /// How long the audio outlasts the work: a group's members answer one after another, a
    /// subagent hands back, an agent starts its next round, each after a short gap.
    private static let linger: Duration = .seconds(75)

    /// Keep running while there is work.
    var enabled: Bool { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
    /// Continued-processing tasks.
    var continuedEnabled: Bool { UserDefaults.standard.bool(forKey: Self.continuedKey) }

    private var inBackground = false
    /// Between losing focus and going to the background: the last moment a continued task can be submitted.
    private var leaving = false
    /// Titles of the places with sessions at work (the continued task's subtitle).
    private var running: [String] = []
    /// Anything that needs the engine: sessions, jobs, automations.
    private var busy = false
    /// Re-reads the session list; set by the current engine connection.
    private var refresh: (() async -> Void)?
    private var grace: UIBackgroundTaskIdentifier = .invalid
    private var pollTask: Task<Void, Never>?
    /// The wait before the audio stops once the work has run out.
    private var lingerTask: Task<Void, Never>?
    /// The live `BGContinuedProcessingTask` (typed loosely: the deployment target is iOS 17).
    private var continued: AnyObject?
    private var submitted: String?
    /// The scheduler refused this round, or the user stopped it: no new request
    /// until the sessions go idle.
    private var halted = false
    private let audio = SilentAudio()

    private init() {}

    func attach(refresh: @escaping () async -> Void) {
        self.refresh = refresh
    }

    /// After every change to what the 待办 tab lists: the places with sessions at work, and
    /// whether anything at all needs the engine. Each refresh follows engine activity, so while
    /// busy it also counts as progress.
    func update(running titles: [String], keepAlive: Bool) {
        running = titles
        busy = keepAlive
        if titles.isEmpty {
            finishContinued()
        } else {
            if leaving { startContinued() }
            tick()
        }
        guard inBackground else { return }
        if !enabled {
            if titles.isEmpty { endGrace() }
        } else if busy {
            lingerTask?.cancel()
            lingerTask = nil
            audio.start()
        } else if audio.playing {
            settle()
        }
    }

    /// A switch changed; while off screen it takes effect at once. Turning 任务续跑
    /// off ends a live or pending task; turning it on applies from the next time
    /// the app leaves the screen (requests can only be submitted in the foreground).
    func settingsChanged() {
        if !continuedEnabled { finishContinued() }
        guard inBackground else { return }
        if enabled && busy { audio.start() } else { stopKeeping() }
    }

    func scenePhaseChanged(to phase: ScenePhase) {
        switch phase {
        case .active:
            leaving = false
            inBackground = false
            pollTask?.cancel()
            stopKeeping()
            endGrace()
        case .background:
            leaving = false
            guard !inBackground else { return }
            inBackground = true
            beginGrace()
            // Nothing to keep: the grace lets the engine finish what it is writing, then the
            // system suspends the app. Work that turns up within it still starts the audio.
            if enabled && busy { audio.start() }
            poll()
        default:
            // Still in the foreground: submit for what is running, and refresh for
            // work the cached list missed (an automation, a session not on screen).
            leaving = !inBackground
            if leaving { startContinued() }
            Task { await refresh?() }
        }
    }

    // MARK: Keeping alive

    /// The work ran out while the audio plays: after `linger`, one more look, then let go.
    private func settle() {
        guard lingerTask == nil else { return }
        lingerTask = Task { [weak self] in
            try? await Task.sleep(for: Self.linger)
            guard !Task.isCancelled else { return }
            await self?.refresh?()
            guard let self, !Task.isCancelled else { return }
            self.lingerTask = nil
            guard self.inBackground, !self.busy else { return }
            print("[keepalive] nothing left to run; letting the system suspend the app")
            self.stopKeeping()
            self.endGrace()
        }
    }

    private func stopKeeping() {
        lingerTask?.cancel()
        lingerTask = nil
        audio.stop()
    }

    // MARK: Grace period

    private func beginGrace() {
        guard grace == .invalid else { return }
        grace = UIApplication.shared.beginBackgroundTask(withName: "dsh-engine") { [weak self] in
            MainActor.assumeIsolated { self?.endGrace() }
        }
    }

    private func endGrace() {
        guard grace != .invalid else { return }
        UIApplication.shared.endBackgroundTask(grace)
        grace = .invalid
    }

    /// Off screen no view drives refreshes; ask the engine directly.
    private func poll() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await refresh?()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    // MARK: Continued processing (iOS 26)

    private var subtitle: String {
        running.count == 1 ? running[0] : String(localized: "\(running.count) 个会话进行中")
    }

    private func startContinued() {
        guard #available(iOS 26.0, *), continuedEnabled, !running.isEmpty, continued == nil, submitted == nil, !halted else { return }
        // Info.plist permits `<prefix>.*`; handlers are registered per concrete
        // identifier (registering the wildcard itself is not supported), and
        // continued-processing handlers may be registered after launch.
        let identifier = "\(Self.taskPrefix).\(UUID().uuidString)"
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            MainActor.assumeIsolated { self.run(task) }
        }
        guard registered else { return }
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: String(localized: "DSH 任务进行中"), subtitle: subtitle)
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
            submitted = identifier
        } catch {
            halted = true
            print("[keepalive] continued task not submitted: \(error)")
        }
    }

    @available(iOS 26.0, *)
    private func run(_ task: BGTask) {
        guard let task = task as? BGContinuedProcessingTask else { return }
        submitted = nil
        guard continuedEnabled, !running.isEmpty else {
            task.setTaskCompleted(success: true)
            return
        }
        continued = task
        task.progress.totalUnitCount = 10
        task.expirationHandler = { [weak self] in
            Task { @MainActor in
                guard let self, self.continued === task else { return }
                self.continued = nil
                self.halted = true
                task.setTaskCompleted(success: false)
            }
        }
        tick()
    }

    /// The end of agent work is unknown, so the bar keeps moving without filling:
    /// n events show as n / (n + 10).
    private func tick() {
        guard #available(iOS 26.0, *), let task = continued as? BGContinuedProcessingTask else { return }
        task.progress.completedUnitCount += 1
        task.progress.totalUnitCount = task.progress.completedUnitCount + 10
        task.updateTitle(String(localized: "DSH 任务进行中"), subtitle: subtitle)
    }

    private func finishContinued() {
        guard #available(iOS 26.0, *) else { return }
        halted = false
        if let identifier = submitted {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
            submitted = nil
        }
        guard let task = continued as? BGContinuedProcessingTask else { return }
        continued = nil
        task.progress.completedUnitCount = task.progress.totalUnitCount
        task.setTaskCompleted(success: true)
    }
}

/// Plays silence through a mixable `.playback` session: the app keeps running
/// in the background without taking over the user's audio or Now Playing.
@MainActor
private final class SilentAudio {
    private var engine: AVAudioEngine?
    private var observers: [NSObjectProtocol] = []

    var playing: Bool { engine != nil }

    func start() {
        guard engine == nil else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44_100)!
            buffer.frameLength = buffer.frameCapacity
            memset(buffer.floatChannelData![0], 0, Int(buffer.frameLength) * MemoryLayout<Float>.size)
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            player.play()
            self.engine = engine
            print("[keepalive] silent audio on")
        } catch {
            print("[keepalive] silent audio failed: \(error)")
            return
        }
        // A call or another app's non-mixable audio stops the engine; resume after it.
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                let ended = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
                if ended { MainActor.assumeIsolated { self?.restart() } }
            },
            center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.restart() }
            },
        ]
    }

    func stop() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard let engine else { return }
        engine.stop()
        self.engine = nil
        print("[keepalive] silent audio off")
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func restart() {
        guard engine != nil else { return }
        stop()
        start()
    }
}

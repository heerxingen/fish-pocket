import CryptoKit
import Observation
import ReplayKit
import SwiftUI
import UIKit

/// 共享屏幕 on a voice call, the way ChatGPT and 豆包 do it: the system's screen broadcast
/// (the `DshScreenShare` extension) captures the whole screen, wherever the user goes while the
/// call runs on; as each sentence the user says goes out, the screen as it is then goes to the
/// engine (`engine/plugins/ios-call`), which shows it to the model with that message. Only what
/// is on screen when the user speaks is sent, never a stream.
///
/// The system decides when a broadcast starts: only its own sheet can start one, so 共享屏幕
/// opens that sheet (`BroadcastPicker`), and the user taps 开始直播 there.
@MainActor
@Observable
final class CallScreenShare {
    /// The extension is broadcasting the screen.
    private(set) var sharing = false
    /// How many times 共享屏幕 asked for the system's sheet (`BroadcastPicker` opens it on each).
    private(set) var requested = 0

    @ObservationIgnored private var observers: [UUID] = []
    /// The frame last handed over, so an unchanged screen is not stored again.
    @ObservationIgnored private var lastSent: SHA256.Digest?
    /// Sharing stopped since the last message: the next one says so.
    @ObservationIgnored private var stoppedSinceMessage = false
    @ObservationIgnored var onChange: ((Bool) -> Void)?

    /// The extension built into this app, and a device whose system can broadcast.
    static let extensionIdentifier: String? = {
        guard !ProcessInfo.processInfo.isiOSAppOnMac, let plugIns = Bundle.main.builtInPlugInsURL,
              let names = try? FileManager.default.contentsOfDirectory(atPath: plugIns.path) else { return nil }
        for name in names where name.hasSuffix(".appex") {
            guard let bundle = Bundle(url: plugIns.appending(path: name)),
                  let point = (bundle.infoDictionary?["NSExtension"] as? [String: Any])?["NSExtensionPointIdentifier"] as? String,
                  point == "com.apple.broadcast-services-upload" else { continue }
            return bundle.bundleIdentifier
        }
        return nil
    }()

    static var available: Bool { extensionIdentifier != nil }

    /// The call is on: the extension may broadcast, and its starts and stops reach here.
    func begin() {
        ScreenShareChannel.callActive = true
        let started = ScreenShareChannel.observe(.started) { [weak self] in Task { @MainActor in self?.changed() } }
        let stopped = ScreenShareChannel.observe(.stopped) { [weak self] in Task { @MainActor in self?.changed() } }
        observers = [started, stopped].compactMap { $0 }
        changed()
    }

    /// The call is over: a broadcast still running stops, saying the call ended.
    func end() {
        observers.forEach(ScreenShareChannel.stopObserving)
        observers = []
        ScreenShareChannel.callActive = false
        if ScreenShareChannel.sharing { ScreenShareChannel.post(.stopForCallEnd) }
        sharing = false
    }

    /// 共享屏幕: the system's sheet comes up. 停止共享: the broadcast ends.
    func toggle() {
        Haptics.select()
        if sharing {
            ScreenShareChannel.post(.stopForUser)
        } else {
            requested += 1
        }
    }

    private func changed() {
        let now = ScreenShareChannel.sharing
        guard now != sharing else { return }
        sharing = now
        if now {
            lastSent = nil
            stoppedSinceMessage = false
        } else {
            stoppedSinceMessage = true
        }
        onChange?(now)
    }

    /// What goes to the engine with the message the user just said: the screen when it changed,
    /// that it did not, or that sharing stopped since the last message. Nil for nothing.
    func handOver() -> [String: Any]? {
        if !sharing {
            guard stoppedSinceMessage else { return nil }
            stoppedSinceMessage = false
            return ["state": "stopped"]
        }
        guard let frame = ScreenShareChannel.latestFrame() else { return nil }
        let digest = SHA256.hash(data: frame)
        if digest == lastSent { return ["state": "same"] }
        lastSent = digest
        return ["state": "shot", "mediaType": "image/jpeg", "image": frame.base64EncodedString()]
    }
}

/// The system's broadcast button, kept out of sight: 共享屏幕 taps it (each new `trigger`), and
/// the system's sheet for starting a broadcast to Fish Pocket comes up.
struct BroadcastPicker: UIViewRepresentable {
    let trigger: Int

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        picker.preferredExtension = CallScreenShare.extensionIdentifier
        picker.showsMicrophoneButton = false
        context.coordinator.seen = trigger
        return picker
    }

    func updateUIView(_ picker: RPSystemBroadcastPickerView, context: Context) {
        guard trigger != context.coordinator.seen else { return }
        context.coordinator.seen = trigger
        // The picker has no API to open it: its own button, wherever the system put it, is the way in.
        guard let button = Self.button(in: picker) else {
            CallDiagnostics.note("screen share: the broadcast picker has no button")
            return
        }
        CallDiagnostics.note("screen share: opening the system's broadcast sheet")
        button.sendActions(for: .touchUpInside)
    }

    private static func button(in view: UIView) -> UIButton? {
        for subview in view.subviews {
            if let button = subview as? UIButton { return button }
            if let button = button(in: subview) { return button }
        }
        return nil
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var seen = 0
    }
}

/// 共享屏幕 at the top of the call screen; while the screen is shared, 共享中 in the call's
/// vermilion, and a tap stops it.
struct CallScreenShareButton: View {
    let share: CallScreenShare

    var body: some View {
        Button(action: share.toggle) {
            HStack(spacing: 6) {
                Image(systemName: share.sharing ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle")
                    .font(.system(size: 15, weight: .semibold))
                    .contentTransition(.symbolEffect(.replace))
                Text(share.sharing ? "停止共享" : "共享屏幕")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(share.sharing ? .white : Palette.ink)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background {
                if share.sharing { Capsule().fill(Palette.spot) }
            }
            .callGlass(in: Capsule(), when: !share.sharing)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityHint(share.sharing ? Text("不再发送你的屏幕") : Text("你每说一句话，当前屏幕会随这句话发送给你选择的模型服务商"))
        .background {
            BroadcastPicker(trigger: share.requested)
                .frame(width: 1, height: 1)
                .opacity(0.01)
                .accessibilityHidden(true)
                .allowsHitTesting(false)
        }
        .animation(.smooth(duration: 0.25), value: share.sharing)
    }
}

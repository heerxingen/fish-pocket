import CoreImage
import ImageIO
import ReplayKit
import UniformTypeIdentifiers

/// The screen broadcast behind 共享屏幕 on a voice call: the system hands this extension every
/// frame of the screen, wherever the user goes; it keeps the latest one, scaled down, in the App
/// Group (`ScreenShareChannel`), where the app picks it up as the user finishes a sentence.
/// Nothing leaves the phone from here, and no sound is taken.
///
/// A broadcast extension lives in 50 MB: one small context, one frame at a time, encoded right in
/// the callback (frames that come meanwhile are dropped, which is what a second's pace wants).
/// Its state is touched on the main thread only (stops are sent there); the frames' pace and
/// encoding stay on the system's sample queue.
final class SampleHandler: RPBroadcastSampleHandler, @unchecked Sendable {
    /// At most this often: what is said takes longer than a second, and the model sees one frame.
    private static let interval: CFTimeInterval = 1
    /// The long side of what is kept: small text stays readable, and a model is sent no more
    /// than it would scale it down to.
    private static let longSide: CGFloat = 1440
    private static let quality: CGFloat = 0.7

    private let context = CIContext(options: [.cacheIntermediates: false])
    private var lastFrame: CFTimeInterval = 0
    private var observers: [UUID] = []

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard ScreenShareChannel.callActive else {
            finish(String(localized: "屏幕共享要在 Fish Pocket 的语音通话里开启"))
            return
        }
        ScreenShareChannel.removeFrame()
        ScreenShareChannel.sharing = true
        // Darwin notifications arrive on any thread; the broadcast is started and ended on the main one.
        let stopForUser = ScreenShareChannel.observe(.stopForUser) { [weak self] in
            DispatchQueue.main.async { self?.finish(String(localized: "已停止共享屏幕")) }
        }
        let stopForCallEnd = ScreenShareChannel.observe(.stopForCallEnd) { [weak self] in
            DispatchQueue.main.async { self?.finish(String(localized: "通话已结束，屏幕共享已停止")) }
        }
        observers = [stopForUser, stopForCallEnd].compactMap { $0 }
        ScreenShareChannel.post(.started)
    }

    override func broadcastFinished() {
        wrapUp()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        let now = CACurrentMediaTime()
        guard now - lastFrame >= Self.interval, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastFrame = now
        autoreleasepool {
            if let data = encode(pixels, orientation: Self.orientation(of: sampleBuffer)) {
                ScreenShareChannel.writeFrame(data)
            }
        }
    }

    /// Upright, scaled so the long side is at most `longSide`, as JPEG.
    private func encode(_ pixels: CVPixelBuffer, orientation: CGImagePropertyOrientation) -> Data? {
        var image = CIImage(cvPixelBuffer: pixels).oriented(orientation)
        let longest = max(image.extent.width, image.extent.height)
        if longest > Self.longSide {
            let scale = Self.longSide / longest
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        let extent = image.extent.integral
        guard let cgImage = context.createCGImage(image, from: extent) else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, cgImage, [kCGImageDestinationLossyCompressionQuality: Self.quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// Which way the screen is turned (the frames come in the panel's own orientation).
    private static func orientation(of sampleBuffer: CMSampleBuffer) -> CGImagePropertyOrientation {
        guard let value = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
              let orientation = CGImagePropertyOrientation(rawValue: value.uint32Value) else { return .up }
        return orientation
    }

    /// End the broadcast; the system shows `reason` to the user.
    private func finish(_ reason: String) {
        wrapUp()
        finishBroadcastWithError(NSError(domain: "FishPocketScreenShare", code: 0, userInfo: [NSLocalizedDescriptionKey: reason]))
    }

    private func wrapUp() {
        guard !observers.isEmpty || ScreenShareChannel.sharing else { return }
        observers.forEach(ScreenShareChannel.stopObserving)
        observers = []
        ScreenShareChannel.sharing = false
        ScreenShareChannel.removeFrame()
        ScreenShareChannel.post(.stopped)
    }
}

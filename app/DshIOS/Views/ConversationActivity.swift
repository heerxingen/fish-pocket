import SwiftUI

/// What the agent has going on beside the conversation, floating over its foot: the web page it
/// works in, as a small picture of it, and its background jobs. One tap opens either, without a trip
/// to the top bar. Each shows only while there is something to see; a running one carries the green dot.
struct ConversationActivity: View {
    let sessionId: String
    let jobs: JobsModel
    /// The workbench already shows the browser beside the conversation (iPad).
    let browserShown: Bool
    /// A group chat: its members' browsers and its own, one picture for all of them.
    var roomId: String?
    /// The background jobs chip: a group's session runs none of its own to show.
    var showsJobs = true
    let openBrowser: () -> Void
    let openJobs: () -> Void
    @Environment(AppModel.self) private var app

    /// What the picture shows: the browser in front, whose it is in a group chat, and the others.
    struct Picture {
        let model: BrowserModel
        var owner: GroupBrowser.Owner?
        /// Every browser the picture stands for, the one in front among them.
        var all: [BrowserModel]
    }

    /// A subagent works in the browser of the conversation that started it. Not while the user has
    /// closed its picture; in a group chat, not until any of them is used again.
    @MainActor
    static func picture(of sessionId: String, roomId: String?, in app: AppModel) -> Picture? {
        if let roomId {
            let browsers = GroupBrowsers.list(roomId: roomId, in: app)
            guard browsers.contains(where: { !$0.model.previewHidden }), let front = GroupBrowsers.latest(browsers) else { return nil }
            return Picture(model: front.model, owner: front.owner, all: browsers.map(\.model))
        }
        guard let model = BrowserModel.existing(BrowserAgent.owner(of: sessionId, in: app)), model.hasPages, !model.previewHidden else { return nil }
        return Picture(model: model, all: [model])
    }

    /// How much room the timeline leaves under its last row, so what floats here never sits on it.
    @MainActor
    static func room(sessionId: String, roomId: String?, showsJobs: Bool, jobs: JobsModel, browserShown: Bool, in app: AppModel) -> CGFloat {
        if !browserShown, let picture = picture(of: sessionId, roomId: roomId, in: app) { return picture.model.thumbnailSize.height + 12 }
        return showsJobs && jobs.visibleCount > 0 ? 48 : 0
    }

    var body: some View {
        // Read here so the chips follow a browser made after this view.
        let picture = browserShown ? nil : Self.picture(of: sessionId, roomId: roomId, in: app)
        HStack(alignment: .bottom, spacing: 8) {
            if let picture {
                // A view of its own: a new picture redraws it alone, and it is the one that watches.
                BrowserThumbnail(
                    browser: picture.model, owner: picture.owner, behind: picture.all.count - 1,
                    action: openBrowser,
                    close: { for model in picture.all { model.previewHidden = true } }
                )
                .id(ObjectIdentifier(picture.model))
            }
            if showsJobs, jobs.visibleCount > 0 {
                chip(
                    text: jobs.live.isEmpty ? Text("\(jobs.visibleCount) 个后台任务") : Text("\(jobs.live.count) 个后台任务运行中"),
                    running: !jobs.live.isEmpty,
                    action: openJobs
                )
            }
        }
        .animation(.snappy(duration: 0.18), value: picture.map { ObjectIdentifier($0.model) })
        .animation(.snappy(duration: 0.18), value: jobs.visibleCount)
    }

    /// No picture, only the state, as each job's row in the list shows it: a breathing green dot
    /// while one runs, a grey one when all have ended.
    private func chip(text: Text, running: Bool, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(spacing: 7) {
                JobsDot(running: running)
                text.font(.footnote.weight(.medium)).lineLimit(1)
            }
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .floatingGlass(in: Capsule())
            .hitTarget()
        }
        .buttonStyle(.plain)
        .transition(.opacity.combined(with: .scale(scale: 0.8)))
        .accessibilityLabel(text)
    }
}

/// The background jobs chip's mark. The halo breathes while a job runs, unless motion is reduced.
private struct JobsDot: View {
    let running: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        let color = running ? Palette.running : Palette.faint
        ZStack {
            if running {
                Circle()
                    .fill(color.opacity(breathing ? 0.08 : 0.25))
                    .scaleEffect(breathing ? 1.7 : 1)
            }
            Circle().fill(color).frame(width: 7, height: 7)
        }
        .frame(width: 12, height: 12)
        .onAppear { breathe() }
        .onChange(of: running) { _, _ in breathe() }
        .accessibilityHidden(true)
    }

    private func breathe() {
        breathing = false
        guard running, !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { breathing = true }
    }
}

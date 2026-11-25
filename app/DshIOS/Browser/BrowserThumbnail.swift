import SwiftUI
import WebKit

/// The chat's small picture of a conversation's browser: the tab in front, as it looks now.
///
/// It costs nothing while nobody looks: pictures are taken only while a chat shows one. Then a new
/// one comes every few seconds, as a page changes by itself too, and at once when something
/// happened to the page: an operation of the agent's ended, a load finished, another tab came to
/// the front. WebKit draws it at the thumbnail's own size, pictures are a second apart at least,
/// and a browser keeps one.
///
/// The picture is all of what the page shows, in the page's own shape: tall on a phone, wider on
/// an iPad or an open iPhone Duo.
extension BrowserModel {
    /// The picture is as large as fits in this.
    private static let thumbnailBox = CGSize(width: 112, height: 140)
    /// A page far taller than it is wide (a narrow window on an iPad) gives its top.
    private static let thumbnailTallest: CGFloat = 2.2

    private static func thumbnailFit(_ page: CGSize) -> CGSize {
        guard page.width > 0, page.height > 0 else { return thumbnailBox }
        let scale = min(thumbnailBox.width / page.width, thumbnailBox.height / page.height)
        return CGSize(width: (page.width * scale).rounded(), height: (page.height * scale).rounded())
    }

    /// The size the chat draws the picture at. Before there is one, the shape a page has on this device.
    var thumbnailSize: CGSize {
        if let image = selected?.thumbnail { return Self.thumbnailFit(image.size) }
        let phone = UIDevice.current.userInterfaceIdiom == .phone
        return Self.thumbnailFit(phone ? CGSize(width: 9, height: 17) : CGSize(width: 4, height: 3))
    }

    private static let thumbnailInterval: TimeInterval = 1
    /// How often a page nothing happened to is drawn again.
    private static let thumbnailEvery: TimeInterval = 5

    /// A chat began or stopped showing the picture.
    func watchThumbnail(_ watching: Bool) {
        thumbnailWatchers = max(0, thumbnailWatchers + (watching ? 1 : -1))
        // What changed while nobody looked was not drawn.
        if watching { thumbnailStale(settle: 0) }
        if thumbnailWatchers == 0 {
            thumbnailTicker?.cancel()
            thumbnailTicker = nil
        } else if thumbnailTicker == nil {
            thumbnailTicker = Task { [weak self] in
                while true {
                    try? await Task.sleep(for: .seconds(Self.thumbnailEvery))
                    guard !Task.isCancelled, let self else { return }
                    self.thumbnailStale(settle: 0)
                }
            }
        }
    }

    /// The tab in front may look different now. `settle` gives the page a moment to draw what the
    /// change brought.
    func thumbnailStale(settle: TimeInterval = 0.3) {
        thumbnailDue = true
        guard thumbnailWatchers > 0, thumbnailTask == nil else { return }
        thumbnailTask = Task { [weak self] in
            // Changes that come while one picture is on its way make one more, not one each.
            while let self, self.thumbnailDue, self.thumbnailWatchers > 0 {
                let wait = max(settle, Self.thumbnailInterval - Date().timeIntervalSince(self.thumbnailTaken))
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                guard self.thumbnailWatchers > 0 else { break }
                self.thumbnailDue = false
                await self.takeThumbnail()
                self.thumbnailTaken = Date()
            }
            self?.thumbnailTask = nil
        }
    }

    private func takeThumbnail() async {
        // WebKit draws nothing for an app in the background, and may never answer.
        guard UIApplication.shared.applicationState == .active, let tab = selected, let page = tab.page, page.started else { return }
        let view = page.webView
        // Only a page in a window is drawn; one that is not keeps the picture it had.
        guard view.url != nil, view.window != nil else { return }
        // A page waiting behind the window is the window's size, and keeps clear of the status bar and
        // the like: the page itself is what is inside them.
        let shown = view.bounds.inset(by: view.safeAreaInsets)
        guard shown.width > 0, shown.height > 0 else { return }
        let configuration = WKSnapshotConfiguration()
        // All of what the page shows, at the size the chat draws it.
        configuration.rect = CGRect(
            x: shown.minX, y: shown.minY, width: shown.width,
            height: min(shown.height, shown.width * Self.thumbnailTallest))
        configuration.snapshotWidth = NSNumber(value: Double(Self.thumbnailFit(configuration.rect.size).width))
        let once = Once()
        let image: UIImage? = await withCheckedContinuation { continuation in
            view.takeSnapshot(with: configuration) { image, _ in
                guard once.claim() else { return }
                continuation.resume(returning: image)
            }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(5))
                guard once.claim() else { return }
                continuation.resume(returning: nil)
            }
        }
        guard let image, selectedId == tab.id else { return }
        tab.thumbnail = image
        for other in tabs where other !== tab { other.thumbnail = nil }
    }
}

extension BrowserPage {
    /// This page may look different now: the chat's picture of it is taken again, if it is the tab
    /// in front and a chat shows it.
    func looksChanged() {
        guard let browser, browser.selected?.page === self else { return }
        browser.thumbnailStale()
    }
}

/// The page the agent works in, small, over the foot of the chat; a tap opens the browser. Until
/// there is a picture, a globe. Its ✕ puts the picture away and leaves the tabs open.
///
/// In a group chat it is one of several: whose it is shows in its corner, and the others lie
/// behind it as the edges of more cards.
struct BrowserThumbnail: View {
    let browser: BrowserModel
    /// Whose browser it is, in a group chat.
    var owner: GroupBrowser.Owner?
    /// How many other browsers lie behind it.
    var behind = 0
    let action: () -> Void
    let close: () -> Void

    var body: some View {
        let size = browser.thumbnailSize
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        let site = FullScreenBrowser.site(browser.url)
        let busy = browser.agentBusy || browser.selected?.page?.loading == true
        Button {
            Haptics.tap()
            action()
        } label: {
            ZStack(alignment: .bottom) {
                if let image = browser.selected?.thumbnail {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: size.width, height: size.height)
                } else {
                    Palette.field
                    Image(systemName: "globe")
                        .font(.title3)
                        .foregroundStyle(Palette.secondary)
                        .frame(maxHeight: .infinity)
                        .padding(.bottom, site == nil ? 0 : 18)
                }
                if let site {
                    Text(site)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .padding(.horizontal, 5)
                        .frame(maxWidth: .infinity, minHeight: 18)
                        // A plain fill: a blur over a picture that keeps changing is drawn again each time.
                        .background(Palette.background)
                }
            }
            .frame(width: size.width, height: size.height)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Palette.stroke))
            .overlay(alignment: .topLeading) {
                if owner == nil, busy {
                    Circle()
                        .fill(Palette.running)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().strokeBorder(Palette.background, lineWidth: 1.5).padding(-1.5))
                        .padding(6)
                }
            }
            .background {
                // The others, as the edges of cards behind: two at most, however many there are.
                if behind > 0 {
                    ZStack {
                        ForEach(Array(1...min(behind, 2)), id: \.self) { depth in
                            shape.fill(Palette.background)
                                .overlay(shape.strokeBorder(Palette.stroke))
                                .scaleEffect(1 - 0.03 * CGFloat(depth))
                                .offset(x: 5 * CGFloat(depth), y: -5 * CGFloat(depth))
                                .opacity(1 - 0.12 * CGFloat(depth))
                                .zIndex(-Double(depth))
                        }
                    }
                }
            }
            .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label(site: site))
        .overlay(alignment: .topLeading) {
            if let owner {
                OwnerMark(owner: owner, busy: busy, behind: behind)
                    .offset(x: -8, y: -8)
                    .allowsHitTesting(false)
            }
        }
        // Over the corner, as a badge: closing the picture is not closing a tab.
        .overlay(alignment: .topTrailing) {
            Button {
                Haptics.tap()
                close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Palette.secondary)
                    .frame(width: 20, height: 20)
                    .background(Palette.background, in: Circle())
                    .overlay(Circle().strokeBorder(Palette.stroke))
                    .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
                    .hitTarget(32)
            }
            .buttonStyle(.plain)
            .offset(x: 10, y: -10)
            .accessibilityLabel(Text("关闭预览"))
        }
        .transition(.opacity.combined(with: .scale(scale: 0.8, anchor: .bottomLeading)))
        .onAppear { browser.watchThumbnail(true) }
        .onDisappear { browser.watchThumbnail(false) }
        .onChange(of: browser.selectedId) { _, _ in browser.thumbnailStale(settle: 0) }
    }

    private func label(site: String?) -> Text {
        switch owner {
        case nil: Text("浏览器：\(site ?? "")")
        case .group: Text("群聊的浏览器：\(site ?? "")")
        case .member(_, let name): Text("\(name)的浏览器：\(site ?? "")")
        }
    }
}

/// Whose browser a group chat's picture is: the member's face (the group's own: the group's
/// mark), ringed green while it works there, and how many more there are.
private struct OwnerMark: View {
    let owner: GroupBrowser.Owner
    let busy: Bool
    let behind: Int

    var body: some View {
        HStack(spacing: 3) {
            OwnerFace(owner: owner, size: 24)
                .padding(2)
                .background(Palette.background, in: Circle())
                .overlay {
                    if busy { Circle().strokeBorder(Palette.running, lineWidth: 1.5) }
                }
            if behind > 0 {
                Text(verbatim: "+\(behind)")
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Palette.onInk)
                    .padding(.horizontal, 6)
                    .frame(height: 18)
                    .background(Palette.ink, in: Capsule())
                    .overlay(Capsule().strokeBorder(Palette.background, lineWidth: 2).padding(-2))
            }
        }
        .accessibilityHidden(true)
    }
}

/// A browser's owner as a face: a member's own avatar, the group's mark for the group's own.
struct OwnerFace: View {
    @Environment(AppModel.self) private var app
    let owner: GroupBrowser.Owner
    var size: CGFloat = 24

    var body: some View {
        switch owner {
        case .group:
            Image(systemName: "person.2.fill")
                .font(.system(size: size * 0.42))
                .foregroundStyle(Palette.secondary)
                .frame(width: size, height: size)
                .background(Palette.control, in: Circle())
        case .member(let bot, let name):
            BotAvatar(bot: bot.flatMap(app.botTeam.bot), name: name, size: size)
        }
    }
}

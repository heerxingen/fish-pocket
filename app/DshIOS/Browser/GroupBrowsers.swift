import Foundation

/// One of the browsers a group chat shows: the group's own, where links tapped in the chat open,
/// or a member's. A member speaks in a group from a hidden session of its own (ds-bot's group
/// session), and the agent's browser is its session's (`BrowserAgent.owner`), so each member has
/// one per group, apart from its own chat's.
struct GroupBrowser: Identifiable {
    enum Owner: Equatable {
        case group
        /// `bot` is nil when the session's name no longer matches a member's: `name` is then
        /// the one the session was made with.
        case member(bot: String?, name: String)
    }

    let model: BrowserModel
    let owner: Owner
    var id: ObjectIdentifier { ObjectIdentifier(model) }
    /// The agent is at work in it, or a page is loading.
    @MainActor var busy: Bool { model.agentBusy || model.selected?.page?.loading == true }
}

enum GroupBrowsers {
    /// The group's browsers that have a page: the group's own first, then the members' in the
    /// group's order, so a list of them does not move about while they work.
    @MainActor
    static func list(roomId: String, in app: AppModel) -> [GroupBrowser] {
        let team = app.botTeam
        guard let room = team.room(roomId) else { return [] }
        var found: [GroupBrowser] = []
        if let own = BrowserModel.existing(room.sessionId), own.hasPages { found.append(GroupBrowser(model: own, owner: .group)) }
        // `parts` holds the members' hidden sessions (and their earlier ones) and the group's
        // own earlier parts, `ownParts` only the latter.
        let ownParts = Set(room.json["ownParts"].array.compactMap(\.string))
        let members = room.members.compactMap(team.bot)
        var byMember: [String: GroupBrowser] = [:]
        var strays: [GroupBrowser] = []
        for id in room.json["parts"].array.compactMap(\.string) where id != room.sessionId && !ownParts.contains(id) {
            guard let model = BrowserModel.existing(id), model.hasPages else { continue }
            let owner = owner(of: id, room: room, members: members, in: app)
            let browser = GroupBrowser(model: model, owner: owner)
            if case .member(let bot?, _) = owner {
                // A member's earlier session and its current one: the one used last stands for it.
                if let kept = byMember[bot], (kept.model.lastUsed ?? .distantPast) >= (model.lastUsed ?? .distantPast) { continue }
                byMember[bot] = browser
            } else {
                strays.append(browser)
            }
        }
        found += members.compactMap { byMember[$0.id] }
        found += strays
        return found
    }

    /// The one to show in front: used last.
    @MainActor
    static func latest(_ browsers: [GroupBrowser]) -> GroupBrowser? {
        browsers.max { ($0.model.lastUsed ?? .distantPast) < ($1.model.lastUsed ?? .distantPast) }
    }

    /// ds-bot names a member's group session `名字 · 群名` when it makes it, and names nothing
    /// else for whom it is: the state it sends leaves that out. A member renamed since keeps the old name there.
    @MainActor
    private static func owner(of sessionId: String, room: RoomInfo, members: [BotInfo], in app: AppModel) -> GroupBrowser.Owner {
        let title = app.sessions[sessionId]?.title ?? ""
        if let bot = members.filter({ title.hasPrefix("\($0.name) · ") }).max(by: { $0.name.count < $1.name.count }) {
            return .member(bot: bot.id, name: bot.name)
        }
        var name = title
        if name.hasSuffix(" · \(room.name)") {
            name.removeLast(room.name.count + 3)
        } else if let cut = name.range(of: " · ") {
            name = String(name[..<cut.lowerBound])
        }
        return .member(bot: nil, name: name.isEmpty ? String(localized: "Bot") : name)
    }
}

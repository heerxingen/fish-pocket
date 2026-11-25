import Foundation

/// A conversation with an agent at work in it, as the 待办 tab lists it: one row per place the
/// user would open (a conversation, a Bot's chat, a group), however many of its sessions run.
struct RunningWork: Identifiable, Hashable {
    enum Place: Hashable {
        case session(String)
        case bot(String)
        case room(String)
    }

    let place: Place
    let title: String
    /// Subagents at work under it (a group's members count here too).
    let helpers: Int
    let updatedAt: Date
    var id: Place { place }
}

/// What the 待办 tab shows and what keeps the app running off screen: the two read the same
/// lists, so the page says exactly why the app is (or is not) kept alive. Only work that needs
/// this phone's engine counts: a session on a computer goes on without the phone.
extension AppModel {
    /// This engine's running sessions, folded into the place each belongs to.
    var runningWork: [RunningWork] {
        let running = sessions.values.filter(\.running)
        guard !running.isEmpty else { return [] }
        let team = botTeam
        let bots = team.bots, rooms = team.rooms
        var found: [RunningWork.Place: (count: Int, updatedAt: Date)] = [:]
        for session in running {
            let root = rootSession(of: session.id)
            let place: RunningWork.Place
            if let bot = bots.first(where: { $0.sessionId == root || $0.parts.contains(root) }) {
                place = .bot(bot.id)
            } else if let room = rooms.first(where: { $0.sessionId == root || $0.sessions.contains(root) }) {
                place = .room(room.id)
            } else {
                place = .session(root)
            }
            let updatedAt = sessions[root]?.updatedAt ?? session.updatedAt
            let known = found[place]
            found[place] = ((known?.count ?? 0) + 1, max(known?.updatedAt ?? updatedAt, updatedAt))
        }
        return found.map { place, entry in
            let title = switch place {
            case .session(let id): self.title(of: id)
            case .bot(let id): team.bot(id)?.name ?? "Bot"
            case .room(let id): team.room(id)?.name ?? String(localized: "群聊")
            }
            // The place's own session, when it is one of them, is not a helper.
            return RunningWork(place: place, title: title, helpers: entry.count - 1, updatedAt: entry.updatedAt)
        }
        .sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Switched-on automations, the next to run first: each needs the engine at its time.
    var armedSchedules: [JSON] {
        scheduleCatalog.filter(ScheduleRule.isArmed).sorted { ($0["scheduledAt"].string ?? "~") < ($1["scheduledAt"].string ?? "~") }
    }

    /// Something on the 待办 tab needs the engine to keep running while the app is away.
    var keepsAppAlive: Bool {
        sessions.values.contains(where: \.running) || !liveJobs.isEmpty || scheduleCatalog.contains(where: ScheduleRule.isArmed)
    }

    /// A subagent's top session (subagents can nest).
    private func rootSession(of id: String) -> String {
        var current = id
        var seen: Set<String> = []
        while let session = sessions[current], session.isSubagent, let parent = session.parentId, seen.insert(current).inserted {
            current = parent
        }
        return current
    }
}

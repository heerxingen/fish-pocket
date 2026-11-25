import SwiftUI

/// 待办: what the agents have under way on this phone. Its one kind so far is the work that
/// needs the engine to keep running when the app is away (a running session, a background job,
/// a switched-on automation); the page reads the same lists as `BackgroundKeeper`, so its top
/// row says exactly whether leaving the app keeps it running, and why. Kinds that do not keep
/// the app alive can come later as sections of their own.
struct TodoPage: View {
    /// The 待办 tab, under a large title; otherwise a sheet (`SheetStack`, an iPad before iOS 18).
    var asTab = false
    /// Opens a conversation, a Bot's chat or a group where the shell shows them.
    let open: (RunningWork.Place) -> Void

    @Environment(AppModel.self) private var app
    @AppStorage(BackgroundKeeper.enabledKey) private var keepAlive = true
    @State private var confirmingOff = false
    @State private var stopping: JobRow?
    @State private var catalog = ScheduleCatalog()

    var body: some View {
        let work = app.runningWork
        let jobs = app.liveJobs.sorted { $0.startedAt < $1.startedAt }
        let schedules = app.armedSchedules
        List {
            Section {
                status(holds: !work.isEmpty || !jobs.isEmpty || !schedules.isEmpty)
                Toggle(isOn: Binding(get: { keepAlive }, set: { on in
                    if on { keepAlive = true } else { confirmingOff = true }
                })) {
                    Text("有后台任务时保持运行")
                }
            } footer: {
                Text("只算这台手机上要引擎才能进行的事。远程控制的会话在电脑上跑，不受影响。")
            }

            if !work.isEmpty {
                Section("进行中的会话") {
                    ForEach(work) { item in
                        Button { open(item.place) } label: { workRow(item) }
                            .foregroundStyle(Palette.ink)
                    }
                }
            }

            if !jobs.isEmpty {
                Section("后台任务") {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        ForEach(jobs) { job in jobRow(job, now: context.date) }
                    }
                }
            }

            if !schedules.isEmpty {
                Section {
                    ForEach(schedules, id: \.["id"]) { record in
                        NavigationLink {
                            ScheduleDetailView(catalog: catalog, taskId: record["id"].string ?? "", openSession: { open(.session($0)) }, delete: delete)
                        } label: {
                            ScheduleRow(record: record)
                        }
                    }
                    NavigationLink { SchedulesView(openSession: { open(.session($0)) }) } label: {
                        Text("全部自动化")
                    }
                } header: {
                    Text("开启的自动化")
                } footer: {
                    Text("到点时要 App 在运行才会执行。")
                }
            }
        }
        .navigationTitle(Self.title)
        .toolbarTitleDisplayMode(asTab ? .large : .inline)
        .onChange(of: keepAlive) { BackgroundKeeper.shared.settingsChanged() }
        .alert("关闭后台保持运行？", isPresented: $confirmingOff) {
            Button("取消", role: .cancel) {}
            Button("关闭", role: .destructive) { keepAlive = false }
        } message: {
            Text("离开 App 后，进行中的任务最多再跑约 30 秒，之后引擎可能被系统暂停，自动化和开发服务器会中断。")
        }
        .stopJobDialog($stopping) { job in Task { await stop(job) } }
        // The detail pages read and edit through the catalog; the rows come from the app's own copy.
        .task(id: app.revision("schedule/changed")) { await catalog.load(app.client) }
    }

    /// The tab's name and the page's title.
    static var title: String {
        String(localized: "tab.todo", defaultValue: "待办", comment: "Tab and page title: what the agents have under way on this phone (running sessions, background jobs, automations)")
    }

    // MARK: Rows

    /// Whether leaving the app now keeps it running.
    private func status(holds: Bool) -> some View {
        let (icon, title, detail): (String, String, String) =
            if !holds {
                ("moon.zzz", String(localized: "没有需要后台运行的事"), String(localized: "离开 App 后，系统会照常暂停它，回来时自动恢复。"))
            } else if keepAlive {
                ("bolt.horizontal.circle", String(localized: "离开 App 后会保持运行"), String(localized: "下面这些事需要引擎继续运行，会多耗一些电。"))
            } else {
                ("exclamationmark.triangle", String(localized: "后台保持运行已关闭"), String(localized: "离开 App 后，下面这些事可能被系统暂停。"))
            }
        return HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Palette.onInk)
                .frame(width: 38, height: 38)
                .background(holds && !keepAlive ? Palette.waiting : Palette.ink, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body).foregroundStyle(Palette.ink)
                Text(detail).font(.footnote).foregroundStyle(Palette.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private func workRow(_ item: RunningWork) -> some View {
        let kind: String = switch item.place {
        case .session: item.helpers > 0 ? String(localized: "会话 · \(item.helpers) 个子智能体") : String(localized: "会话")
        case .bot: "Bot"
        case .room: String(localized: "群聊")
        }
        return HStack(spacing: 10) {
            StatusDot(state: .running).frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(2)
                Text(kind).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func jobRow(_ job: JobRow, now: Date) -> some View {
        Group {
            if let owner = job.owner {
                NavigationLink { TodoJobOutput(sessionId: owner, job: job) } label: { jobLabel(job, now: now) }
            } else {
                jobLabel(job, now: now)
            }
        }
        .swipeActions {
            if job.status == "running", job.owner != nil {
                Button { stopping = job } label: { Label("停止", systemImage: "stop.fill") }
                    .tint(Palette.removed)
            }
        }
        .contextMenu {
            Button { copyToPasteboard(job.label) } label: { Label("复制", systemImage: "doc.on.doc") }
            if job.status == "running", job.owner != nil {
                Button(role: .destructive) { stopping = job } label: { Label("停止", systemImage: "stop.fill") }
            }
        }
    }

    /// The job, and the conversation it was started in.
    private func jobLabel(_ job: JobRow, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            JobRowLabel(job: job, now: now)
            if let owner = job.owner {
                Text(app.title(of: owner))
                    .font(.caption).foregroundStyle(Palette.faint).lineLimit(1)
                    .padding(.leading, 24)
            }
        }
    }

    // MARK: Actions

    private func stop(_ job: JobRow) async {
        guard let owner = job.owner else { return }
        do {
            try await app.client.call("job/kill", ["request": ["sessionId": .string(owner), "jobId": .string(job.id)]])
            Haptics.firm()
        } catch {
            Haptics.error()
            app.showToast(String(localized: "停止失败"), tone: .warning)
        }
    }

    /// As the automation page deletes: hard delete, the outcome in the shell toast.
    private func delete(_ record: JSON) async -> Bool {
        do {
            _ = try await app.client.call("schedule/edit", ["request": ["id": record["id"], "action": "delete"]])
            Haptics.success()
            app.showToast(String(localized: "任务已删除"))
            await catalog.load(app.client)
            return true
        } catch {
            Haptics.error()
            app.showToast(String(localized: "无法删除任务"))
            return false
        }
    }
}

/// A job's live output from the 待办 tab: the page the conversation's job list pushes, with
/// that session's roster followed for as long as it is open.
private struct TodoJobOutput: View {
    let sessionId: String
    let job: JobRow
    @Environment(AppModel.self) private var app
    @State private var jobs = JobsModel()

    var body: some View {
        JobOutputView(sessionId: sessionId, jobs: jobs, job: job)
            .task { await jobs.follow(sessionId: sessionId, app: app) }
    }
}

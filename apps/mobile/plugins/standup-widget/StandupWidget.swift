// The Standup widget: the user's open standup tasks and how many finished
// today, for the Home Screen, StandBy and the Lock Screen. It fetches
// GET /api/firstmate/standup itself on a 15-minute timeline, so it needs no
// push notifications and no running app.
//
// The app shares the Work environment's address and bearer token through its
// keychain access group (see src/widgets/standupWidgetKeychain.ts). Device
// builds sign with a team that has no App Groups, so there is no shared
// container; the last good summary is cached in the extension's own defaults.

import Security
import SwiftUI
import WidgetKit

private let refreshInterval: TimeInterval = 15 * 60

// MARK: - Data

private struct Credential: Decodable {
  let httpBaseUrl: String
  let token: String
  let openUrl: String
}

struct StandupSummary: Codable {
  struct Row: Codable {
    let taskId: String
    let title: String
    let progress: String
    let agentName: String
  }

  let open: Int
  let needsYou: Int
  let running: Int
  let tasks: [Row]
  let doneAt: [String]?
  let generatedAt: String
}

/// Matches expo-secure-store's item for service `t3work.standup-widget`.
private func readCredential() -> Credential? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "t3work.standup-widget:no-auth",
    kSecAttrAccount as String: Data("credential".utf8),
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
    let data = item as? Data
  else { return nil }
  return try? JSONDecoder().decode(Credential.self, from: data)
}

private enum FetchResult {
  case loaded(StandupSummary)
  case signedOut
  case unreachable
}

private func fetchSummary(_ credential: Credential) async -> FetchResult {
  guard let base = URL(string: credential.httpBaseUrl) else { return .signedOut }
  var request = URLRequest(url: base.appendingPathComponent("api/firstmate/standup"))
  request.timeoutInterval = 12
  request.cachePolicy = .reloadIgnoringLocalCacheData
  request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
  do {
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 || status == 403 { return .signedOut }
    guard status == 200 else { return .unreachable }
    return .loaded(try JSONDecoder().decode(StandupSummary.self, from: data))
  } catch {
    return .unreachable
  }
}

private enum SummaryCache {
  static let key = "standup-summary"

  static func load() -> StandupSummary? {
    guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(StandupSummary.self, from: data)
  }

  static func save(_ summary: StandupSummary) {
    if let data = try? JSONEncoder().encode(summary) {
      UserDefaults.standard.set(data, forKey: key)
    }
  }
}

private let isoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private func parseDate(_ value: String) -> Date? {
  isoFormatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

// MARK: - Timeline

struct StandupEntry: TimelineEntry {
  enum Content {
    case summary(StandupSummary, stale: Bool)
    case signedOut
    case unavailable
  }

  let date: Date
  let content: Content
  let openURL: URL?

  /// Done or live today, in the phone's time zone. Nil when the server does not say.
  var doneToday: Int? {
    guard case .summary(let summary, _) = content, let doneAt = summary.doneAt else { return nil }
    let startOfDay = Calendar.current.startOfDay(for: date)
    return doneAt.compactMap(parseDate).filter { $0 >= startOfDay }.count
  }

  var updatedAt: Date? {
    guard case .summary(let summary, _) = content else { return nil }
    return parseDate(summary.generatedAt)
  }

  static let sample = StandupEntry(
    date: .now,
    content: .summary(
      StandupSummary(
        open: 3,
        needsYou: 1,
        running: 1,
        tasks: [
          .init(taskId: "1", title: "Ship the offer history", progress: "needs_you", agentName: "Firstmate"),
          .init(taskId: "2", title: "Page and link system", progress: "running", agentName: "Joan"),
          .init(taskId: "3", title: "Upload Hilton prices", progress: "not_started", agentName: "Firstmate"),
        ],
        doneAt: [isoFormatter.string(from: .now)],
        generatedAt: isoFormatter.string(from: .now)
      ),
      stale: false
    ),
    openURL: nil
  )
}

struct StandupProvider: TimelineProvider {
  func placeholder(in context: Context) -> StandupEntry { .sample }

  func getSnapshot(in context: Context, completion: @escaping (StandupEntry) -> Void) {
    if context.isPreview, readCredential() == nil {
      completion(.sample)
      return
    }
    Task { completion(await entry()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<StandupEntry>) -> Void) {
    Task {
      let entry = await entry()
      completion(Timeline(entries: [entry], policy: .after(entry.date.addingTimeInterval(refreshInterval))))
    }
  }

  private func entry() async -> StandupEntry {
    let now = Date.now
    guard let credential = readCredential() else {
      return StandupEntry(date: now, content: .signedOut, openURL: nil)
    }
    let openURL = URL(string: credential.openUrl)
    switch await fetchSummary(credential) {
    case .loaded(let summary):
      SummaryCache.save(summary)
      return StandupEntry(date: now, content: .summary(summary, stale: false), openURL: openURL)
    case .signedOut:
      return StandupEntry(date: now, content: .signedOut, openURL: openURL)
    case .unreachable:
      // Off the tailnet or the server is restarting: keep the last answer, marked stale.
      if let cached = SummaryCache.load() {
        return StandupEntry(date: now, content: .summary(cached, stale: true), openURL: openURL)
      }
      return StandupEntry(date: now, content: .unavailable, openURL: openURL)
    }
  }
}

// MARK: - Views

private func progressColor(_ progress: String) -> Color {
  switch progress {
  case "needs_you": return .red
  case "running": return .blue
  case "waiting": return .orange
  default: return .secondary
  }
}

private func progressLabel(_ progress: String) -> String {
  switch progress {
  case "needs_you": return "Needs you"
  case "running": return "Running"
  case "waiting": return "Waiting"
  case "not_started": return "Not started"
  default: return "Open"
  }
}

private struct Header: View {
  let entry: StandupEntry

  var body: some View {
    HStack(spacing: 4) {
      Text("Standup").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      Spacer(minLength: 0)
      if case .summary(_, let stale) = entry.content, stale, let updatedAt = entry.updatedAt {
        Text(updatedAt, style: .time).font(.caption2).foregroundStyle(.secondary)
      }
    }
  }
}

private struct Counts: View {
  let summary: StandupSummary
  let doneToday: Int?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text("\(summary.open)").font(.system(.title, design: .rounded).weight(.semibold))
        .contentTransition(.numericText())
      VStack(alignment: .leading, spacing: 0) {
        Text("open").font(.caption2).foregroundStyle(.secondary)
        if let doneToday {
          Text("\(doneToday) done today").font(.caption2).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
      if summary.needsYou > 0 {
        Label("\(summary.needsYou)", systemImage: "exclamationmark.circle.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.red)
          .accessibilityLabel("\(summary.needsYou) need you")
      }
    }
  }
}

private struct TaskLine: View {
  let task: StandupSummary.Row
  let showsOwner: Bool

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(progressColor(task.progress)).frame(width: 7, height: 7)
        .widgetAccentable()
      VStack(alignment: .leading, spacing: 0) {
        Text(task.title).font(.caption).lineLimit(1)
        if showsOwner {
          Text("\(task.agentName) · \(progressLabel(task.progress))")
            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(task.title), \(task.agentName), \(progressLabel(task.progress))")
  }
}

private struct Message: View {
  let title: String
  let detail: String

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(.subheadline.weight(.semibold))
      Text(detail).font(.caption).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}

struct StandupWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: StandupEntry

  var body: some View {
    content
      .widgetURL(entry.openURL)
      .containerBackground(.fill.tertiary, for: .widget)
  }

  @ViewBuilder private var content: some View {
    switch family {
    case .accessoryInline: inline
    case .accessoryCircular: circular
    case .accessoryRectangular: rectangular
    default: system
    }
  }

  @ViewBuilder private var system: some View {
    switch entry.content {
    case .signedOut:
      VStack(alignment: .leading) {
        Header(entry: entry)
        Message(title: "Open T3 Work", detail: "Connect to your T3 Work server to see your standup.")
      }
    case .unavailable:
      VStack(alignment: .leading) {
        Header(entry: entry)
        Message(title: "Can't reach T3 Work", detail: "Tries again in a few minutes.")
      }
    case .summary(let summary, _):
      let limit = family == .systemSmall ? 2 : (family == .systemMedium ? 3 : 8)
      VStack(alignment: .leading, spacing: 6) {
        Header(entry: entry)
        Counts(summary: summary, doneToday: entry.doneToday)
        if summary.tasks.isEmpty {
          Text("Nothing open").font(.caption).foregroundStyle(.secondary)
        } else {
          VStack(alignment: .leading, spacing: family == .systemSmall ? 3 : 5) {
            ForEach(summary.tasks.prefix(limit), id: \.taskId) { task in
              TaskLine(task: task, showsOwner: family != .systemSmall)
            }
          }
        }
        Spacer(minLength: 0)
      }
    }
  }

  @ViewBuilder private var rectangular: some View {
    switch entry.content {
    case .summary(let summary, _):
      VStack(alignment: .leading, spacing: 1) {
        Text(rectangularHeadline(summary)).font(.headline).widgetAccentable()
        ForEach(summary.tasks.prefix(2), id: \.taskId) { task in
          Text(task.title).font(.caption).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    case .signedOut:
      Text("Open T3 Work to see your standup").font(.caption)
    case .unavailable:
      Text("Standup unavailable").font(.caption)
    }
  }

  private func rectangularHeadline(_ summary: StandupSummary) -> String {
    var parts = ["\(summary.open) open"]
    if summary.needsYou > 0 { parts.append("\(summary.needsYou) need you") }
    if let done = entry.doneToday, done > 0 { parts.append("\(done) done") }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder private var inline: some View {
    if case .summary(let summary, _) = entry.content {
      Text("Standup: \(rectangularHeadline(summary))")
    } else {
      Text("Standup")
    }
  }

  @ViewBuilder private var circular: some View {
    ZStack {
      AccessoryWidgetBackground()
      if case .summary(let summary, _) = entry.content {
        VStack(spacing: 0) {
          Text("\(summary.open)").font(.title3.weight(.semibold))
          Text(summary.needsYou > 0 ? "\(summary.needsYou)!" : "open").font(.caption2)
        }
      } else {
        Image(systemName: "checklist")
      }
    }
  }
}

// MARK: - Widget

@main
struct StandupWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "T3WorkStandup", provider: StandupProvider()) { entry in
      StandupWidgetView(entry: entry)
    }
    .configurationDisplayName("Standup")
    .description("Your open standup tasks and what finished today.")
    .supportedFamilies([
      .systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline, .accessoryCircular,
    ])
  }
}

// The Standup widget: every open standup task with its status, in the Work
// tab's Standup order, for the Home Screen, StandBy and the Lock Screen. It fetches
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
    let agentIcon: String?
    let agentColor: String?
  }

  /// Every open task; `tasks` holds the first 20 (5 from servers older than the list widget).
  let open: Int
  let tasks: [Row]
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

  static let sample: StandupEntry = {
    let rows: [(String, String, String, String, String)] = [
      ("Ship the offer history page", "needs_you", "Firstmate", "compass", "sky"),
      ("Page and link system cleanup", "running", "Joan", "bot", "violet"),
      ("Upload Hilton prices", "running", "Firstmate", "compass", "sky"),
      ("Card benefits audit", "waiting", "Ledger", "wallet", "emerald"),
      ("Fix the mockup capture retries", "running", "Joan", "bot", "violet"),
      ("Draft the Q4 partner brief", "not_started", "Firstmate", "compass", "sky"),
      ("Mobile standup widget", "needs_you", "Firstmate", "compass", "sky"),
      ("Review Chase affiliate terms", "waiting", "Ledger", "wallet", "emerald"),
      ("Refresh the Amex card art", "running", "Joan", "bot", "violet"),
      ("Merge the credit history PR", "needs_you", "Firstmate", "compass", "sky"),
      ("Head-to-head dark mode", "running", "Money Maker", "dollar-sign", "amber"),
      ("Explore credit pages", "waiting", "Money Maker", "dollar-sign", "amber"),
      ("Backfill Vercel env names", "not_started", "Firstmate", "compass", "sky"),
      ("Weekly link analytics digest", "waiting", "Ledger", "wallet", "emerald"),
      ("Retire the old offer table", "not_started", "Joan", "bot", "violet"),
      ("Office review rules update", "waiting", "Firstmate", "compass", "sky"),
    ]
    let tasks = rows.enumerated().map { index, row in
      StandupSummary.Row(
        taskId: "\(index)", title: row.0, progress: row.1, agentName: row.2, agentIcon: row.3,
        agentColor: row.4)
    }
    return StandupEntry(
      date: .now,
      content: .summary(
        StandupSummary(open: tasks.count, tasks: tasks, generatedAt: isoFormatter.string(from: .now)),
        stale: false),
      openURL: nil)
  }()
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

/// The worker status the app's Standup rows show, as a symbol so it still reads
/// in one tint (Lock Screen, StandBy at night).
private struct Status {
  let label: String
  let symbol: String
  let style: AnyShapeStyle

  init(_ progress: String) {
    switch progress {
    case "needs_you":
      (label, symbol, style) = ("Needs you", "exclamationmark.circle.fill", AnyShapeStyle(.red))
    case "running":
      (label, symbol, style) = ("Working", "play.circle.fill", AnyShapeStyle(.cyan))
    case "not_started":
      (label, symbol, style) = ("Not started", "circle.dashed", AnyShapeStyle(.secondary))
    default:
      (label, symbol, style) = ("Waiting", "pause.circle", AnyShapeStyle(.secondary))
    }
  }
}

/// The app's agent icon keys (client-runtime `firstmate/icons`) as SF Symbols; unknown keys draw the compass.
private func agentSymbol(_ icon: String?) -> String {
  switch icon {
  case "ship-wheel": return "steeringwheel"
  case "anchor": return "ferry"
  case "sparkles": return "sparkles"
  case "bot": return "cpu"
  case "rocket": return "airplane.departure"
  case "star": return "star.fill"
  case "zap": return "bolt.fill"
  case "brain": return "brain"
  case "heart": return "heart.fill"
  case "flag": return "flag.fill"
  case "crown": return "crown.fill"
  case "dollar-sign": return "dollarsign"
  case "wallet": return "wallet.pass.fill"
  case "chart-no-axes-combined": return "chart.line.uptrend.xyaxis"
  case "briefcase-business": return "briefcase.fill"
  case "code": return "chevron.left.forwardslash.chevron.right"
  case "search": return "magnifyingglass"
  case "book-open": return "book.fill"
  case "graduation-cap": return "graduationcap.fill"
  case "palette": return "paintpalette.fill"
  case "camera": return "camera.fill"
  case "shield-check": return "checkmark.shield.fill"
  case "globe": return "globe"
  default: return "safari"
  }
}

/// The project icon palette's 500 shades, as the app tints agent icons.
private func agentColor(_ name: String?) -> Color {
  switch name {
  case "gray": return Color(red: 0.42, green: 0.45, blue: 0.50)
  case "red": return Color(red: 0.94, green: 0.27, blue: 0.27)
  case "orange": return Color(red: 0.98, green: 0.45, blue: 0.09)
  case "amber": return Color(red: 0.96, green: 0.62, blue: 0.04)
  case "yellow": return Color(red: 0.92, green: 0.70, blue: 0.03)
  case "lime": return Color(red: 0.52, green: 0.80, blue: 0.09)
  case "green": return Color(red: 0.13, green: 0.77, blue: 0.37)
  case "emerald": return Color(red: 0.06, green: 0.73, blue: 0.51)
  case "teal": return Color(red: 0.08, green: 0.72, blue: 0.65)
  case "cyan": return Color(red: 0.02, green: 0.71, blue: 0.83)
  case "blue": return Color(red: 0.23, green: 0.51, blue: 0.96)
  case "indigo": return Color(red: 0.39, green: 0.40, blue: 0.95)
  case "violet": return Color(red: 0.55, green: 0.36, blue: 0.96)
  case "purple": return Color(red: 0.66, green: 0.33, blue: 0.97)
  case "fuchsia": return Color(red: 0.85, green: 0.27, blue: 0.94)
  case "pink": return Color(red: 0.93, green: 0.28, blue: 0.60)
  case "rose": return Color(red: 0.96, green: 0.25, blue: 0.37)
  default: return Color(red: 0.05, green: 0.65, blue: 0.91)  // sky, the agent default
  }
}

/// How many rows each size draws, the "+N more" line included when tasks overflow.
private func rowCapacity(_ family: WidgetFamily) -> Int {
  switch family {
  case .systemLarge: return 14
  case .accessoryRectangular: return 3
  default: return 7
  }
}

private struct TaskLine: View {
  let task: StandupSummary.Row
  let font: Font
  let showsOwner: Bool
  let showsLabel: Bool
  /// Read before the first row's label, since the widget shows no header.
  var spokenPrefix: String? = nil

  var body: some View {
    let status = Status(task.progress)
    HStack(spacing: 5) {
      Image(systemName: status.symbol).foregroundStyle(status.style).widgetAccentable()
      if showsOwner {
        Image(systemName: agentSymbol(task.agentIcon)).foregroundStyle(agentColor(task.agentColor))
          .frame(minWidth: 14)
      }
      Text(task.title).lineLimit(1)
      if showsLabel {
        Spacer(minLength: 4)
        Text(status.label).foregroundStyle(status.style).lineLimit(1).layoutPriority(1)
      }
    }
    .font(font)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      [spokenPrefix, "\(task.title), \(task.agentName), \(status.label)"]
        .compactMap { $0 }.joined(separator: ". "))
  }
}

/// Every open task, top to bottom, ending with "+N more" when they don't fit.
private struct TaskList: View {
  @Environment(\.widgetFamily) private var family
  let summary: StandupSummary
  let stale: Bool

  var body: some View {
    let capacity = rowCapacity(family)
    let lockScreen = family == .accessoryRectangular
    // Overflow is judged against the rows actually sent: an older server sends at most five.
    // The Lock Screen can't spare a line for the count.
    let overflows = !lockScreen && summary.open > min(capacity, summary.tasks.count)
    let shown = Array(summary.tasks.prefix(overflows ? capacity - 1 : capacity))
    let stalePrefix = stale ? staleDescription(summary.generatedAt) : nil
    let font: Font = family == .systemLarge ? .subheadline : .caption
    VStack(alignment: .leading, spacing: lockScreen ? 1 : (family == .systemLarge ? 6 : 4)) {
      if shown.isEmpty {
        Text("Nothing on the standup").font(font).foregroundStyle(.secondary)
      }
      ForEach(Array(shown.enumerated()), id: \.element.taskId) { index, task in
        TaskLine(
          task: task,
          font: font,
          showsOwner: family != .systemSmall,
          showsLabel: family == .systemMedium || family == .systemLarge,
          spokenPrefix: index == 0 ? stalePrefix : nil
        )
      }
      if overflows {
        Text("+\(summary.open - shown.count) more").font(.caption2).foregroundStyle(.secondary)
      }
      if !lockScreen { Spacer(minLength: 0) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    // An answer kept from before the server went out of reach, shown dimmed rather than as current.
    .opacity(stale ? 0.55 : 1)
    // Row counts are fitted at the default text size; larger text would clip the last rows and "+N more".
    .dynamicTypeSize(...DynamicTypeSize.large)
  }

  private func staleDescription(_ generatedAt: String) -> String {
    guard let date = isoFormatter.date(from: generatedAt) ?? ISO8601DateFormatter().date(from: generatedAt)
    else { return "Not current" }
    return "Last updated \(date.formatted(date: .omitted, time: .shortened))"
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
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
    switch entry.content {
    case .summary(let summary, let stale):
      TaskList(summary: summary, stale: stale)
    case .signedOut:
      if family == .accessoryRectangular {
        Text("Open T3 Work to see your standup").font(.caption)
      } else {
        Message(title: "Open T3 Work", detail: "Connect to your T3 Work server to see your standup.")
      }
    case .unavailable:
      if family == .accessoryRectangular {
        Text("Standup unavailable").font(.caption)
      } else {
        Message(title: "Can't reach T3 Work", detail: "Tries again in a few minutes.")
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
    .description("Every open standup task and its status.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
  }
}

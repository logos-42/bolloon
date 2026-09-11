//
//  BolloonIntents.swift
//  Bolloon Agent — iOS 系统入口 (Siri / 快捷指令 Shortcuts / Spotlight 聚焦)
//
//  设计 (2026-09-11)
//  ----------------
//  1. 唯一的深链协议是自定义 URL Scheme `bolloon://` (见 Info.plist 的 CFBundleURLTypes):
//        bolloon://agent/run?name=<urlencoded name>[&goal=<urlencoded text>]   运行智能体
//        bolloon://agent/status?name=<urlencoded name>                         查看智能体状态
//     解析/构造规则与 WebView 侧 src/web/mobile-core.ts 的 handleDeepLink() 一一对应。
//
//  2. App Intents 只做一件事: 把用户的语音/快捷指令意图翻译成上面的深链, 然后投递给 WebView。
//     **真正的执行在 WebView 里** (mobile-core.ts handleDeepLink → mobile.js openDeepLinkTarget),
//     Swift 侧不复制任何智能体逻辑。
//
//  3. 深链投递不依赖原生插件。本仓库**没有安装 @capacitor/app** (package.json 无该依赖),
//     所以没有 appUrlOpen 事件可用。这里走两条非插件路径:
//        a) perform() 里直接找到当前 WKWebView, 注入 window.__bolloonPendingDeepLink 并派发
//           'bolloon:deeplink' 事件 (mobile.js 监听);
//        b) 兜底: 写 UserDefaults pending key + 读 Capacitor 的 ApplicationDelegateProxy.shared.lastURL
//           (AppDelegate 的 open url 已经转发给它)。冷启动由 URL 拉起时 lastURL 才有值。
//
//  冷启动链路 (2026-09-11 修通):
//    AppDelegate 在 didFinishLaunchingWithOptions 里:
//      a) BolloonURLInbox.shared.install() —— 启动即装 didBecomeActive 观察者;
//      b) 若 launchOptions[.url] 有值 (未运行时被 url 拉起), 交给 handleColdLaunch(url:)。
//    系统对**冷启动**的 URL Scheme 只放进 launchOptions[.url], 不走 application(_:open:) ——
//    Capacitor 的 ApplicationDelegateProxy 不记录它, 所以必须显式交接, 否则 openurl 只能拉前台。
//    投递采用重试 (0/0.5/2/5/8s): 冷启动时 WKWebView 尚未建好 / 页面导航会冲掉注入的 window 标记,
//    重试能在 mobile.js init 装好 'bolloon:deeplink' 监听器之后打中。
//

import Foundation
import UIKit
import WebKit
import AppIntents
import Capacitor

// MARK: - 1. 深链协议 (纯 Foundation, iOS 15 即可用)

/// `bolloon://` 深链的解析与构造。与 `src/web/mobile-core.ts:handleDeepLink` 保持同一协议。
enum BolloonDeepLink {

    static let scheme = "bolloon"

    /// 目前支持的 action (路径段): run / status
    enum Action: String {
        case run
        case status
    }

    struct Parsed {
        let action: Action
        let name: String
        let goal: String?
    }

    /// 解析 `bolloon://agent/run?name=xxx`。非法/不认识的 URL → nil (不抛异常)。
    static func parse(_ raw: String) -> Parsed? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let comps = URLComponents(string: trimmed) else { return nil }
        guard (comps.scheme ?? "").lowercased() == scheme else { return nil }

        let host = (comps.host ?? "").lowercased()
        let pathSegment = comps.path
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .lowercased()
        // bolloon://agent/run (host=agent, path=/run) 与 bolloon://run (只有 host) 两种写法都认
        let actionRaw = pathSegment.isEmpty ? host : pathSegment
        guard let action = Action(rawValue: actionRaw) else { return nil }
        if !pathSegment.isEmpty && host != "agent" { return nil }

        var name = ""
        var goal: String?
        for item in comps.queryItems ?? [] {
            switch item.name {
            case "name": name = item.value ?? ""
            case "goal": goal = item.value
            default: break
            }
        }
        return Parsed(action: action, name: name, goal: goal)
    }

    /// 构造深链 (URLComponents 会自动对中文/空格做百分号编码)。
    static func makeURL(action: Action, name: String, goal: String? = nil) -> URL? {
        var comps = URLComponents()
        comps.scheme = scheme
        comps.host = "agent"
        comps.path = "/" + action.rawValue
        var items = [URLQueryItem(name: "name", value: name)]
        if let goal = goal, !goal.isEmpty { items.append(URLQueryItem(name: "goal", value: goal)) }
        comps.queryItems = items
        return comps.url
    }
}

// MARK: - 2. 智能体数据源

/// Swift 侧能拿到的智能体列表来源。
///
/// **真实来源 / 回退说清楚**:
///   - 手机端真正的智能体数据在 WebView 的 IndexedDB 里 (src/web/mobile-data.ts), Swift 侧**读不到**
///     (没有安装 @capacitor/preferences 或 @capacitor/filesystem, 无法访问 WebView 的 localStorage/IDB)。
///   - 所以这里两段式:
///       ① 先读 App 沙盒里的 JSON 缓存 `<Application Support>/bolloon-agents.json`
///          (格式 `[{"id":"...","name":"..."}]`)。**当前 WebView 侧不会写这个文件** —— 等哪天装了
///          @capacitor/filesystem, 由 mobile.js 写一份, 这里的候选列表就变成真实的了。留着读的口子。
///       ② 读不到 / 解析失败 → 用下面的静态回退列表 (就是一个"本机智能体"):
///          名字取 `本机智能体`, 与 WebView 首页本机卡片的默认名一致, 深链过去能被 mobile.js 匹配到。
enum BolloonAgentRegistry {

    /// 一条候选 (不依赖 iOS 16 的 AgentEntity, 方便非 AppIntents 代码复用)
    typealias Row = (id: String, name: String)

    /// 静态回退列表 (Swift 侧拿不到 WebView 数据时的兜底; 只保证"能唤起", 不保证覆盖全部智能体)
    static let fallback: [Row] = [
        (id: "fallback:default", name: "本机智能体")
    ]

    /// JSON 缓存路径 (WebView 侧目前不写; 留着这个读取口子)
    static var cacheURL: URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                                in: .userDomainMask).first else { return nil }
        return dir.appendingPathComponent("bolloon-agents.json")
    }

    /// 候选智能体: JSON 缓存优先, 否则静态回退。
    static func all() -> [Row] {
        if let url = cacheURL,
           let data = try? Data(contentsOf: url),
           let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
           !rows.isEmpty {
            let list: [Row] = rows.compactMap { row in
                let name = (row["name"] as? String) ?? ""
                guard !name.isEmpty else { return nil }
                let id = (row["id"] as? String) ?? name
                return (id: id, name: name)
            }
            if !list.isEmpty { return list }
        }
        return fallback
    }
}

// MARK: - 3. App Intents (iOS 16+; 本工程 deployment target 15.0 → 全部加可用性标注)

@available(iOS 16.0, *)
struct AgentEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Bolloon 智能体")
    static var defaultQuery = AgentQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

@available(iOS 16.0, *)
struct AgentQuery: EntityStringQuery {

    private func entities(from rows: [(id: String, name: String)]) -> [AgentEntity] {
        rows.map { AgentEntity(id: $0.id, name: $0.name) }
    }

    func entities(for identifiers: [String]) async throws -> [AgentEntity] {
        entities(from: BolloonAgentRegistry.all().filter { identifiers.contains($0.id) })
    }

    func entities(matching string: String) async throws -> [AgentEntity] {
        let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
        let all = BolloonAgentRegistry.all()
        if needle.isEmpty { return entities(from: all) }
        return entities(from: all.filter { $0.name.localizedCaseInsensitiveContains(needle) })
    }

    func suggestedEntities() async throws -> [AgentEntity] {
        entities(from: BolloonAgentRegistry.all())
    }
}

/// 运行智能体: 组 `bolloon://agent/run?name=...` 并投递给 WebView。
@available(iOS 16.0, *)
struct RunAgentIntent: AppIntent {
    static var title: LocalizedStringResource = "运行 Bolloon 智能体"
    static var description = IntentDescription("在 Bolloon App 里运行指定的智能体")
    /// 需要把 App 拉到前台 (执行在 WebView 里, 所以必须有界面)
    static var openAppWhenRun: Bool = true

    @Parameter(title: "智能体")
    var agent: AgentEntity

    static var parameterSummary: some ParameterSummary {
        Summary("运行 \(\.$agent)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let name = agent.name
        guard let url = BolloonDeepLink.makeURL(action: .run, name: name) else {
            return .result(dialog: "没能构造深链 (名字为空?)")
        }
        await BolloonURLInbox.shared.deliver(url: url, action: .run, name: name, goal: nil)
        return .result(dialog: "正在 Bolloon 里打开智能体「\(name)」")
    }
}

/// 查看智能体状态: 组 `bolloon://agent/status?name=...` 并投递给 WebView。
@available(iOS 16.0, *)
struct OpenAgentStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "查看 Bolloon 智能体状态"
    static var description = IntentDescription("打开 Bolloon 查看指定智能体的状态")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "智能体")
    var agent: AgentEntity

    static var parameterSummary: some ParameterSummary {
        Summary("查看 \(\.$agent) 状态")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let name = agent.name
        guard let url = BolloonDeepLink.makeURL(action: .status, name: name) else {
            return .result(dialog: "没能构造深链 (名字为空?)")
        }
        await BolloonURLInbox.shared.deliver(url: url, action: .status, name: name, goal: nil)
        return .result(dialog: "正在查看智能体「\(name)」的状态")
    }
}

/// Siri / 快捷指令里的短语 (Apple 强制每条短语必须包含 \(.applicationName))。
@available(iOS 16.0, *)
struct BolloonShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RunAgentIntent(),
            phrases: [
                "用 \(.applicationName) 运行智能体",
                "用 \(.applicationName) 跑一下智能体",
                "让 \(.applicationName) 干活",
            ],
            shortTitle: "运行智能体",
            systemImageName: "play.circle"
        )
        AppShortcut(
            intent: OpenAgentStatusIntent(),
            phrases: [
                "看看 \(.applicationName) 里智能体的状态",
                "\(.applicationName) 智能体状态",
            ],
            shortTitle: "智能体状态",
            systemImageName: "info.circle"
        )
    }
}

// MARK: - 4. 深链投递箱 (Swift → WebView)

/// 把深链投进 WebView。三条路径, 都是"尽力投递", 失败只记录不抛:
///   1. `window.__bolloonPendingDeepLink` + `bolloon:deeplink` 事件 (mobile.js 监听 / init 时读)
///   2. UserDefaults pending key (JS 拿不到, 但便于调试/后续插件读取)
///   3. `ApplicationDelegateProxy.shared.lastURL` (Capacitor 已收到的 open url)
@MainActor
final class BolloonURLInbox {

    static let shared = BolloonURLInbox()

    /// UserDefaults key: 最近一次待处理深链
    static let pendingKey = "bolloon_pending_deeplink"

    private var installed = false
    private var lastDelivered = ""
    /// 最近一次待投递的原始深链 (重试时反复注入同一条)
    private var pendingRaw: String?
    /// 延迟注入任务 (冷启动时页面还没加载完 → evaluateJavaScript 会被导航冲掉, 需要重试)
    private var retryTasks: [Task<Void, Never>] = []

    private init() {}

    /// 安装: 注册 didBecomeActive 观察者 (读 lastURL) + 立即取一次。幂等。
    /// AppDelegate 在 didFinishLaunching 里就调用, 冷启动 URL 也能进得来。
    func install() {
        guard !installed else { return }
        installed = true
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            Task { @MainActor in
                self.drainLastURL()
                // 冷启动注入会被页面导航冲掉 → 每次变 active 再补投一遍 pending
                if let raw = self.pendingRaw { self.scheduleRetries(raw) }
            }
        }
        drainLastURL()
    }

    /// 冷启动入口: `xcrun simctl openurl` / 系统点击 scheme 拉起**未运行**的 App 时,
    /// 系统把 URL 放在 `launchOptions[.url]`, **不会**走 application(_:open:) ——
    /// 所以 Capacitor 的 ApplicationDelegateProxy 不记录它。AppDelegate 显式转过来。
    func handleColdLaunch(url: URL) {
        receive(url.absoluteString)
    }

    /// 热启动入口: App 已在后台时 open url (AppDelegate 已转发给 Capacitor, 这里也收一份)。
    func handleIncomingURL(_ url: URL) {
        receive(url.absoluteString)
    }

    /// 统一入口: 落 pending + 排重试注入。冷启动 / 热启动 / AppIntent 都汇到这里。
    private func receive(_ raw: String) {
        install()
        guard BolloonDeepLink.parse(raw) != nil else { return }
        pendingRaw = raw
        UserDefaults.standard.set(raw, forKey: Self.pendingKey)
        lastDelivered = raw
        scheduleRetries(raw)
    }

    /// 投递一条深链: 落 pending + 注入 WebView + 顺手用 URL Scheme 打开自己 (把 App 拉到前台)。
    func deliver(url: URL, action: BolloonDeepLink.Action, name: String, goal: String?) async {
        install()
        receive(url.absoluteString)
        // 把 App 拉到前台 (openAppWhenRun 之外的双保险; 已经在前台时只是再触发一次 open url)
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    /// 按 0 / 0.5 / 2 / 5 / 8s 各注入一次。
    /// 冷启动时 WKWebView 还没建好 (0s 那次必然落空), 页面加载完前的注入又会被导航冲掉;
    /// mobile.js 的 'bolloon:deeplink' 监听器在 init (DOMContentLoaded) 时装好, 之后的重试就能打中。
    private func scheduleRetries(_ raw: String) {
        retryTasks.forEach { $0.cancel() }
        retryTasks.removeAll()
        for delay in [0.0, 0.5, 2.0, 5.0, 8.0] {
            let task = Task { @MainActor [weak self] in
                if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                if Task.isCancelled { return }
                guard let self = self else { return }
                guard self.pendingRaw == raw else { return }   // 已被更新的深链取代
                self.inject(raw)
            }
            retryTasks.append(task)
        }
    }

    /// 读 Capacitor 收到的最后一个 URL (热启动 open url 时由 AppDelegate 转发给 proxy)
    private func drainLastURL() {
        guard let url = ApplicationDelegateProxy.shared.lastURL else { return }
        let raw = url.absoluteString
        guard raw.lowercased().hasPrefix(BolloonDeepLink.scheme + "://") else { return }
        guard BolloonDeepLink.parse(raw) != nil else { return }
        guard raw != lastDelivered else { return }
        receive(raw)
    }

    /// 往当前 WKWebView 注入 pending 标记并派发事件 (页面还没加载完也没关系: mobile.js init 会读 window 上的标记)
    private func inject(_ raw: String) {
        guard let webView = Self.currentWebView() else { return }
        let lit = Self.jsStringLiteral(raw)
        let js = "window.__bolloonPendingDeepLink = \(lit);"
            + "try{var _e=new CustomEvent('bolloon:deeplink',{detail:window.__bolloonPendingDeepLink});"
            + "window.dispatchEvent(_e);document.dispatchEvent(_e);}catch(e){}"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// 在窗口层级里找 WKWebView (Capacitor 的 CAPBridgeViewController 用 WKWebView 渲染 public/index.html)
    private static func currentWebView() -> WKWebView? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                if let found = findWebView(in: window) { return found }
            }
        }
        return nil
    }

    private static func findWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        for sub in view.subviews {
            if let found = findWebView(in: sub) { return found }
        }
        return nil
    }

    /// 把任意字符串变成安全的 JS 字符串字面量 (JSON 编码即可)
    private static func jsStringLiteral(_ s: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
           let json = String(data: data, encoding: .utf8) {
            // json 形如 ["..."] → 去掉外层方括号
            return String(json.dropFirst().dropLast())
        }
        return "\"\""
    }
}

// MARK: - Known gaps (诚实记录)
//
// 1. [已修 2026-09-11] 纯 URL Scheme 冷启动拉起: AppDelegate.didFinishLaunchingWithOptions 现在
//    读 launchOptions[.url] → BolloonURLInbox.handleColdLaunch(url:) → 重试注入 WebView。
//    热启动 (App 在后台被 open url) 走 AppDelegate.application(_:open:options:) → handleIncomingURL +
//    Capacitor proxy, didBecomeActive 时 drainLastURL 收口。
// 2. 更彻底的方案是装 @capacitor/app (package.json 加依赖 + npx cap sync ios), 然后用
//    App.addListener('appUrlOpen') —— mobile.js 里已经写好这段代码, 装了自动生效, 不用再改代码。
// 3. AgentQuery 的候选来自静态回退列表 (或 App 沙盒里的 bolloon-agents.json, 当前没人写) ——
//    Swift 读不到 WebView 的 IndexedDB, 所以 Siri 里**列不出手机上真实存在的全部智能体**;
//    用户在 Siri 里说出的名字仍然会被 deep link 带过去, 由 WebView 侧按名字匹配。
// 4. AppShortcuts 短语能否在模拟器里被 Siri 识别无法验证 (模拟器 Siri 不索引 AppShortcuts);
//    构建时能验证的只是 AppIntents 元数据抽取 (ExtractAppIntentsMetadata) 没报错。

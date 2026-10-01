// Eli for macOS: one web face that lives in a window, a floating widget or the notch, one place at a time.
// Starts the local server if nothing answers, stops it on quit (only the one it started). Built by build.sh, no Xcode project.
import AppKit
import WebKit

let defaults = UserDefaults.standard
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Eli/server.log")
let french = Locale.preferredLanguages.first?.hasPrefix("fr") == true
func L(_ fr: String, _ en: String) -> String { french ? fr : en }

enum Placement: String { case window, widget, notch }

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation,
                         WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    lazy var web = makeWebView()  // the only one: moved between places, never reloaded, so speech and music go on
    var window: NSWindow?
    var widget: WidgetPanel?
    var notch: NotchPanel?
    var placement = Placement.window
    var song: (loaded: Bool, singing: Bool, title: String?)?  // reported by the page, nil until it does
    var server: Process?  // the server we started, if any

    var origin: URL { URL(string: "http://127.0.0.1:\(defaults.integer(forKey: "port"))/")! }
    var page: URL { URL(string: "?app=mac", relativeTo: origin)!.absoluteURL }

    /// Where Eli goes when the window closes: the last widget/notch used, else the notch if this Mac has one.
    var ambient: Placement {
        defaults.string(forKey: "ambient").flatMap(Placement.init)
            ?? (NSScreen.screens.contains { $0.safeAreaInsets.top > 0 } ? .notch : .widget)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        defaults.register(defaults: ["port": 5280, "widget.allSpaces": true])
        NSWindow.allowsAutomaticWindowTabbing = false  // no tab items in the View menu
        NSApp.mainMenu = mainMenu()
        place(defaults.string(forKey: "placement").flatMap(Placement.init) ?? .window)
        start()
    }

    func applicationWillTerminate(_ notification: Notification) { stopServer() }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        place(.window)
        return false
    }

    // MARK: placement

    func place(_ next: Placement) {
        placement = next
        defaults.set(next.rawValue, forKey: "placement")
        switch next {
        case .window:
            let window = self.window ?? makeWindow()
            self.window = window
            window.contentView?.embed(web)
            window.makeKeyAndOrderFront(nil)
            window.makeFirstResponder(web)
            NSApp.activate(ignoringOtherApps: true)
        case .widget:
            widget = widget ?? WidgetPanel(webView: web, allSpaces: defaults.bool(forKey: "widget.allSpaces"),
                                           menu: contextMenu()) { [weak self] in self?.place(.window) }
        case .notch:
            notch = notch ?? NotchPanel(webView: web, menu: contextMenu())
        }
        // The web view has moved in: now the other places can go.
        if next != .window { defaults.set(next.rawValue, forKey: "ambient"); window?.close() }
        if next != .widget { widget?.orderOut(nil); widget = nil }
        if next != .notch { notch?.dismiss(); notch = nil }
        relayout()
    }

    func relayout() {
        if placement == .notch { notch?.layout() } else { web.host("layout", placement.rawValue, [String: Any]()) }
    }

    func makeWindow() -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "Eli"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentMinSize = NSSize(width: 480, height: 360)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("Eli")  // remembers size and position
        return window
    }

    // Closing the window does not quit: Eli moves to the widget or the notch. ⌘Q quits.
    func windowWillClose(_ notification: Notification) {
        guard placement == .window else { return }  // closed by place(_:)
        DispatchQueue.main.async { [self] in place(ambient) }  // let AppKit finish closing first
    }

    // MARK: server

    func start() {
        Task {
            if await alive() { return load() }
            guard let repo = repoURL() else {
                return show(L("Aucun dossier Eli choisi.<br>Développeur › Choisir le dossier Eli…",
                              "No Eli folder chosen.<br>Developer › Choose Eli Folder…"))
            }
            do { try launchServer(in: repo) } catch {
                return show(L("Impossible de lancer le serveur : ", "Could not start the server: ") + error.localizedDescription)
            }
            show(L("Eli se réveille…", "Waking Eli up…"))
            for _ in 0..<600 {  // up to 5 min: the first run downloads ~125 MB of models
                if await alive() { return load() }
                if server?.isRunning == false {
                    return show(L("Le serveur s’est arrêté.<br>Développeur › Journal du serveur",
                                  "The server stopped.<br>Developer › Server Log"))
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            show(L("Le serveur ne répond pas sur ", "The server does not answer on ") + origin.absoluteString)
        }
    }

    func load() { web.load(URLRequest(url: page)) }

    func alive() async -> Bool {
        let request = URLRequest(url: origin.appendingPathComponent("api/status"), timeoutInterval: 1)
        let response = try? await URLSession.shared.data(for: request).1
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    func launchServer(in repo: URL) throws {
        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [repo.appendingPathComponent("run.sh").path, "--no-open"]
        process.currentDirectoryURL = repo
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()  // apps launched from Finder get a bare PATH: find uv and ffmpeg
        env["PATH"] = "\(home)/.local/bin:\(home)/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        env["PORT"] = String(defaults.integer(forKey: "port"))
        env["PYTHONUNBUFFERED"] = "1"
        process.environment = env
        process.standardOutput = log
        process.standardError = log
        try process.run()
        server = process
    }

    func stopServer() {
        guard let process = server, process.isRunning else { return }
        process.terminate()  // SIGTERM to `uv run`, which forwards it to python
        for _ in 0..<30 where process.isRunning { usleep(100_000) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        server = nil
    }

    // MARK: repo folder

    func isRepo(_ dir: URL) -> Bool {
        ["run.sh", "server/app.py"].allSatisfy { FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path) }
    }

    func repoURL() -> URL? {
        if let path = defaults.string(forKey: "repoPath"), isRepo(URL(fileURLWithPath: path)) { return URL(fileURLWithPath: path) }
        var dir = Bundle.main.bundleURL  // built in place (eli/apps/macos/build/Eli.app): the repo is a parent
        while dir.pathComponents.count > 1 {
            dir.deleteLastPathComponent()
            if isRepo(dir) { defaults.set(dir.path, forKey: "repoPath"); return dir }
        }
        return chooseRepo()
    }

    func chooseRepo() -> URL? {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = L("Choisissez le dossier eli (celui qui contient run.sh)", "Choose the eli folder (the one with run.sh)")
        guard panel.runModal() == .OK, let dir = panel.url else { return nil }
        guard isRepo(dir) else { show("\(dir.lastPathComponent): run.sh / server/app.py ?"); return nil }
        defaults.set(dir.path, forKey: "repoPath")
        return dir
    }

    // MARK: web view

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []  // Eli talks without waiting for a click
        config.preferences.setValue(defaults.bool(forKey: "dev"), forKey: "developerExtrasEnabled")  // right-click › Inspect
        config.userContentController.add(WeakHandler(self), name: "eli")
        let web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")  // no white flash before the page paints
        if #available(macOS 13.3, *) { web.isInspectable = true }
        return web
    }

    func show(_ message: String) {
        web.loadHTMLString("""
            <body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#999;
            font:15px -apple-system;text-align:center">\(message)</body>
            """, baseURL: nil)
    }

    func isLocal(_ host: String?) -> Bool { host == "127.0.0.1" || host == "localhost" }

    // Page → app: {type:'open', panel}, {type:'hold', on}, {type:'state', loaded, singing, title}, {type:'copy', text}.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard isLocal(message.frameInfo.securityOrigin.host), let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "open":
            place(.window)
            if let panel = body["panel"] as? String, ["settings", "faces"].contains(panel) { command(panel) }
        case "hold": notch?.hold = body["on"] as? Bool == true
        case "state": song = (body["loaded"] as? Bool ?? (body["singing"] as? Bool == true), body["singing"] as? Bool == true, body["title"] as? String)
        case "copy":  // navigator.clipboard refuses writes without a user gesture, as from a menu
            guard let text = body["text"] as? String else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        default: break
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { relayout() }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(isLocal(origin.host) && type == .microphone ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: L("Annuler", "Cancel"))
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    // Links leaving the local server open in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let link = action.request.url, link.scheme?.hasPrefix("http") == true, !isLocal(link.host) {
            NSWorkspace.shared.open(link)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let link = action.request.url { NSWorkspace.shared.open(link) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load() }
}

/// The user content controller retains its handlers: a weak hop so the web view does not keep its delegate alive.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

extension WKWebView {
    /// App → page: window.eliHost[fn](...args), if the page has the bridge.
    func host(_ fn: String, _ args: Any...) {
        guard let data = try? JSONSerialization.data(withJSONObject: args), let json = String(data: data, encoding: .utf8) else { return }
        evaluateJavaScript("window.eliHost && eliHost.\(fn)(...\(json))")
    }
}

extension NSView {
    /// Moves `view` in, under any overlay, filling the bounds.
    func embed(_ view: NSView) {
        guard view.superview !== self else { return }
        view.removeFromSuperview()
        view.frame = bounds
        view.autoresizingMask = [.width, .height]
        addSubview(view, positioned: .below, relativeTo: nil)
    }
}

/// Borderless floating panel for the widget and the notch: never steals activation, right-click shows `menu`.
class EliPanel: NSPanel {
    static let easeOut = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)  // no overshoot

    init(frame: NSRect, menu: NSMenu) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        self.menu = menu
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        isReleasedWhenClosed = false
        isExcludedFromWindowsMenu = true
    }

    override func sendEvent(_ event: NSEvent) {
        let secondary = event.type == .rightMouseDown || (event.type == .leftMouseDown && event.modifierFlags.contains(.control))
        if secondary, let menu, let view = contentView { return NSMenu.popUpContextMenu(menu, with: event, for: view) }
        super.sendEvent(event)
    }
}

MainActor.assumeIsolated {
    let delegate = AppDelegate()
    NSApplication.shared.delegate = delegate
    NSApplication.shared.run()
}

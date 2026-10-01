// Eli for macOS: the web face in a window, a desktop widget and/or the notch. Starts the local server if nothing
// answers, stops it on quit (only the one it started). Built by build.sh, no Xcode project.
import AppKit
import WebKit

let defaults = UserDefaults.standard
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Eli/server.log")

enum Mode {
    static let window = "mode.window", widget = "mode.widget", notch = "mode.notch"
    static let all = [window, widget, notch]
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow?
    var widget: WidgetPanel?
    var notch: NotchPanel?
    var statusItem: NSStatusItem!
    var server: Process?  // the server we started, if any
    var ready = false  // the server answers

    var url: URL { URL(string: "http://127.0.0.1:\(defaults.integer(forKey: "port"))/")! }
    var mainWeb: WKWebView? { window?.contentView as? WKWebView }
    /// Open faces in speaking order: the first one talks, the others are muted mirrors.
    var faces: [WKWebView] { [mainWeb, widget?.webView, notch?.webView].compactMap { $0 } }

    func applicationDidFinishLaunching(_ notification: Notification) {
        defaults.register(defaults: ["port": 5280, Mode.window: true, "widget.allSpaces": true])
        NSApp.mainMenu = mainMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "face.smiling", accessibilityDescription: "Eli")
        statusItem.menu = statusMenu()
        applyModes()
        start()
    }

    func applicationWillTerminate(_ notification: Notification) { stopServer() }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if window == nil { setMode(Mode.window, true) }
        return true
    }

    // MARK: modes

    func setMode(_ key: String, _ on: Bool) {
        defaults.set(on, forKey: key)
        applyModes()
    }

    func applyModes() {
        if defaults.bool(forKey: Mode.window) {
            if window == nil { openWindow() }
        } else if let closing = window {
            window = nil
            closing.close()
        }
        if defaults.bool(forKey: Mode.widget) {
            if widget == nil {
                widget = WidgetPanel(webView: makeWebView(), allSpaces: defaults.bool(forKey: "widget.allSpaces")) { [weak self] in
                    self?.setMode(Mode.window, true)
                }
            }
        } else {
            widget?.orderOut(nil)
            widget = nil
        }
        if defaults.bool(forKey: Mode.notch) {
            if notch == nil { notch = NotchPanel(webView: makeWebView()) }
        } else {
            notch?.orderOut(nil)
            notch = nil
        }
        NSApp.setActivationPolicy(window == nil ? .accessory : .regular)  // no Dock icon for widget/notch only
        load()
    }

    func openWindow() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "Eli"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = makeWebView()
        window.center()
        window.setFrameAutosaveName("Eli")  // remembers size and position
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === window else { return }  // closed by applyModes
        DispatchQueue.main.async { [self] in  // let AppKit finish closing before the window goes away
            if Mode.all.filter(defaults.bool(forKey:)).count > 1 { setMode(Mode.window, false) } else { NSApp.terminate(nil) }
        }
    }

    // MARK: server

    func start() {
        Task {
            ready = false
            if await alive() { return becomeReady() }
            guard let repo = repoURL() else { return show("No Eli folder chosen.<br>Eli › Choose Eli Folder…") }
            do { try launchServer(in: repo) } catch { return show("Could not start the server: \(error.localizedDescription)") }
            show("Waking Eli up…")
            for _ in 0..<600 {  // up to 5 min: the first run downloads ~125 MB of models
                if await alive() { return becomeReady() }
                if server?.isRunning == false { return show("The server stopped.<br>Eli › Show Server Log") }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            show("The server does not answer on \(url.absoluteString)<br>Eli › Show Server Log")
        }
    }

    func becomeReady() {
        ready = true
        load(force: true)
    }

    func alive() async -> Bool {
        let request = URLRequest(url: url.appendingPathComponent("api/status"), timeoutInterval: 1)
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
        panel.message = "Choose the eli folder (the one with run.sh)"
        guard panel.runModal() == .OK, let dir = panel.url else { return nil }
        guard isRepo(dir) else { show("\(dir.path) has no run.sh and server/app.py."); return nil }
        defaults.set(dir.path, forKey: "repoPath")
        return dir
    }

    // MARK: web views

    func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []  // Eli talks without waiting for a click
        let web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")  // no white flash before the page paints
        if #available(macOS 13.3, *) { web.isInspectable = true }
        return web
    }

    /// Main window: the full page. Widget and notch: the bare face, muted mirror unless they are the first face.
    func target(for web: WKWebView) -> URL {
        if web === mainWeb { return url }
        return URL(string: faces.first === web ? "?bare=1" : "?bare=1&mirror=1", relativeTo: url)!.absoluteURL
    }

    func load(force: Bool = false) {
        guard ready else { return }
        for web in faces where force || web.url != target(for: web) { web.load(URLRequest(url: target(for: web))) }
    }

    func show(_ message: String) {
        mainWeb?.loadHTMLString("""
            <body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#999;
            font:15px -apple-system;text-align:center">\(message)</body>
            """, baseURL: nil)
    }

    func isLocal(_ host: String?) -> Bool { host == "127.0.0.1" || host == "localhost" }

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
        alert.addButton(withTitle: "Cancel")
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

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.load(URLRequest(url: target(for: webView))) }

    // MARK: menus

    @objc func reload() { start() }
    @objc func openInBrowser() { NSWorkspace.shared.open(url) }
    @objc func showLog() { NSWorkspace.shared.open(logURL) }
    @objc func chooseFolder() {
        guard chooseRepo() != nil else { return }
        stopServer()
        start()
    }

    @objc func toggleMode(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        let on = !defaults.bool(forKey: key)
        if !on && Mode.all.filter(defaults.bool(forKey:)).count == 1 { return NSSound.beep() }  // keep at least one face
        setMode(key, on)
    }

    @objc func toggleAllSpaces(_ sender: NSMenuItem) {
        let on = !defaults.bool(forKey: "widget.allSpaces")
        defaults.set(on, forKey: "widget.allSpaces")
        widget?.setAllSpaces(on)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if let key = item.representedObject as? String { item.state = defaults.bool(forKey: key) ? .on : .off }
        return true
    }

    func item(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command,
              state: String? = nil, mine: Bool = true) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = mods
        item.representedObject = state
        if mine { item.target = self }
        return item
    }

    func modeItems() -> [NSMenuItem] {
        [item("Window", #selector(toggleMode), state: Mode.window),
         item("Widget", #selector(toggleMode), state: Mode.widget),
         item("Notch", #selector(toggleMode), state: Mode.notch),
         item("Widget on All Spaces", #selector(toggleAllSpaces), state: "widget.allSpaces")]
    }

    func toolItems() -> [NSMenuItem] {
        [item("Reload", #selector(reload), "r"),
         item("Open in Browser", #selector(openInBrowser), "o", [.command, .shift]),
         item("Show Server Log", #selector(showLog), "l", [.command, .shift]),
         item("Choose Eli Folder…", #selector(chooseFolder))]
    }

    func statusMenu() -> NSMenu {
        let menu = NSMenu()
        (modeItems() + [.separator()] + toolItems() + [.separator(),
            item("Quit Eli", #selector(NSApplication.terminate(_:)), "q", mine: false)]).forEach(menu.addItem)
        return menu
    }

    func mainMenu() -> NSMenu {
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.submenu = NSMenu(title: title)
            items.forEach(item.submenu!.addItem)
            return item
        }
        let std = { (title: String, action: Selector, key: String, mods: NSEvent.ModifierFlags) in
            self.item(title, action, key, mods, mine: false)
        }
        let menu = NSMenu()
        menu.addItem(submenu("Eli", [
            std("About Eli", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", .command),
            .separator(),
            std("Hide Eli", #selector(NSApplication.hide(_:)), "h", .command),
            std("Quit Eli", #selector(NSApplication.terminate(_:)), "q", .command),
        ]))
        menu.addItem(submenu("Edit", [  // without it, ⌘C/⌘V do nothing in the text bar
            std("Undo", Selector(("undo:")), "z", .command),
            std("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            std("Cut", #selector(NSText.cut(_:)), "x", .command),
            std("Copy", #selector(NSText.copy(_:)), "c", .command),
            std("Paste", #selector(NSText.paste(_:)), "v", .command),
            std("Select All", #selector(NSText.selectAll(_:)), "a", .command),
        ]))
        menu.addItem(submenu("View", toolItems() + [.separator()] + modeItems() + [.separator(),
            std("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])]))
        menu.addItem(submenu("Window", [
            std("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m", .command),
            std("Close", #selector(NSWindow.performClose(_:)), "w", .command),
        ]))
        return menu
    }
}

MainActor.assumeIsolated {
    let delegate = AppDelegate()
    NSApplication.shared.delegate = delegate
    NSApplication.shared.run()
}

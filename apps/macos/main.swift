// Eli for macOS: one web face that lives in a window, a floating widget or the notch, one place at a time.
// Starts the local server if nothing answers, stops it on quit (only the one it started). Built by build.sh, no Xcode project.
import AppKit
import Sparkle
import WebKit

let defaults = UserDefaults.standard
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Eli/server.log")
/// What the bundled server writes (.env, memory, voices, cache): the app itself stays read-only and signed.
let dataURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Eli")
/// The release carries its own server (Python, ffmpeg, server/, web/) in Resources; a dev build runs the repo's.
let bundled: URL? = Bundle.main.resourceURL.flatMap {
    FileManager.default.fileExists(atPath: $0.appendingPathComponent("server/app.py").path) ? $0 : nil
}
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
    /// Sparkle, release builds only: a dev build (repo server) would be offered the published version as an "update".
    lazy var updater: SPUStandardUpdaterController? = bundled.map { _ in
        SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    }

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
        _ = updater  // checks once a day (Info.plist), asks before installing
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
        // The web view fills the window, title bar included, and swallows the clicks: a bar-high strip on top moves it.
        if let content = window.contentView {
            let grip = DragStrip(frame: NSRect(x: 0, y: content.bounds.height - 30, width: content.bounds.width, height: 30))
            grip.autoresizingMask = [.width, .minYMargin]
            content.addSubview(grip)
        }
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
            do {
                if let res = bundled {
                    try FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true)
                    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
                    try launchServer(res.appendingPathComponent("python/bin/python3"), [res.appendingPathComponent("server/app.py").path],
                                     in: dataURL, env: ["ELI_DATA": dataURL.path, "ELI_VERSION": version,
                                                        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
                                                        "PATH": res.appendingPathComponent("bin").path + ":/usr/bin:/bin"])
                } else {
                    guard let repo = repoURL() else {
                        return show(L("Aucun dossier Eli choisi.<br>Développeur › Choisir le dossier Eli…",
                                      "No Eli folder chosen.<br>Developer › Choose Eli Folder…"))
                    }
                    let home = NSHomeDirectory()  // apps launched from Finder get a bare PATH: find uv and ffmpeg
                    let path = "\(home)/.local/bin:\(home)/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:"
                        + (ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin")
                    try launchServer(URL(fileURLWithPath: "/bin/bash"), [repo.appendingPathComponent("run.sh").path, "--no-open"],
                                     in: repo, env: ["PATH": path])
                }
            } catch {
                return show(L("Impossible de lancer le serveur : ", "Could not start the server: ") + error.localizedDescription)
            }
            show()
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

    func launchServer(_ executable: URL, _ arguments: [String], in dir: URL, env extra: [String: String]) throws {
        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = dir
        var env = ProcessInfo.processInfo.environment.merging(extra) { $1 }
        env["PORT"] = String(defaults.integer(forKey: "port"))
        env["PYTHONUNBUFFERED"] = "1"
        // launched from Finder there is no LANG: the server would start in English (voice, first download) until the page says
        env["LANG"] = env["LANG"] ?? L("fr_FR.UTF-8", "en_US.UTF-8")
        process.environment = env
        process.standardOutput = log
        process.standardError = log
        try process.run()
        server = process
    }

    func stopServer() {
        guard let process = server, process.isRunning else { return }
        process.terminate()  // SIGTERM to python (or to `uv run`, which forwards it)
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

    // While the server starts: Eli asleep on his 128×64 OLED (the page's default "pixel" face, same size and place),
    // pixel Z's rising. Words only for a problem, in his pixel font. The page then takes over and he opens his eyes.
    func show(_ message: String = "") {
        web.loadHTMLString(#"""
            <!doctype html><meta charset="utf-8"><title>Eli</title>
            <style>\#(pixelFont)
            html,body{margin:0;height:100%;background:#000;overflow:hidden}
            body{display:grid;place-content:center;justify-items:center;gap:28px;padding:40px 16px 110px;box-sizing:border-box}
            canvas{display:block;image-rendering:pixelated}
            p{margin:0;max-width:34ch;text-align:center;font:22px/33px px,ui-monospace,monospace;color:#d6eadb}
            p:empty{display:none}
            @media (max-width:479px){body{padding:0;gap:12px}p{font-size:11px;line-height:16px}}
            </style>
            <canvas role="img" aria-label="\#(L("Eli se réveille", "Eli is waking up"))"></canvas><p>\#(message)</p>
            <script>
            const cv = document.querySelector('canvas'), ctx = cv.getContext('2d'), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
            const off = new OffscreenCanvas(128, 64), o = off.getContext('2d'), img = o.createImageData(128, 64), px = new Uint32Array(img.data.buffer);
            const Z = [[1,1,1,1,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]];  // a 5×5 z, the second one twice as big
            const box = (x, y, w, h, r) => { const qx = Math.abs(x) - w + r, qy = Math.abs(y) - h + r; return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r; };
            function lit(x, y, b) {  // themes.js pixLit, asleep: eyes shut and lowered, mouth at rest
              for (const ex of [0.6, 1.4]) if (box(x - ex, y - 0.41, 0.2 * b, 0.03, 0.018) <= 0) return true;
              return box(x - 1, y - 0.82, 0.075, 0.022, 0.015) <= 0;
            }
            function frame(t) {
              const b = still ? 1 : 1 + Math.sin(t / 1100) * 0.025;  // slow breathing
              px.fill(0xff000000);
              for (let j = 0; j < 64; j++) for (let i = 0; i < 128; i++) if (lit((i + 0.5) / 64, (j + 0.5) / 64, b)) px[j * 128 + i] = 0xff86ff46;
              for (const [k, s] of [[0, 1], [1, 2]]) {  // two Z's, each rising from beside his head and fading out
                const p = still ? 0.5 : ((t / 3200 + k * 0.5) % 1), x = 105 + k * 8, y = Math.round(18 - p * 12 - k * 6);
                if (Math.sin(p * Math.PI) < 0.25) continue;
                Z.forEach((row, r) => row.forEach((on, c) => { if (on) for (let a = 0; a < s; a++) for (let d = 0; d < s; d++) px[(y + r * s + d) * 128 + x + c * s + a] = 0xff86ff46; }));
              }
              o.putImageData(img, 0, 0);
              const small = innerWidth < 480, W = small ? innerWidth : Math.min(innerWidth - 80, (innerHeight - 250) * 2, 1400), r = devicePixelRatio;
              const w = Math.max(160, W), h = w / 2, s = Math.max(1, Math.floor(Math.min(w * r / 128, h * r / 64)));
              cv.style.width = w + 'px'; cv.style.height = h + 'px'; cv.width = w * r; cv.height = h * r;
              const X = (cv.width - 128 * s) >> 1, Y = (cv.height - 64 * s) >> 1;
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(off, X, Y, 128 * s, 64 * s);
              if (s >= 4) {  // the black gaps between physical pixels, as on the page
                ctx.fillStyle = 'rgba(0,0,0,.35)'; const lw = Math.max(1, Math.round(s * 0.12));
                for (let i = 0; i <= 128; i++) ctx.fillRect(X + i * s, Y, lw, 64 * s);
                for (let j = 0; j <= 64; j++) ctx.fillRect(X, Y + j * s, 128 * s, lw);
              }
              if (!still) requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
            if (still) addEventListener('resize', () => frame(0));
            </script>
            """#, baseURL: nil)
    }

    // Departure Mono (OFL), the page's pixel font, inlined: this page has no server to load it from yet.
    lazy var pixelFont: String = {
        let up = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()  // built in place: apps/macos/build
            .deletingLastPathComponent().deletingLastPathComponent()
        let dirs = [Bundle.main.resourceURL, defaults.string(forKey: "repoPath").map { URL(fileURLWithPath: $0) }, up]
        for dir in dirs.compactMap({ $0 }) {
            if let font = try? Data(contentsOf: dir.appendingPathComponent("web/fonts/DepartureMono-Regular.woff2")) {
                return "@font-face{font-family:px;src:url(data:font/woff2;base64,\(font.base64EncodedString()))}"
            }
        }
        return ""
    }()

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

/// The title bar's job over the web view: drag to move, double-click to zoom (as the system setting says).
private final class DragStrip: NSView {
    override func mouseDown(with event: NSEvent) {
        guard event.clickCount == 2 else { return window?.performDrag(with: event) ?? () }
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
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

import AVFoundation
import SwiftUI
import WebKit

@main
struct EliApp: App {
    @AppStorage("server") private var server = ""
    @State private var setup = false
    @State private var error: String?

    init() {  // speaker rather than earpiece once the mic is open; ignores the silent switch
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetoothA2DP])
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if !setup, let remote = parseServer(server) {
                    FaceView(host: remote.host, port: remote.port,
                             onFail: { error = $0; setup = true },
                             onSettings: { error = nil; setup = true })
                        .ignoresSafeArea()
                        .statusBarHidden()
                        .persistentSystemOverlays(.hidden)
                        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
                        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
                } else {
                    SetupView(server: $server, error: error) { error = nil; setup = false }
                }
            }
            .preferredColorScheme(.dark)
        }
    }
}

/// "100.64.0.1", "100.64.0.1:5280", "http://mac.tailnet.ts.net:5280/" → host and port (default 5280).
func parseServer(_ text: String) -> (host: String, port: UInt16)? {
    let text = text.trimmingCharacters(in: .whitespaces)
    guard let parts = URLComponents(string: text.contains("://") ? text : "http://" + text),
          parts.scheme == "http", let host = parts.host, !host.isEmpty,
          let port = UInt16(exactly: parts.port ?? 5280), port > 0 else { return nil }
    return (host, port)
}

struct SetupView: View {
    @Binding var server: String
    let error: String?
    let done: () -> Void
    @State private var text = ""

    var body: some View {
        VStack(spacing: 16) {
            Text("Eli").font(.largeTitle.bold())
            Text("Address of the computer running Eli, e.g. its Tailscale IP. Its HOST setting must be reachable from this iPhone.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            TextField("100.64.0.1:5280", text: $text)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .onSubmit(connect)
            if let error { Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center) }
            Button("Connect", action: connect)
                .buttonStyle(.borderedProminent)
                .disabled(parseServer(text) == nil)
            Text("Later: long-press with two fingers on Eli to come back here.").font(.footnote).foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(maxWidth: 440)
        .onAppear { text = server }
    }

    func connect() {
        guard parseServer(text) != nil else { return }
        server = text.trimmingCharacters(in: .whitespaces)
        done()
    }
}

struct FaceView: UIViewRepresentable {
    let host: String
    let port: UInt16
    let onFail: (String) -> Void
    let onSettings: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []  // Eli talks without waiting for a tap
        config.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isInspectable = true
        web.uiDelegate = context.coordinator
        web.navigationDelegate = context.coordinator
        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.longPress))
        press.numberOfTouchesRequired = 2
        press.delegate = context.coordinator
        web.addGestureRecognizer(press)
        context.coordinator.web = web
        context.coordinator.startRelay()
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate, UIGestureRecognizerDelegate {
        let face: FaceView
        weak var web: WKWebView?
        private var relay: Relay?
        private var relayWasReady = false
        private var local: URL { URL(string: "http://127.0.0.1:\(face.port)/")! }

        init(_ face: FaceView) { self.face = face }

        func startRelay() {
            relayWasReady = false
            do {
                relay = try Relay(host: face.host, port: face.port) { [weak self] state in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        relayWasReady = true
                        web?.load(URLRequest(url: local))
                    case .failed(let error):  // after a long time in the background: start again, once
                        if relayWasReady { startRelay() } else { face.onFail("Local relay: \(error.localizedDescription)") }
                    default: break
                    }
                }
            } catch {
                face.onFail("Local relay: \(error.localizedDescription)")
            }
        }

        @objc func longPress(_ press: UILongPressGestureRecognizer) {
            if press.state == .began { face.onSettings() }
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == "127.0.0.1" && type == .microphone ? .grant : .deny)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let root = webView.window?.rootViewController else { return completionHandler(false) }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .destructive) { _ in completionHandler(true) })
            root.present(alert, animated: true)
        }

        // Links leaving Eli open in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let link = action.request.url, link.scheme?.hasPrefix("http") == true, link.host != "127.0.0.1" {
                UIApplication.shared.open(link)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let error = error as NSError
            guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
            face.onFail("Can't reach \(face.host):\(face.port). \(error.localizedDescription)")
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.load(URLRequest(url: local)) }
    }
}

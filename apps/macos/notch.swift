// Notch: Eli sits in a black pill around the MacBook notch, its face in the left ear, and drops down into a bigger
// panel when the pointer rests there. Screens without a notch get a fake 200 pt one at the top center.
import AppKit
import WebKit

@MainActor
final class NotchPanel: EliPanel {
    var hold = false  // the page is busy (typing): stay open until a click outside or Esc
    private let webView: WKWebView
    private let box = NSView()
    private var expanded = false
    private var armed = true  // after a forced collapse, the pointer must leave before the pill opens again
    private var since: TimeInterval?  // since when the pointer asks for the other state
    private var shape: (compact: NSRect, open: NSRect, notch: CGFloat, ear: CGFloat, h: CGFloat)?
    private var timer: Timer?
    private var clicks: Any?

    init(webView: WKWebView, menu: NSMenu) {
        self.webView = webView
        super.init(frame: .zero, menu: menu)
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)  // above the menu bar
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        hasShadow = false
        isMovable = false
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.black.cgColor
        box.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]  // bottom corners: the top is flush with the bezel
        box.layer?.masksToBounds = true
        contentView = box
        box.embed(webView)
        screensChanged()
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        // Polling with hysteresis: a tracking area riding an animated frame fired enter/exit in a loop.
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
        clicks = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in
            MainActor.assumeIsolated { self?.collapse() }
        }
        orderFrontRegardless()
    }

    override var canBecomeKey: Bool { true }  // the page's text field takes typing, the app stays in the background

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }  // may cover the menu bar

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown && event.keyCode == 53 { collapse() }  // Esc
        super.sendEvent(event)
    }

    func layout() {
        guard let shape else { return }
        if expanded {
            webView.host("layout", "notch-open", ["notch": shape.notch, "top": shape.h])
        } else {
            webView.host("layout", "notch", ["notch": shape.notch, "ear": shape.ear, "h": shape.h])
        }
    }

    func dismiss() {
        timer?.invalidate()
        clicks.map(NSEvent.removeMonitor)
        NotificationCenter.default.removeObserver(self)
        orderOut(nil)
    }

    /// The built-in screen and its notch, or a fake one; the pill and the open panel hang from the top around it.
    @objc private func screensChanged() {
        guard let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.screens.first else { return }
        let frame = screen.frame
        var notch = NSRect(x: frame.midX - 100, y: 0, width: 200, height: NSStatusBar.system.thickness)
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            notch = NSRect(x: frame.minX + left.width, y: 0, width: frame.width - left.width - right.width, height: screen.safeAreaInsets.top)
        }
        let h = notch.height, ear = 2 * (h - 8) + 20  // a 2:1 face of height h - 8 fits in the left ear
        func hanging(_ width: CGFloat, _ height: CGFloat) -> NSRect {
            NSRect(x: notch.midX - width / 2, y: frame.maxY - height, width: width, height: height)
        }
        shape = (hanging(notch.width + 2 * ear, h), hanging(max(560, notch.width + 2 * ear), h + 168), notch.width, ear, h)
        place(animated: false)
    }

    private func place(animated: Bool) {
        guard let shape else { return }
        let target = expanded ? shape.open : shape.compact
        box.layer?.cornerRadius = expanded ? 26 : shape.h / 2
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.28
                context.timingFunction = EliPanel.easeOut
                animator().setFrame(target, display: true)
            }
        } else {
            setFrame(target, display: true)
        }
        layout()
    }

    /// Open after a 120 ms dwell on the pill, close after 400 ms away from the open panel, never while held.
    private func track() {
        guard let shape else { return }
        let mouse = NSEvent.mouseLocation
        let inside = expanded
            ? shape.open.insetBy(dx: -14, dy: -14).contains(mouse)
            : shape.compact.insetBy(dx: -6, dy: -6).contains(mouse)
        if !inside && !expanded { armed = true }
        guard expanded ? !inside && !hold : inside && armed else { since = nil; return }
        let now = ProcessInfo.processInfo.systemUptime, start = since ?? now
        since = start
        if now - start >= (expanded ? 0.4 : 0.12) { set(expanded: !expanded) }
    }

    /// Click outside or Esc: close even while held.
    private func collapse() {
        guard expanded else { return }
        hold = false
        armed = false
        set(expanded: false)
    }

    private func set(expanded: Bool) {
        self.expanded = expanded
        since = nil
        place(animated: true)
    }
}

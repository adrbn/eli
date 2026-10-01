// Notch mode: Eli lives in a black pill around the MacBook notch and drops down into a bigger face on hover.
import AppKit
import WebKit

@MainActor
final class NotchPanel: NSPanel {
    let webView: WKWebView
    private let box = NSView()
    private var expanded = false

    init(webView: WKWebView) {
        self.webView = webView
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)  // above the menu bar
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isMovable = false

        let root = HoverView()
        root.onHover = { [weak self] in self?.expanded = $0; self?.place(animated: true) }
        contentView = root
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.black.cgColor
        box.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]  // bottom corners: the top is flush with the bezel
        box.layer?.masksToBounds = true
        box.autoresizingMask = [.width, .height]
        root.addSubview(box)
        box.addSubview(webView)
        place(animated: false)
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        orderFrontRegardless()
    }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }  // may cover the menu bar

    @objc private func screensChanged() { place(animated: false) }

    /// The built-in screen and its notch, or a fake notch at the top center of a screen without one.
    private func notch() -> (screen: NSRect, notch: NSRect)? {
        guard let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.screens.first else { return nil }
        let frame = screen.frame
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            let height = screen.safeAreaInsets.top
            return (frame, NSRect(x: frame.minX + left.width, y: frame.maxY - height,
                                  width: frame.width - left.width - right.width, height: height))
        }
        let height = NSStatusBar.system.thickness
        return (frame, NSRect(x: frame.midX - 90, y: frame.maxY - height, width: 180, height: height))
    }

    private func place(animated: Bool) {
        guard let (screen, notch) = notch() else { return }
        let ear = notch.height  // the pill sticks out by one square on each side; the left one shows the face
        let size = expanded
            ? NSSize(width: max(360, notch.width + 2 * ear), height: notch.height + 170)
            : NSSize(width: notch.width + 2 * ear, height: notch.height)
        let frame = NSRect(x: notch.midX - size.width / 2, y: screen.maxY - size.height, width: size.width, height: size.height)
        let face = expanded
            ? NSRect(x: 16, y: 12, width: size.width - 32, height: size.height - notch.height - 16)
            : NSRect(x: 6, y: 4, width: ear - 8, height: ear - 8)
        box.layer?.cornerRadius = expanded ? 28 : ear / 2
        NSAnimationContext.runAnimationGroup { context in
            context.duration = animated ? 0.4 : 0
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 1.35, 0.5, 1)  // slight overshoot, spring-like
            animator().setFrame(frame, display: true)
            webView.animator().frame = face
        }
    }
}

private final class HoverView: NSView {
    var onHover: (Bool) -> Void = { _ in }

    override init(frame: NSRect) {
        super.init(frame: frame)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    required init?(coder: NSCoder) { nil }

    override func mouseEntered(with event: NSEvent) { onHover(true) }
    override func mouseExited(with event: NSEvent) { onHover(false) }
}

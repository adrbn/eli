// Widget mode: a floating picture-in-picture Eli. Drag it anywhere, it snaps to the nearest edge or corner;
// resize with the bottom-right corner or a pinch; double-click opens the main window.
import AppKit
import WebKit

@MainActor
final class WidgetPanel: NSPanel {
    static let margin: CGFloat = 16, pull: CGFloat = 80, minWidth: CGFloat = 160, maxWidth: CGFloat = 640
    let webView: WKWebView

    init(webView: WKWebView, allSpaces: Bool, onDoubleClick: @escaping () -> Void) {
        self.webView = webView
        super.init(contentRect: Self.savedFrame(), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .floating
        setAllSpaces(allSpaces)
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true

        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.black.cgColor
        root.layer?.cornerRadius = 20
        root.layer?.masksToBounds = true
        contentView = root
        let handle = DragView(frame: root.bounds)  // above the page: the bare face has no UI to click
        handle.onDoubleClick = onDoubleClick
        for view in [webView, handle] {
            view.frame = root.bounds
            view.autoresizingMask = [.width, .height]
            root.addSubview(view)
        }
        orderFrontRegardless()
    }

    func setAllSpaces(_ on: Bool) {
        collectionBehavior = on ? [.canJoinAllSpaces, .fullScreenAuxiliary] : [.fullScreenAuxiliary]
    }

    /// Size for a given width: the faces are 2:1.
    func resize(width: CGFloat, keepingTopLeft: Bool) {
        let width = min(Self.maxWidth, max(Self.minWidth, width))
        let size = NSSize(width: width, height: width / 2)
        let origin = keepingTopLeft
            ? NSPoint(x: frame.minX, y: frame.maxY - size.height)
            : NSPoint(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2)
        setFrame(NSRect(origin: origin, size: size), display: true)
        invalidateShadow()
    }

    /// After a drag or resize: snap to an edge or corner if close to it, then remember the frame for this screen.
    func settle() {
        guard let screen = screen ?? NSScreen.main else { return }
        let area = screen.visibleFrame, m = Self.margin, pull = Self.pull
        var target = frame
        if target.minX - area.minX < pull { target.origin.x = area.minX + m }
        else if area.maxX - target.maxX < pull { target.origin.x = area.maxX - m - target.width }
        if target.minY - area.minY < pull { target.origin.y = area.minY + m }
        else if area.maxY - target.maxY < pull { target.origin.y = area.maxY - m - target.height }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.35
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 1.3, 0.5, 1)  // slight overshoot
            animator().setFrame(target, display: true)
        }
        defaults.set(NSStringFromRect(target), forKey: "widget.frame.\(screen.localizedName)")
        defaults.set(screen.localizedName, forKey: "widget.screen")
    }

    /// The frame last used on the last screen, or a 280×140 face in the bottom-right corner.
    static func savedFrame() -> NSRect {
        let screens = NSScreen.screens
        let screen = screens.first { $0.localizedName == defaults.string(forKey: "widget.screen") } ?? NSScreen.main ?? screens[0]
        let area = screen.visibleFrame
        if let saved = defaults.string(forKey: "widget.frame.\(screen.localizedName)"),
           case let frame = NSRectFromString(saved), area.intersects(frame) { return frame }
        return NSRect(x: area.maxX - margin - 280, y: area.minY + margin, width: 280, height: 140)
    }
}

private final class DragView: NSView {
    var onDoubleClick: () -> Void = {}
    private var start: (mouse: NSPoint, frame: NSRect)?
    private var resizing = false
    private var moved = false
    private let grip: CGFloat = 22

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        let point = convert(event.locationInWindow, from: nil)
        start = (NSEvent.mouseLocation, window.frame)
        resizing = point.x > bounds.maxX - grip && point.y < grip
        moved = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let panel = window as? WidgetPanel, let start else { return }
        let mouse = NSEvent.mouseLocation
        moved = true
        if resizing {
            panel.resize(width: start.frame.width + mouse.x - start.mouse.x, keepingTopLeft: true)
        } else {
            panel.setFrameOrigin(NSPoint(x: start.frame.minX + mouse.x - start.mouse.x, y: start.frame.minY + mouse.y - start.mouse.y))
        }
    }

    override func mouseUp(with event: NSEvent) {
        if event.clickCount == 2 { onDoubleClick() } else if moved { (window as? WidgetPanel)?.settle() }
        start = nil
    }

    override func magnify(with event: NSEvent) {
        guard let panel = window as? WidgetPanel else { return }
        panel.resize(width: panel.frame.width * (1 + event.magnification), keepingTopLeft: false)
        if event.phase == .ended { panel.settle() }
    }

    override func draw(_ dirtyRect: NSRect) {  // two short diagonal lines: the resize grip
        NSColor(white: 1, alpha: 0.25).setStroke()
        let path = NSBezierPath()
        for inset: CGFloat in [6, 11] {
            path.move(to: NSPoint(x: bounds.maxX - inset, y: 5))
            path.line(to: NSPoint(x: bounds.maxX - 5, y: inset))
        }
        path.lineWidth = 1.5
        path.lineCapStyle = .round
        path.stroke()
    }
}

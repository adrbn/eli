// Draws the app icon into an .iconset: a macOS squircle with Eli's phosphor face. Run by build.sh when AppIcon.icns
// is missing: swiftc icon.swift -o icon && ./icon AppIcon.iconset && iconutil -c icns AppIcon.iconset
import CoreGraphics
import Foundation
import ImageIO

func srgb(_ hex: Int, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: alpha)
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!
let green = 0x46ff86

func gradient(_ colors: [CGColor]) -> CGGradient { CGGradient(colorsSpace: space, colors: colors as CFArray, locations: nil)! }

/// Rounded rect with continuous corners (Apple's squircle): one corner as Bézier segments in radii, along the edge we
/// arrive by and the edge we leave by, then turned to each corner.
func squircle(_ rect: CGRect, radius r: CGFloat) -> CGPath {
    let start: CGFloat = 1.52866483
    let segments: [[CGFloat]] = [
        [1.08849323, 0, 0.86840689, 0, 0.66993427, 0.06549600],
        [0.63149399, 0.07491100],
        [0.37282392, 0.16905899, 0.16906013, 0.37282401, 0.07491176, 0.63149399],
        [0, 0.86840701, 0, 1.08849299, 0, start],
    ]
    let corners: [(CGPoint, back: CGVector, out: CGVector)] = [  // clockwise from the top edge
        (CGPoint(x: rect.maxX, y: rect.maxY), CGVector(dx: -1, dy: 0), CGVector(dx: 0, dy: -1)),
        (CGPoint(x: rect.maxX, y: rect.minY), CGVector(dx: 0, dy: 1), CGVector(dx: -1, dy: 0)),
        (CGPoint(x: rect.minX, y: rect.minY), CGVector(dx: 1, dy: 0), CGVector(dx: 0, dy: 1)),
        (CGPoint(x: rect.minX, y: rect.maxY), CGVector(dx: 0, dy: -1), CGVector(dx: 1, dy: 0)),
    ]
    let path = CGMutablePath()
    for (c, back, out) in corners {
        func p(_ a: CGFloat, _ b: CGFloat) -> CGPoint {
            CGPoint(x: c.x + (a * back.dx + b * out.dx) * r, y: c.y + (a * back.dy + b * out.dy) * r)
        }
        if path.isEmpty { path.move(to: p(start, 0)) } else { path.addLine(to: p(start, 0)) }
        for s in segments {
            if s.count == 2 { path.addLine(to: p(s[0], s[1])) } else { path.addCurve(to: p(s[4], s[5]), control1: p(s[0], s[1]), control2: p(s[2], s[3])) }
        }
    }
    path.closeSubpath()
    return path
}

/// Draws on a 1024 canvas scaled to `px`. Shadow offsets and blurs ignore the CTM, hence the `* s`.
func draw(_ ctx: CGContext, px: Int) {
    let s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)
    let rect = CGRect(x: 100, y: 100, width: 824, height: 824)  // Big Sur grid: 824 body, the margin holds the shadow
    let body = squircle(rect, radius: 185)
    func y(_ fromTop: CGFloat) -> CGFloat { rect.maxY - fromTop * rect.height }

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10 * s), blur: 28 * s, color: srgb(0, 0.45))
    ctx.addPath(body)
    ctx.setFillColor(srgb(0x050605))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(body)
    ctx.clip()
    ctx.drawLinearGradient(gradient([srgb(0x0d0f0d), srgb(0x050605)]), start: CGPoint(x: 512, y: rect.maxY),
                           end: CGPoint(x: 512, y: rect.minY), options: [])
    ctx.drawRadialGradient(gradient([srgb(green, 0.10), srgb(green, 0)]), startCenter: CGPoint(x: 512, y: y(0.5)), startRadius: 0,
                           endCenter: CGPoint(x: 512, y: y(0.5)), endRadius: 400, options: [])  // the screen glows faintly

    let face = CGMutablePath()
    let eye = CGSize(width: 0.17 * rect.width, height: 0.21 * rect.height)
    for cx in [512 - 0.155 * rect.width, 512 + 0.155 * rect.width] {
        face.addRoundedRect(in: CGRect(x: cx - eye.width / 2, y: y(0.42) - eye.height / 2, width: eye.width, height: eye.height),
                            cornerWidth: 38, cornerHeight: 38)
    }
    let mouth = CGSize(width: 0.2 * rect.width, height: 0.045 * rect.height)
    face.addRoundedRect(in: CGRect(x: 512 - mouth.width / 2, y: y(0.66) - mouth.height / 2, width: mouth.width, height: mouth.height),
                        cornerWidth: mouth.height / 2, cornerHeight: mouth.height / 2)
    for (blur, alpha) in [(70.0, 0.5), (18.0, 0.8)] as [(CGFloat, CGFloat)] {  // wide bloom, then a tight halo
        ctx.saveGState()
        ctx.setShadow(offset: .zero, blur: blur * s, color: srgb(green, alpha))
        ctx.addPath(face)
        ctx.setFillColor(srgb(green))
        ctx.fillPath()
        ctx.restoreGState()
    }
    if px >= 128 {  // pixel grid on the face, too fine to survive smaller sizes
        ctx.saveGState()
        ctx.addPath(face)
        ctx.clip()
        ctx.setFillColor(srgb(0x050605, 0.14))
        for v in stride(from: CGFloat(100), to: 924, by: 16) {
            ctx.fill(CGRect(x: v, y: 100, width: 3, height: 824))
            ctx.fill(CGRect(x: 100, y: v, width: 824, height: 3))
        }
        ctx.restoreGState()
    }

    // 1 px inner highlight: the stroke's inner half, brighter at the top.
    ctx.addPath(body)
    ctx.setLineWidth(2 / s)
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    ctx.drawLinearGradient(gradient([srgb(0xffffff, 0.16), srgb(0xffffff, 0.03)]), start: CGPoint(x: 512, y: rect.maxY),
                           end: CGPoint(x: 512, y: rect.minY), options: [])
    ctx.restoreGState()
}

let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "AppIcon.iconset")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let px = points * scale
        let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        draw(ctx, px: px)
        let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
        let dest = CGImageDestinationCreateWithURL(out.appendingPathComponent(name) as CFURL, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
        guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(name)") }
    }
}

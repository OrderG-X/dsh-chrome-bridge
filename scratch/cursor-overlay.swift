// DSH 常驻光标浮层 —— 点击穿透、不激活应用、永远置顶（Claude / ChatGPT 那种"小鼠标"）
//
// 用法：
//   dsh-cursor-overlay [--fifo /tmp/dsh-cursor.fifo] [--size 28] [--color '#FF7A18'] [--idle 60]
// 控制（往 FIFO 写一行）：
//   show <x> <y>     立即显示到屏幕坐标 (x,y)（Quartz 全局坐标，左上原点）
//   move <x> <y>     平滑移动到 (x,y)
//   click            闪一下按下态（带按压缩放）
//   hide             隐藏
//   lens <x> <y>     在 (x,y) 显示"工作中"旋转球（Codex 的 SkyLensView 同款素材，45 帧）
//   lenshide         收起旋转球
//   fog on|off       桌面变暗聚焦（Codex 的 FogBackgroundEffect 那层）
//   quit             退出
//
// 关键点：
//   * NSPanel + .nonactivatingPanel + orderFrontRegardless() → 绝不抢前台
//   * ignoresMouseEvents = true → 点击穿透，不挡你操作
//   * level = .screenSaver → 永远在所有窗口之上
//   * setActivationPolicy(.accessory) → 不占 Dock、不参与 Cmd-Tab

import AppKit
import Foundation

let args = CommandLine.arguments
func argValue(_ name: String, _ fallback: String) -> String {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return fallback
}

let fifoPath = argValue("--fifo", "/tmp/dsh-cursor.fifo")
let cursorSize = CGFloat(Double(argValue("--size", "30")) ?? 30)
/// 箭头是竖的：面板按图片真实宽高比，别拉成正方形
let cursorAspect: CGFloat = {
    for p in [NSString(string: "~/.dsh/share/dsh-cursor-solid.png").expandingTildeInPath] {
        if let img = NSImage(contentsOfFile: p), img.size.width > 0 { return img.size.height / img.size.width }
    }
    return 1.55
}()
// 空闲多久自己退出（秒）。不留常驻进程吃内存 —— 下次要用会被重新拉起。
let idleSeconds = Double(argValue("--idle", "60")) ?? 60
var lastActivity = Date()

func parseColor(_ hex: String) -> NSColor {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return NSColor(srgbRed: 0x4D/255.0, green: 0x6B/255.0, blue: 0xFE/255.0, alpha: 1.0) }
    return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255.0,
                   green: CGFloat((v >> 8) & 0xFF) / 255.0,
                   blue: CGFloat(v & 0xFF) / 255.0,
                   alpha: 1.0)
}
let cursorColor = parseColor(argValue("--color", "#4D6BFE"))

final class CursorView: NSView {
    var pressed = false
    // 光标图片：Codex 同款箭头形状，蓝色实心 + 白描边。
    // 用位图而不是手画路径 —— 形状是从 Codex 的 Computer Use 资源里描出来的。
    static let image: NSImage? = {
        for p in [NSString(string: "~/.dsh/share/dsh-cursor-solid.png").expandingTildeInPath,
                  "/tmp/cursor-blue.png"] {
            if let img = NSImage(contentsOfFile: p) { return img }
        }
        return nil
    }()

    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let b = bounds
        if let img = CursorView.image {
            // isFlipped 的视图会把 NSImage 上下翻过来，箭头会倒着指 —— 翻回去再画
            if let ctx = NSGraphicsContext.current?.cgContext {
                ctx.saveGState()
                ctx.translateBy(x: 0, y: b.height)
                ctx.scaleBy(x: 1, y: -1)
                img.draw(in: b, from: .zero, operation: .sourceOver, fraction: pressed ? 0.65 : 1.0)
                ctx.restoreGState()
            } else {
                img.draw(in: b, from: .zero, operation: .sourceOver, fraction: pressed ? 0.65 : 1.0)
            }
            return
        }
        // 兜底：图片没了就画个简单的箭头，别让光标整个消失
        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: b.width * 0.02, y: 0))
        arrow.line(to: NSPoint(x: b.width * 0.02, y: b.height * 0.74))
        arrow.line(to: NSPoint(x: b.width * 0.21, y: b.height * 0.56))
        arrow.line(to: NSPoint(x: b.width * 0.36, y: b.height * 0.99))
        arrow.line(to: NSPoint(x: b.width * 0.52, y: b.height * 0.91))
        arrow.line(to: NSPoint(x: b.width * 0.37, y: b.height * 0.49))
        arrow.line(to: NSPoint(x: b.width * 0.62, y: b.height * 0.47))
        arrow.close()
        cursorColor.setFill(); arrow.fill()
        NSColor(calibratedWhite: 1.0, alpha: 0.9).setStroke(); arrow.stroke()
    }
}

// ── "工作中"旋转球：素材直接取自 Codex 的 LensSequence（45 帧）──────
final class LensView: NSView {
    var frames: [NSImage] = []
    var idx = 0
    var timer: Timer?
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        guard !frames.isEmpty else { return }
        frames[idx % frames.count].draw(in: bounds)
    }
    func start() {
        guard timer == nil, !frames.isEmpty else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0/30.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.idx = (self.idx + 1) % self.frames.count
            self.needsDisplay = true
        }
        RunLoop.main.add(timer!, forMode: .common)
    }
    func stop() { timer?.invalidate(); timer = nil }
}

/// Codex 的 "scoot" 动画模型（参数名抄自 SkyComputerUseService 的符号表）：
///   scootPositionResponse / scootPositionDampingFraction  位置弹簧
///   scootDistanceThreshold                                移动多远才算"挪动"
///   scootStretchXAmount / scootStretchScale / scootStretchMin   沿运动方向拉伸
///   scootSquashYAmount / scootStretchPivotX               垂直压扁 + 支点
///   scootRotationMax / scootRotationResponse              朝运动方向侧倾
///   cursorBlurTransition                                  快速移动时糊一下
final class ScootAnimator {
    var pos = CGPoint.zero
    var vel = CGPoint.zero
    var target = CGPoint.zero
    var live = false

    let response = 0.34                     // 弹簧响应（秒）
    let damping = 0.82                      // 阻尼比，<1 会有一点点回弹
    let distanceThreshold: CGFloat = 5
    let stretchMax: CGFloat = 1.30
    let stretchMin: CGFloat = 0.78
    let squashY: CGFloat = 0.86
    let rotationMax: CGFloat = 0.15         // 弧度，约 8.6°

    var stretch: CGFloat = 1
    var tilt: CGFloat = 0
    var blur: CGFloat = 0

    func jump(to p: CGPoint) { pos = p; target = p; vel = .zero; live = true }
    func move(to p: CGPoint) {
        guard live else { jump(to: p); return }
        if hypot(p.x - pos.x, p.y - pos.y) < distanceThreshold { return }
        target = p
    }

    func step(_ dt: Double) {
        guard live else { return }
        let omega = 2 * Double.pi / response
        let k = omega * omega
        let c = 2 * damping * omega
        let ax = -k * Double(pos.x - target.x) - c * Double(vel.x)
        let ay = -k * Double(pos.y - target.y) - c * Double(vel.y)
        vel.x += CGFloat(ax * dt); vel.y += CGFloat(ay * dt)
        pos.x += vel.x * CGFloat(dt); pos.y += vel.y * CGFloat(dt)

        let speed = hypot(vel.x, vel.y)
        let amount = min(1.0, Double(speed) / 2600.0)
        stretch = 1 + (stretchMax - 1) * CGFloat(amount)
        tilt = CGFloat(sin(atan2(Double(vel.y), Double(vel.x)) + .pi / 2)) * rotationMax * CGFloat(amount)
        blur = min(1.0, Double(speed) / 3200.0)

        if speed < 3 && hypot(pos.x - target.x, pos.y - target.y) < 0.6 {
            pos = target; vel = .zero
            stretch = 1; tilt = 0; blur = 0
        }
    }
}

final class OverlayController: NSObject {
    let panel: NSPanel
    let view: CursorView
    var timer: Timer?
    let anim = ScootAnimator()
    var visible = false

    override init() {
        let rect = NSRect(x: 0, y: 0, width: cursorSize, height: cursorSize * cursorAspect)
        panel = NSPanel(contentRect: rect,
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered,
                        defer: false)
        view = CursorView(frame: rect)
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isMovable = false
        panel.contentView = view
        view.wantsLayer = true                 // 拉伸/模糊要靠 layer
        view.layer?.masksToBounds = false
        view.layer?.anchorPoint = CGPoint(x: 0, y: 0)
    }

    // Quartz 全局坐标（左上原点，y 向下）→ AppKit 屏幕坐标（左下原点）
    func screenPoint(_ x: Double, _ y: Double) -> NSPoint {
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        return NSPoint(x: CGFloat(x), y: screenH - CGFloat(y))
    }

    func show(x: Double, y: Double, animate: Bool) {
        let p = screenPoint(x, y)
        if !visible {
            anim.jump(to: p)
            panel.setFrameOrigin(p)
            panel.orderFrontRegardless()       // 显示但不激活本进程
            visible = true
            startTicking()
            return
        }
        if animate { anim.move(to: p) } else { anim.jump(to: p) }
    }

    /// 60fps 弹簧：位置 + 沿运动方向拉伸 + 侧倾 + 快移模糊
    func startTicking() {
        guard timer == nil else { return }
        var last = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            let now = Date(); let dt = min(0.05, now.timeIntervalSince(last)); last = now
            self.anim.step(dt)
            self.applyTransform()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func applyTransform() {
        panel.setFrameOrigin(anim.pos)
        guard let layer = view.layer else { return }
        // 支点在箭头尖（左上），所以绕支点缩放，看起来像"从尖端弹出去"
        let pivot = CGPoint(x: cursorSize * 0.05, y: cursorSize * 0.05)
        var t = CGAffineTransform.identity
        t = t.translatedBy(x: pivot.x, y: pivot.y)
        t = t.rotated(by: anim.tilt)
        t = t.scaledBy(x: anim.stretch, y: 1 / (anim.stretch * 1.0) * squashFactor())
        t = t.translatedBy(x: -pivot.x, y: -pivot.y)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        layer.setAffineTransform(t)
        layer.filters = anim.blur > 0.18 ? [blurFilter(anim.blur * 1.5)] : []
        CATransaction.commit()
    }

    func squashFactor() -> CGFloat { anim.stretch > 1.02 ? 1 / anim.squashY : 1 }

    func blurFilter(_ radius: CGFloat) -> CIFilter? {
        let f = CIFilter(name: "CIGaussianBlur")
        f?.setValue(radius, forKey: "inputRadius")
        return f
    }

    func press() {
        view.pressed = true
        view.needsDisplay = true
        anim.stretch = 0.80                    // 点击时压一下
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.11) {
            self.view.pressed = false
            self.view.needsDisplay = true
            self.anim.stretch = 1.0
        }
    }

    func hide() {
        timer?.invalidate(); timer = nil
        panel.orderOut(nil)
        visible = false
    }
}

final class FogView: NSView {
    var focus: NSPoint = .zero          // AppKit 坐标（左下原点）
    var radius: CGFloat = 200
    var dim: CGFloat = 0.5

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current else { return }
        ctx.compositingOperation = .sourceOver
        NSColor(calibratedWhite: 0, alpha: dim).setFill()
        bounds.fill()
        // 用 destinationOut + 径向渐变把中心"擦亮"
        ctx.compositingOperation = .destinationOut
        let grad = NSGradient(colors: [
            NSColor(calibratedWhite: 0, alpha: 1.0),
            NSColor(calibratedWhite: 0, alpha: 0.75),
            NSColor(calibratedWhite: 0, alpha: 0.0),
        ])
        grad?.draw(fromCenter: focus, radius: 0, toCenter: focus, radius: radius, options: [])
    }
}

final class EffectsController: NSObject {
    /// 特效自动收起的延时（秒）—— 操作停了就收干净，不糊在用户屏幕上
    let fxIdle: Double = 6
    var fxTimer: Timer?
    func keepAlive() {
        fxTimer?.invalidate()
        fxTimer = Timer.scheduledTimer(withTimeInterval: fxIdle, repeats: false) { [weak self] _ in
            self?.hideLens()
            self?.setFog(false)
        }
        RunLoop.main.add(fxTimer!, forMode: .common)
    }

    var lensPanel: NSPanel?
    var lensView: LensView?
    var fogPanel: NSPanel?
    var fogView: FogView?

    func loadFrames() -> [NSImage] {
        let dir = NSString(string: "~/.dsh/share/lens").expandingTildeInPath
        let fs = (try? FileManager.default.contentsOfDirectory(atPath: dir))?.filter { $0.hasSuffix(".png") }.sorted() ?? []
        return fs.compactMap { NSImage(contentsOfFile: dir + "/" + $0) }
    }

    func showLens(x: Double, y: Double) {
        if lensPanel == nil {
            let size: CGFloat = 40
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: size, height: size),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
            p.ignoresMouseEvents = true; p.hidesOnDeactivate = false
            p.level = .screenSaver
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
            let v = LensView(frame: NSRect(x: 0, y: 0, width: size, height: size))
            v.frames = loadFrames()
            p.contentView = v
            lensPanel = p; lensView = v
        }
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        let size = lensPanel!.frame.width
        // 球放在光标右下方一点，不挡住它
        lensPanel!.setFrameOrigin(NSPoint(x: CGFloat(x) + 6, y: screenH - CGFloat(y) - size + 4))
        lensPanel!.orderFrontRegardless()
        lensView?.start()
        keepAlive()
    }

    func hideLens() {
        lensView?.stop()
        lensPanel?.orderOut(nil)
    }

    func setFog(_ on: Bool) {
        if on {
            if fogPanel == nil {
                let f = NSScreen.screens.first?.frame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)
                let p = NSPanel(contentRect: f, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                p.isOpaque = false
                p.backgroundColor = .clear
                p.hasShadow = false; p.ignoresMouseEvents = true; p.hidesOnDeactivate = false
                p.level = .init(rawValue: NSWindow.Level.screenSaver.rawValue - 1)   // 在光标/球之下
                p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
                let v = FogView(frame: NSRect(origin: .zero, size: f.size))
                p.contentView = v
                fogPanel = p; fogView = v
            }
            fogPanel?.orderFrontRegardless()
            keepAlive()
        } else {
            fogPanel?.orderOut(nil)
        }
    }

    /// 把"亮斑"挪到光标处
    func fogFocus(x: Double, y: Double) {
        guard let v = fogView else { return }
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        v.focus = NSPoint(x: CGFloat(x), y: screenH - CGFloat(y))
        v.needsDisplay = true
    }
}

let controller = OverlayController()
let effects = EffectsController()

// ---- FIFO 命令通道 ----
try? FileManager.default.removeItem(atPath: fifoPath)
mkfifo(fifoPath, 0o600)

let fd = open(fifoPath, O_RDONLY | O_NONBLOCK)
if fd < 0 {
    FileHandle.standardError.write("dsh-cursor-overlay: 无法打开 FIFO \(fifoPath)\n".data(using: .utf8)!)
    exit(1)
}

func handle(_ line: String) {
    lastActivity = Date()
    let parts = line.split(separator: " ").map(String.init)
    guard let op = parts.first else { return }
    switch op {
    case "show" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) {
            controller.show(x: x, y: y, animate: false)
            effects.fogFocus(x: x, y: y)
        }
    case "move" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) { controller.show(x: x, y: y, animate: true) }
    case "click":
        controller.press()
    case "hide":
        controller.hide()
    case "ping":
        let a = controller.anim
        let line = String(format: "pong visible=%d pos=%.0f,%.0f target=%.0f,%.0f vel=%.0f stretch=%.3f tilt=%.3f blur=%.2f\n",
                          controller.visible ? 1 : 0,
                          a.pos.x, a.pos.y, a.target.x, a.target.y,
                          hypot(a.vel.x, a.vel.y), a.stretch, a.tilt, a.blur)
        FileHandle.standardError.write(line.data(using: .utf8)!)
    case "lens" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) { effects.showLens(x: x, y: y) }
    case "lenshide":
        effects.hideLens()
    case "fog":
        effects.setFog(parts.count >= 2 && parts[1] == "on")
    case "fogfocus" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) { effects.fogFocus(x: x, y: y) }
    case "quit":
        controller.hide(); effects.hideLens(); effects.setFog(false)
        exit(0)
    default:
        break
    }
}

// 用 DispatchSource 轮询 FIFO（无读者时写入端会阻塞，故保持 fd 常开）
let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
var buffer = Data()
src.setEventHandler {
    var chunk = [UInt8](repeating: 0, count: 4096)
    let n = read(fd, &chunk, chunk.count)
    if n > 0 {
        buffer.append(contentsOf: chunk[0..<n])
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let s = String(data: lineData, encoding: .utf8) {
                handle(s.trimmingCharacters(in: .whitespaces))
            }
        }
    }
}
src.resume()

// ---- 空闲自杀 ----
// 没有指令超过 idleSeconds 就退出并删掉 FIFO。用户不该为一次操作留一个常驻进程。
let idleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    if Date().timeIntervalSince(lastActivity) >= idleSeconds {
        controller.hide(); effects.hideLens(); effects.setFog(false)
        try? FileManager.default.removeItem(atPath: fifoPath)
        exit(0)
    }
}
RunLoop.main.add(idleTimer, forMode: .common)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // 不占 Dock、不进 Cmd-Tab、不抢前台
app.run()

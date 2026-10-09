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
            img.draw(in: b, from: .zero, operation: .sourceOver, fraction: pressed ? 0.65 : 1.0)
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

final class OverlayController: NSObject {
    let panel: NSPanel
    let view: CursorView
    var timer: Timer?
    var current: NSPoint = .zero
    var target: NSPoint = .zero
    var visible = false

    override init() {
        let rect = NSRect(x: 0, y: 0, width: cursorSize, height: cursorSize)
        panel = NSPanel(contentRect: rect,
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered,
                        defer: false)
        view = CursorView(frame: rect)
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true            // 点击穿透
        panel.hidesOnDeactivate = false
        panel.level = .screenSaver                 // 永远置顶
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isMovable = false
        panel.contentView = view
    }

    // Quartz 全局坐标（左上原点，y 向下）→ AppKit 屏幕坐标（左下原点）
    func screenPoint(_ x: Double, _ y: Double) -> NSPoint {
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        return NSPoint(x: CGFloat(x), y: screenH - CGFloat(y))
    }

    func place(_ p: NSPoint) {
        current = p
        panel.setFrameOrigin(p)
    }

    func show(x: Double, y: Double, animate: Bool) {
        let p = screenPoint(x, y)
        if !visible {
            place(p)
            panel.orderFrontRegardless()           // 显示但不激活本进程
            visible = true
            return
        }
        target = p
        guard animate else { place(p); return }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            let dx = self.target.x - self.current.x
            let dy = self.target.y - self.current.y
            let dist = sqrt(dx * dx + dy * dy)
            if dist < 1.5 {
                self.place(self.target)
                t.invalidate()
                return
            }
            let step = min(dist, max(4.0, dist * 0.28))
            self.place(NSPoint(x: self.current.x + dx / dist * step,
                               y: self.current.y + dy / dist * step))
        }
    }

    func press() {
        view.pressed = true
        view.needsDisplay = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            self.view.pressed = false
            self.view.needsDisplay = true
        }
    }

    func hide() {
        timer?.invalidate()
        panel.orderOut(nil)
        visible = false
    }
}

// ── 压暗层：整屏变暗，光标周围留一块亮的（Codex 的聚焦感）──────
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
        FileHandle.standardError.write("pong visible=\(controller.visible)\n".data(using: .utf8)!)
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

// DSH 常驻光标浮层 —— 点击穿透、不激活应用、永远置顶（Claude / ChatGPT 那种"小鼠标"）
//
// 用法：
//   dsh-cursor-overlay [--fifo /tmp/dsh-cursor.fifo] [--size 28] [--color '#FF7A18']
// 控制（往 FIFO 写一行）：
//   show <x> <y>     立即显示到屏幕坐标 (x,y)（Quartz 全局坐标，左上原点）
//   move <x> <y>     平滑移动到 (x,y)
//   click            闪一下按下态
//   hide             隐藏
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
let cursorSize = CGFloat(Double(argValue("--size", "28")) ?? 28)

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
    // AppKit 默认原点在左下角；路径按"左上角为原点"描述，这里翻转过来
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let b = bounds
        let w = b.width, h = b.height
        // 标准 macOS 箭头（y 向下）
        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: w * 0.02, y: h * 0.00))       // 箭尖
        arrow.line(to: NSPoint(x: w * 0.02, y: h * 0.74))       // 左边
        arrow.line(to: NSPoint(x: w * 0.21, y: h * 0.56))       // 凹口
        arrow.line(to: NSPoint(x: w * 0.36, y: h * 0.99))       // 尾尖
        arrow.line(to: NSPoint(x: w * 0.52, y: h * 0.91))       // 尾右
        arrow.line(to: NSPoint(x: w * 0.37, y: h * 0.49))       // 凹口右
        arrow.line(to: NSPoint(x: w * 0.62, y: h * 0.47))       // 右尖
        arrow.close()
        arrow.lineJoinStyle = .round
        arrow.lineWidth = max(1.4, w * 0.06)
        cursorColor.setFill()
        cursorColor.setStroke()
        arrow.fill()
        NSColor(calibratedWhite: 1.0, alpha: 0.9).setStroke()
        arrow.stroke()
        if pressed {
            NSColor(calibratedWhite: 1.0, alpha: 0.35).setFill()
            arrow.fill()
        }
    }
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

let controller = OverlayController()

// ---- FIFO 命令通道 ----
try? FileManager.default.removeItem(atPath: fifoPath)
mkfifo(fifoPath, 0o600)

let fd = open(fifoPath, O_RDONLY | O_NONBLOCK)
if fd < 0 {
    FileHandle.standardError.write("dsh-cursor-overlay: 无法打开 FIFO \(fifoPath)\n".data(using: .utf8)!)
    exit(1)
}

func handle(_ line: String) {
    let parts = line.split(separator: " ").map(String.init)
    guard let op = parts.first else { return }
    switch op {
    case "show" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) { controller.show(x: x, y: y, animate: false) }
    case "move" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) { controller.show(x: x, y: y, animate: true) }
    case "click":
        controller.press()
    case "hide":
        controller.hide()
    case "ping":
        FileHandle.standardError.write("pong visible=\(controller.visible)\n".data(using: .utf8)!)
    case "quit":
        controller.hide()
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

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // 不占 Dock、不进 Cmd-Tab、不抢前台
app.run()

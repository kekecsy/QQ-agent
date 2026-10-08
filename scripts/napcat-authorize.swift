import Cocoa

guard CommandLine.arguments.count == 2 else { exit(2) }
let source = CommandLine.arguments[1]
let target = "/Applications/QQ.app/Contents/Resources/app/package.json"
let loader = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Containers/com.tencent.qq/Data/Documents/loadNapCat.js").path
guard let data = FileManager.default.contents(atPath: source),
      let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let entry = config["main"] as? String,
      URL(fileURLWithPath: target).deletingLastPathComponent()
        .appendingPathComponent(entry).standardizedFileURL.path == loader else { exit(2) }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.activate(ignoringOtherApps: true)
let alert = NSAlert()
alert.messageText = "QQ Agent：启用 NapCat"
alert.informativeText = "需要管理员权限修改 QQ 的启动入口。请输入当前 Mac 账户的登录密码。密码仅用于本次本机授权，不会保存。"
alert.addButton(withTitle: "授权")
alert.addButton(withTitle: "取消")
let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
alert.accessoryView = field
alert.window.initialFirstResponder = field
guard alert.runModal() == .alertFirstButtonReturn else { exit(3) }

let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/sudo")
process.arguments = ["-S", "-p", "", "--", "/bin/cp", source, target]
let input = Pipe()
process.standardInput = input
do {
    try process.run()
    try input.fileHandleForWriting.write(contentsOf: Data((field.stringValue + "\n").utf8))
    field.stringValue = ""
    try input.fileHandleForWriting.close()
    process.waitUntilExit()
    exit(process.terminationStatus)
} catch {
    field.stringValue = ""
    fputs("Local authorization failed.\n", stderr)
    exit(1)
}

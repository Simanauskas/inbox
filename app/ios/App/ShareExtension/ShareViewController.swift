import UIKit
import Intents
import UniformTypeIdentifiers

// "Inbox" in the iPhone share sheet. Copies what's being shared (photos, videos, files,
// links, text) into the App Group, notes which chat it's for when you tapped a person in
// the share sheet's top row, and opens Inbox, which shows the chat with it ready to send.
class ShareViewController: UIViewController {
    private let group = "group.fit.simas.inbox"
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.text = "Opening Inbox…"
        label.textColor = .secondaryLabel
        label.textAlignment = .center
        label.numberOfLines = 0
        label.frame = view.bounds.insetBy(dx: 24, dy: 0)
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await self.collectAndOpen() }
    }

    private func collectAndOpen() async {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent("Shares", isDirectory: true) else { return finish("Inbox couldn't receive this.") }
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        var items: [[String: Any]] = []
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for (n, p) in providers.enumerated() {
            if let item = await save(p, index: n, into: root) { items.append(item) }
        }
        var manifest: [String: Any] = ["id": UUID().uuidString, "at": Date().timeIntervalSince1970 * 1000, "items": items]
        if let intent = extensionContext?.intent as? INSendMessageIntent, let conv = intent.conversationIdentifier {
            manifest["conversation"] = conv
        }
        if let data = try? JSONSerialization.data(withJSONObject: manifest) {
            try? data.write(to: root.appendingPathComponent("pending.json"))
        }
        if items.isEmpty { return finish("Nothing Inbox can send here.") }
        await MainActor.run {
            if self.openInbox(URL(string: "inboxshare://share")!) {
                self.extensionContext?.completeRequest(returningItems: nil)
            } else {
                self.label.text = "Saved. Open Inbox to send it."
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.extensionContext?.completeRequest(returningItems: nil) }
            }
        }
    }

    private func finish(_ text: String) {
        DispatchQueue.main.async {
            self.label.text = text
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.extensionContext?.completeRequest(returningItems: nil) }
        }
    }

    // One shared thing → a file in the App Group (or text/link in the manifest).
    private func save(_ p: NSItemProvider, index: Int, into dir: URL) async -> [String: Any]? {
        for type in [UTType.movie, UTType.image, UTType.pdf, UTType.data] where p.hasItemConformingToTypeIdentifier(type.identifier) {
            if type == .data && (p.hasItemConformingToTypeIdentifier(UTType.url.identifier) || p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)) { break }
            if let saved = await copyFile(p, type: type, index: index, into: dir) { return saved }
        }
        if p.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, !url.isFileURL {
            return ["kind": "text", "text": url.absoluteString]
        }
        if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
            return ["kind": "text", "text": text]
        }
        return nil
    }

    private func copyFile(_ p: NSItemProvider, type: UTType, index: Int, into dir: URL) async -> [String: Any]? {
        await withCheckedContinuation { cont in
            _ = p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url = url else { cont.resume(returning: nil); return }
                let ext = url.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "bin") : url.pathExtension
                let base = (p.suggestedName ?? url.deletingPathExtension().lastPathComponent).replacingOccurrences(of: "/", with: "-")
                let name = "\(index)-\(base).\(ext)"
                let dest = dir.appendingPathComponent(name)
                do {
                    try? FileManager.default.removeItem(at: dest)
                    try FileManager.default.copyItem(at: url, to: dest)
                    let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
                    cont.resume(returning: ["kind": "file", "file": name, "name": "\(base).\(ext)", "type": mime])
                } catch { cont.resume(returning: nil) }
            }
        }
    }

    // Extensions can't call UIApplication.open directly; find the app in the responder chain.
    private func openInbox(_ url: URL) -> Bool {
        let sel = NSSelectorFromString("openURL:options:completionHandler:")
        var r: UIResponder? = self
        while let x = r {
            if let app = x as? UIApplication, app.responds(to: sel) {
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let fn = unsafeBitCast(app.method(for: sel), to: Open.self)
                fn(app, sel, url as NSURL, NSDictionary(), nil)
                return true
            }
            r = x.next
        }
        return false
    }
}

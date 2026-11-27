import Foundation
import Capacitor
import Intents
import UIKit

// Shared with the Share extension (same App Group).
let inboxAppGroup = "group.fit.simas.inbox"

@objc(InboxSharePlugin)
public class InboxSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "InboxSharePlugin"
    public let jsName = "InboxShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPendingShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "donate", returnType: CAPPluginReturnPromise),
    ]

    private var sharesDir: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: inboxAppGroup)?.appendingPathComponent("Shares", isDirectory: true)
    }

    // What the Share extension left: { id, conversation?, items: [{ path?, name, type, text? }] }
    @objc func getPendingShare(_ call: CAPPluginCall) {
        guard let dir = sharesDir else { call.resolve([:]); return }
        let manifest = dir.appendingPathComponent("pending.json")
        guard let data = try? Data(contentsOf: manifest),
              var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { call.resolve([:]); return }
        if var items = json["items"] as? [[String: Any]] {
            for i in items.indices {
                if let rel = items[i]["file"] as? String { items[i]["path"] = dir.appendingPathComponent(rel).path }
            }
            json["items"] = items
        }
        call.resolve(json)
    }

    @objc func clearShare(_ call: CAPPluginCall) {
        if let dir = sharesDir { try? FileManager.default.removeItem(at: dir) }
        call.resolve()
    }

    // "You messaged this person": iOS then suggests them, with Inbox's badge, at the top of
    // the share sheet. key = the Inbox chat (p:<person> / r:<room>).
    @objc func donate(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let name = call.getString("name") else { call.resolve(); return }
        var image: INImage? = nil
        if let b64 = call.getString("image"), let data = Data(base64Encoded: b64) { image = INImage(imageData: data) }
        let person = INPerson(personHandle: INPersonHandle(value: key, type: .unknown), nameComponents: nil,
                              displayName: name, image: image, contactIdentifier: nil, customIdentifier: key)
        let intent = INSendMessageIntent(recipients: [person], outgoingMessageType: .outgoingMessageText, content: nil,
                                         speakableGroupName: INSpeakableString(spokenPhrase: name), conversationIdentifier: key,
                                         serviceName: nil, sender: nil, attachments: nil)
        if let image = image { intent.setImage(image, forParameterNamed: \.speakableGroupName) }
        INInteraction(intent: intent, response: nil).donate { _ in call.resolve() }
    }
}

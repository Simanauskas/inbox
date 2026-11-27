import UIKit
import Capacitor

// The app's web view, plus Inbox's own native plugin (sharing in from other apps, and
// telling iOS who you message so they show up in the share sheet).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(InboxSharePlugin())
    }
}

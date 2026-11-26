"""Notifications for the Inbox iPhone app, sent through Apple (APNs).

Sygnal's own APNs sender expects the app to translate keys like
MSG_FROM_USER_IN_ROOM_WITH_CONTENT, which shows "Jonas in Jonas: hi" for every
bridged 1:1 chat. This one writes the notification itself, the same way the web
app's notifications look: the sender as the title ("Jonas · Tennis" in a group),
and the message, "📷 Photo", "🎤 Voice message" or "Reacted 👍 to your message".

Used from sygnal.yaml as   type: inbox_apns.InboxApnsPushkin
"""
from typing import Any, Dict, Optional

from aioapns.common import PushType
from sygnal.apnspushkin import ApnsPushkin

MAX = 1000
READ_TYPE = "fit.simas.inbox.read"


def _strip_reply(body: str) -> str:
    if not body.startswith("> "):
        return body
    lines = body.split("\n")
    i = 0
    while i < len(lines) and lines[i].startswith(">"):
        i += 1
    if i < len(lines) and lines[i] == "":
        i += 1
    return "\n".join(lines[i:])


def body_of(n) -> Optional[str]:
    c: Dict[str, Any] = n.content or {}
    if n.type == "m.reaction":
        key = (c.get("m.relates_to") or {}).get("key")
        return f"Reacted {key} to your message" if key else "Reacted to your message"
    if n.type == "m.sticker":
        return "Sticker"
    if n.type == "m.room.member":
        return "New chat" if n.membership == "invite" else None
    if n.type == "m.room.encrypted":
        return "New message"
    if n.type != "m.room.message":
        return "New message" if n.type else None
    t = c.get("msgtype")
    if t == "m.image":
        return "📷 Photo"
    if t == "m.video":
        return "🎥 Video"
    if t == "m.audio":
        return "🎤 Voice message" if "org.matrix.msc3245.voice" in c else "🎵 Audio"
    if t == "m.file":
        return "📎 " + str(c.get("filename") or c.get("body") or "File")
    if t == "m.location":
        return "📍 Location"
    if t == "m.emote":
        return "* " + str(c.get("body") or "")
    return _strip_reply(str(c.get("body") or "")) or "New message"


class InboxApnsPushkin(ApnsPushkin):
    def _get_payload_full(self, n, device, log, send_badge_counts: bool) -> Optional[Dict[str, Any]]:
        # "you read these chats" (from server/readsync): a silent push, the app removes
        # their notifications from the lock screen
        if n.type == READ_TYPE:
            rooms = [r for r in ((n.content or {}).get("rooms") or []) if isinstance(r, str)][:50]
            return {"aps": {"content-available": 1}, "read_rooms": rooms} if rooms else None
        body = body_of(n)
        badge = None
        if send_badge_counts and n.counts and n.counts.unread is not None:
            badge = n.counts.unread + (n.counts.missed_calls or 0)
        if body is None and badge is None:
            return None

        payload: Dict[str, Any] = {"aps": {}}
        if body is not None:
            sender = n.sender_display_name or (n.sender[1:].split(":")[0] if n.sender else "Inbox")
            # bridged 1:1 chats are named after the person; another name means a group
            group = n.room_name if n.room_name and n.room_name != n.sender_display_name else None
            title = f"{sender} · {group}" if group else sender
            payload["aps"]["alert"] = {"title": title[:MAX], "body": body[:MAX]}
            payload["aps"]["sound"] = "default"
            if n.room_id:
                payload["aps"]["thread-id"] = n.room_id  # groups a chat's notifications
                payload["room_id"] = n.room_id
            if n.event_id:
                payload["event_id"] = n.event_id
        if badge is not None:
            payload["aps"]["badge"] = badge
        return payload

    # Silent pushes must go as "background" with low priority, or Apple refuses them.
    async def _send_notification(self, request):
        aps = (request.message or {}).get("aps", {})
        if aps.get("content-available") and "alert" not in aps:
            request.push_type = PushType.BACKGROUND
            request.priority = 5
        return await super()._send_notification(request)

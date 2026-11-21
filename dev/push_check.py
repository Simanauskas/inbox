#!/usr/bin/env python3
"""End-to-end check of push notifications on a server set up with server/setup.sh.

Plays the part of a phone: makes Web Push keys, registers a pusher for user
A, has user B message A, and catches what Sygnal sends with a stand-in push
service on the server's Docker network. Then decrypts it, exactly like the
browser would, and checks the content.

Needs: pip install http_ece cryptography, and in server/.env:
    PUSH_EXTRA_ENDPOINT=mockpush     (lets Sygnal deliver to the stand-in)

  python3 dev/push_check.py <server dir> <http://localhost:8008> <user> <password>
"""
import base64, json, os, subprocess, sys, time, urllib.request, uuid
from pathlib import Path

import http_ece
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

server_dir, hs, user, password = sys.argv[1:5]
project = Path(server_dir).resolve().name.lower()
network = f"{project}_default"
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def api(method, path, body=None, token=None):
    req = urllib.request.Request(hs + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"{}")


def login(u, p):
    return api("POST", "/_matrix/client/v3/login", {"type": "m.login.password", "identifier": {"type": "m.id.user", "user": u}, "password": p})


# 1. stand-in push service on the compose network, writing what it receives to a folder
inbox = Path(server_dir) / "data" / "mockpush"
inbox.mkdir(parents=True, exist_ok=True)
for f in inbox.glob("*"):
    f.unlink()
receiver = r'''
import http.server, json, time
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        name = "/out/%d" % (time.time() * 1000)
        open(name + ".bin", "wb").write(body)
        json.dump(dict(self.headers), open(name + ".json", "w"))
        self.send_response(201); self.send_header("Content-Length", "0"); self.end_headers()
http.server.HTTPServer(("0.0.0.0", 80), H).serve_forever()
'''
subprocess.run(["docker", "rm", "-f", "mockpush"], capture_output=True)
subprocess.run(["docker", "run", "-d", "--name", "mockpush", "--network", network, "-v", f"{inbox.resolve()}:/out",
                "python:3-alpine", "python", "-c", receiver], check=True, capture_output=True)

# 2. the "phone": Web Push subscription keys
priv = ec.generate_private_key(ec.SECP256R1())
p256dh = b64(priv.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))
auth_secret = os.urandom(16)

wk = json.loads(urllib.request.urlopen(hs + "/.well-known/matrix/client").read())["fit.simas.inbox.push"]
a = login(user, password)
# clear pushers left by earlier test runs, so each message is pushed once
for p in api("GET", "/_matrix/client/v3/pushers", None, a["access_token"])["pushers"]:
    if p.get("data", {}).get("endpoint") == "http://mockpush/push":
        api("POST", "/_matrix/client/v3/pushers/set", {"kind": None, "app_id": p["app_id"], "pushkey": p["pushkey"]}, a["access_token"])
api("POST", "/_matrix/client/v3/pushers/set", {
    "kind": "http", "app_id": wk["app_id"], "pushkey": p256dh, "app_display_name": "Inbox",
    "device_display_name": "push_check", "lang": "en",
    "data": {"url": wk["gateway_url"], "endpoint": "http://mockpush/push", "auth": b64(auth_secret), "events_only": True},
}, a["access_token"])
print("ok - pusher registered")

# 3. someone else messages us
other = "pushtest" + uuid.uuid4().hex[:6]
subprocess.run(["docker", "compose", "exec", "-T", "synapse", "register_new_matrix_user", "-c", "/data/homeserver.yaml",
                "-u", other, "-p", "pw-" + other, "--no-admin", "http://localhost:8008"], cwd=server_dir, check=True, capture_output=True)
b = login(other, "pw-" + other)
api("PUT", f"/_matrix/client/v3/profile/{b['user_id']}/displayname", {"displayname": "Rokas"}, b["access_token"])
room = api("POST", "/_matrix/client/v3/createRoom", {"invite": [a["user_id"]], "is_direct": True, "preset": "trusted_private_chat"}, b["access_token"])["room_id"]
api("POST", f"/_matrix/client/v3/join/{room}", {}, a["access_token"])
api("PUT", f"/_matrix/client/v3/rooms/{room}/send/m.room.message/{uuid.uuid4().hex}", {"msgtype": "m.text", "body": "Sauna at 7?"}, b["access_token"])
print("ok - message sent")

# 4. wait for the push and decrypt it like the browser does
for _ in range(60):
    got = sorted(inbox.glob("*.bin"))
    if got:
        break
    time.sleep(0.5)
else:
    print(subprocess.run(["docker", "compose", "logs", "--tail", "30", "sygnal"], cwd=server_dir, capture_output=True, text=True).stdout)
    raise SystemExit("FAIL: no push arrived")
body = got[-1].read_bytes()
headers = json.loads(got[-1].with_suffix(".json").read_text())
plain = http_ece.decrypt(body, private_key=priv, auth_secret=auth_secret, version=headers.get("Content-Encoding", "aes128gcm"))
payload = json.loads(plain)
print("ok - push arrived and decrypted:", json.dumps(payload, ensure_ascii=False))
assert payload["room_id"] == room, payload
assert payload["content"]["body"] == "Sauna at 7?", payload
assert payload["sender_display_name"] == "Rokas", payload
assert "event_id" in payload
api("POST", "/_matrix/client/v3/pushers/set", {"kind": None, "app_id": wk["app_id"], "pushkey": p256dh}, a["access_token"])
print("all push checks passed")
subprocess.run(["docker", "rm", "-f", "mockpush"], capture_output=True)

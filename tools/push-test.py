#!/usr/bin/env python3
"""
Send ONE notification to a user's devices, right now.

This is the tool that tells you WHICH half is broken. A notification that never
arrives could be the crypto, the VAPID key, the push service, the service
worker, or simply the reminder loop not matching any event - and waiting for a
calendar tick to find out is slow and ambiguous. This skips the calendar
entirely and reports the push service's own answer for every device.

    ./tools/push-test.py <user> [message]

Reading the result:

    201  delivered to the push service. If nothing shows up on the device, the
         fault is in the SERVICE WORKER (apps/sw.js "push" handler) or the
         browser is quietly dropping it - not in this server.
    401  the push service rejected our VAPID JWT. config/vapid.json does not
         match what the browser subscribed with, or "sub" is not acceptable.
    400  the encrypted body was malformed. Run tools/check-webpush.py.
    404
    410  that subscription is gone. The reminder thread would drop it.
    413  payload too large.
      0  we never reached the push service at all: DNS, TLS, or the VPS has no
         outbound HTTPS to fcm.googleapis.com / web.push.apple.com /
         updates.push.services.mozilla.com.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "client"
sys.path.insert(0, str(ROOT))

from lib import users, webpush            # noqa: E402
from lib.config import URL_PREFIX         # noqa: E402


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip().splitlines()[0] + "\n\nusage: push-test.py <user> [message]")

    user = sys.argv[1]
    text = " ".join(sys.argv[2:]) or "Si ves esto, los avisos funcionan."

    if webpush._BROKEN:
        sys.exit("webpush is disabled: {0}".format(webpush._BROKEN))

    subs = users.user_push_subs(user)
    if not subs:
        sys.exit("{0} has no device registered. Open Nayive, 'Mi cuenta', "
                 "activate notifications, then run this again.".format(user))

    print("VAPID public key: {0}".format(webpush.public_key()))
    print("{0} device(s) for {1}\n".format(len(subs), user))

    worst = 0
    for sub in subs:
        status, err = webpush.send_json(sub, {
            "title": "Nayive",
            "body":  text,
            "url":   URL_PREFIX + "/calendar/",
            "tag":   "push-test",
        }, ttl=60)
        # The endpoint is a capability to notify this user, so only its push
        # service and a short id are printed - never the whole URL.
        host = sub["endpoint"].split("/")[2]
        ok   = 200 <= status < 300
        print("  {0:<34} {1:<5} {2}".format(host, status, "OK" if ok else (err or "")))
        if not ok:
            worst = status or 1

    print()
    if worst:
        sys.exit("at least one device failed - see the status guide in this file's header")
    print("All accepted. If nothing appeared on screen, the fault is in "
          "apps/sw.js, not here.")


if __name__ == "__main__":
    main()

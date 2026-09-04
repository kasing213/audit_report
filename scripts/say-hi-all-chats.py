"""
Send a labeled "hi" message to EVERY configured Telegram chat and pin it,
so you can visually map each chat ID to a real group. Use this to discover
which chat is the manager (SUMMARY) group, then add that ID to Railway.

Usage:
    python scripts/say-hi-all-chats.py
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def load_env(path: Path) -> dict:
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def api(token: str, method: str, params: dict) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params).encode()
    for attempt in range(3):
        req = urllib.request.Request(url, data=data)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 2:
                return {"ok": False, "description": f"network error: {e}"}
    return {"ok": False, "description": "unreachable"}


def main() -> int:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        print(f"ERROR: .env not found at {env_path}")
        return 1

    env = load_env(env_path)
    token = env.get("TELEGRAM_BOT_TOKEN")
    if not token:
        print("ERROR: TELEGRAM_BOT_TOKEN missing in .env")
        return 1

    # (label, chat_id) for every chat-id env var present
    targets = []
    for key in [
        "SUMMARY_CHAT_ID", "AUDIT_CHAT_ID", "REPORT_CHAT_ID", "AD_REPORT_CHAT_ID",
        "SALES_GROUP_1_CHAT_ID", "SALES_GROUP_2_CHAT_ID", "SALES_GROUP_3_CHAT_ID",
        "SALES_GROUP_4_CHAT_ID", "SALES_GROUP_5_CHAT_ID", "SALES_GROUP_6_CHAT_ID",
        "SALES_GROUP_7_CHAT_ID", "SALES_GROUP_8_CHAT_ID",
    ]:
        if env.get(key):
            targets.append((key, env[key]))

    for label, chat_id in targets:
        text = (
            f"hi 👋\n\n"
            f"This group = `{label}`\n"
            f"Chat ID = `{chat_id}`"
        )
        res = api(token, "sendMessage", {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        })
        if not res.get("ok"):
            print(f"[FAIL] {label} ({chat_id}) -> {res.get('description')}")
            continue

        chat = res.get("result", {}).get("chat", {})
        title = chat.get("title") or chat.get("username") or chat.get("first_name") or "?"
        msg_id = res.get("result", {}).get("message_id")

        pin = api(token, "pinChatMessage", {
            "chat_id": chat_id,
            "message_id": msg_id,
            "disable_notification": "false",
        })
        pin_note = "pinned" if pin.get("ok") else f"pin failed ({pin.get('description')})"
        print(f"[ok]   {label} ({chat_id}) -> {title} | {pin_note}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

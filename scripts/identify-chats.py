"""
Identify which Telegram group each chat ID belongs to by sending a
labeled test message to each one. Run once, then check which group
receives which label.

Usage:
    python scripts/identify-chats.py
"""
import os
import sys
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


def send(token: str, chat_id: str, text: str) -> dict:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
    }).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            import json
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        import json
        return json.loads(e.read().decode())


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

    targets = [
        ("REPORT_CHAT_ID",  env.get("REPORT_CHAT_ID")),
        ("AUDIT_CHAT_ID",   env.get("AUDIT_CHAT_ID")),
        ("SUMMARY_CHAT_ID", env.get("SUMMARY_CHAT_ID")),
    ]

    for label, chat_id in targets:
        if not chat_id:
            print(f"[skip] {label} not set")
            continue
        text = (
            f"*CHAT ID IDENTIFICATION TEST*\n"
            f"Label: `{label}`\n"
            f"Chat ID: `{chat_id}`\n"
            f"If you see this message, this group is *{label}*."
        )
        result = send(token, chat_id, text)
        ok = result.get("ok")
        if ok:
            chat = result.get("result", {}).get("chat", {})
            title = chat.get("title") or chat.get("username") or chat.get("first_name") or "?"
            print(f"[ok]   {label} ({chat_id}) -> {title}")
        else:
            print(f"[FAIL] {label} ({chat_id}) -> {result.get('description')}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

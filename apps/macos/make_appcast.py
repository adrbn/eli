#!/usr/bin/env python3
"""Writes a one-item Sparkle appcast.xml for an Eli release, signed with sign_update.

The app's SUFeedURL is releases/latest/download/appcast.xml, so the latest
release's single item is all Sparkle needs to offer the update.
"""
from __future__ import annotations

import argparse
import html
import re
import subprocess
import sys
from email.utils import formatdate


def build_notes(notes_file: str | None) -> str:
    """Markdown bullets or plain lines -> an escaped <li> list (commit subjects are untrusted HTML)."""
    items = []
    if notes_file:
        with open(notes_file, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip().lstrip("-*• ").strip()
                if line and not line.startswith("#"):
                    items.append(f"<li>{html.escape(line)}</li>")
    return "".join(items) or "<li>Maintenance and improvements.</li>"


def sign(sign_update: str, account: str, archive: str) -> str:
    """The `sparkle:edSignature="…" length="…"` enclosure attributes; the key stays in the keychain."""
    out = subprocess.run(
        [sign_update, "--account", account, archive], capture_output=True, text=True, check=True
    ).stdout.strip()
    match = re.search(r'(sparkle:edSignature="[^"]+"\s+length="\d+")', out)
    if not match:
        sys.exit(f"make_appcast: could not parse sign_update output: {out!r}")
    return match.group(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sign-update", required=True, help="path to Sparkle's sign_update")
    parser.add_argument("--account", default="eli", help="keychain account of the EdDSA key")
    parser.add_argument("--zip", required=True, help="the Eli-<version>.zip to sign")
    parser.add_argument("--short", required=True, help="marketing version, e.g. 0.1.0")
    parser.add_argument("--build", required=True, help="CFBundleVersion (monotonic build number)")
    parser.add_argument("--url", required=True, help="download URL of the zip")
    parser.add_argument("--min-system", default="13.0")
    parser.add_argument("--notes-file", default=None, help="release notes, one item per line")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    enclosure = sign(args.sign_update, args.account, args.zip)
    short = html.escape(args.short)
    body = f"<h2>Eli {short}</h2><ul>{build_notes(args.notes_file)}</ul>"
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Eli</title>
    <description>Eli updates</description>
    <language>en</language>
    <item>
      <title>Eli {short}</title>
      <pubDate>{formatdate(usegmt=True)}</pubDate>
      <sparkle:version>{html.escape(args.build)}</sparkle:version>
      <sparkle:shortVersionString>{short}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>{html.escape(args.min_system)}</sparkle:minimumSystemVersion>
      <description><![CDATA[{body}]]></description>
      <enclosure url="{html.escape(args.url, quote=True)}" {enclosure} type="application/octet-stream" />
    </item>
  </channel>
</rss>
"""
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(xml)
    print(f"make_appcast: wrote {args.out} (Eli {args.short}, build {args.build})")


if __name__ == "__main__":
    main()

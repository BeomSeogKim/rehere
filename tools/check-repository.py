#!/usr/bin/env python3
import argparse
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys
from urllib.parse import unquote


PATTERNS = {
    "private conversation link": r"https?://(?:chatgpt\.com/(?:c|share)/|claude\.ai/(?:chat/|code/session_))",
    "conversation role record": r'(?im)^\s*(?:user|assistant|system)\s*:|"(?:session_id|conversation_id)"\s*:\s*"[^"\n]+"[^}\n]*"role"\s*:\s*"(?:user|assistant|system)"',
    "personal machine path": r"/(?:Users|home)/[^\s/]+",
    "private key": r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----",
    "access token": r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b",
    "private memory citation": r"<oai[-]mem[-]citation>",
}
AI_TOOL = r"(?:claude|codex|openai|anthropic|chatgpt|grok|xai|x\.ai|gemini|antigravity|agy)"
AI_CREDIT = re.compile(
    rf"(?im)^\s*(?:(?:[#>*-]|//|/\*)\s*)?(?:[\w-]+-by:.*\b{AI_TOOL}\b|{AI_TOOL}[\w-]*:\s)"
    rf"|\bgenerated (?:with|by)\b.*\b{AI_TOOL}\b"
)
PRIVATE_DIRS = {"transcripts", "chat-logs", "conversation-logs", "session-logs", ".codex"}
README_HEADINGS = {"# Rehere", "## Status", "## Getting started", "## Development", "## Contributing", "## License"}


def text_issues(label, text):
    issues = []
    for number, line in enumerate(text.splitlines(), 1):
        if any(not char.isascii() and char.isalpha() for char in line):
            issues.append(f"{label}:{number}: use English text; escape Unicode test data")
        for rule, pattern in PATTERNS.items():
            if re.search(pattern, line):
                issues.append(f"{label}:{number}: {rule} is prohibited")
        if AI_CREDIT.search(line):
            issues.append(f"{label}:{number}: AI attribution is prohibited")
    return issues


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL)


def repository_issues(staged):
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    entries = [entry for entry in git("ls-files", "--stage", "-z").decode().split("\0") if entry]
    files = {}
    issues = []
    for entry in entries:
        info, name = entry.split("\t", 1)
        mode, blob, stage = info.split()
        path = PurePosixPath(name)
        if stage != "0":
            issues.append(f"{name}: unresolved index entry")
            continue
        if mode not in {"100644", "100755"} or (not staged and (root / name).is_symlink()):
            issues.append(f"{name}: only regular source files are allowed")
            continue
        if any(not char.isascii() for char in name):
            issues.append("repository: filenames must use ASCII English identifiers")
        if PRIVATE_DIRS.intersection(path.parts) or path.parts[:2] == (".claude", "projects"):
            issues.append(f"{name}: private working-record directory is prohibited")
        if path.name.startswith(".env") and path.name != ".env.example":
            issues.append(f"{name}: environment files must not be tracked")
        if name == ".claude/settings.local.json":
            issues.append(f"{name}: personal tool settings must not be tracked")
        try:
            data = git("cat-file", "blob", blob) if staged else (root / name).read_bytes()
            text = data.decode("utf-8")
            if "\0" in text:
                raise ValueError("binary content")
        except (OSError, UnicodeError, ValueError):
            issues.append(f"{name}: unreadable or non-text content needs an explicit policy")
            continue
        files[name] = text
        issues.extend(text_issues(name, text))

    if not README_HEADINGS.issubset(set(files.get("README.md", "").splitlines())):
        issues.append("README.md: required product, status, setup, development, contribution, or license section is missing")
    for name, text in files.items():
        if not name.endswith(".md"):
            continue
        for match in re.finditer(r"\]\(([^)\n]+)\)", text):
            target = match.group(1)
            if target.startswith(("https://", "http://", "mailto:", "#")):
                continue
            target = unquote(target.split("#", 1)[0])
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            line = text.count("\n", 0, match.start()) + 1
            if target.startswith("/") or resolved == ".." or resolved.startswith("../"):
                issues.append(f"{name}:{line}: link must stay inside the repository")
            elif resolved not in files and not any(item.startswith(resolved.rstrip("/") + "/") for item in files):
                issues.append(f"{name}:{line}: link target must be a tracked repository path")
    return issues


def main():
    parser = argparse.ArgumentParser(description="Validate repository language and public-content boundaries.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true", help="Read index blobs instead of working files.")
    mode.add_argument("--text", metavar="LABEL", help="Validate commit or PR metadata from standard input.")
    args = parser.parse_args()
    try:
        issues = text_issues(args.text, sys.stdin.read()) if args.text else repository_issues(args.staged)
    except subprocess.CalledProcessError:
        print("repository guard: unable to read the Git snapshot", file=sys.stderr)
        return 1
    for issue in issues:
        print(issue, file=sys.stderr)
    if not issues:
        print("repository guard ok")
    return bool(issues)


if __name__ == "__main__":
    sys.exit(main())

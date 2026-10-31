from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
README = "# Rehere\n\nA place-memory project.\n" + "".join(
    f"\n## {heading}\n\nPublic technical information.\n"
    for heading in ["Status", "Getting started", "Development", "Contributing", "License"]
)


class RepositoryGuards(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="rehere-guard-")
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.git("init", "-q", "--initial-branch=feat/guard-test")
        self.write("README.md", README)
        self.git("add", "README.md")

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, check=True, capture_output=True
        )

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def guard(self, *args, text=None):
        return subprocess.run(
            [sys.executable, str(ROOT / "tools/check-repository.py"), *args],
            cwd=self.repo, input=text, text=True, capture_output=True,
        )

    def conventions(self, *args, env=None):
        return subprocess.run(
            [str(ROOT / "tools/git-conventions.sh"), *args],
            cwd=self.repo, text=True, capture_output=True, env=env,
        )

    def test_public_repository_passes(self):
        self.assertEqual(self.guard().returncode, 0)
        self.assertEqual(self.guard("--staged").returncode, 0)
        api_example = '{"role": "user", "content": "Describe the public example."}'
        self.assertEqual(self.guard("--text", "API example", text=api_example).returncode, 0)

    def test_private_staged_blob_cannot_be_hidden_by_a_clean_working_copy(self):
        private = "https://" + "chatgpt.com" + "/c/synthetic-session"
        self.write("example.txt", private)
        self.git("add", "example.txt")
        self.write("example.txt", "Public example.\n")
        self.assertEqual(self.guard().returncode, 0)
        result = self.guard("--staged")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(private, result.stdout + result.stderr)

    def test_working_copy_and_index_are_checked_independently(self):
        self.write("example.txt", "Public example.\n")
        self.git("add", "example.txt")
        self.write("example.txt", "\uc0ac\ub2f4\n")
        self.assertNotEqual(self.guard().returncode, 0)
        self.assertEqual(self.guard("--staged").returncode, 0)

    def test_private_markers_and_non_english_letters_are_rejected_without_echo(self):
        examples = [
            "\ud55c\uad6d\uc5b4", "\u65e5\u672c\u8a9e",
            "/" + "Users/example/private.txt",
            "https://" + "claude.ai" + "/chat/synthetic-session",
            "Assistant" + ": a private conversation turn",
            '{"session_' + 'id": "synthetic", "role": "user", "content": "synthetic"}',
            "-----BEGIN " + "PRIVATE KEY-----",
            "ghp_" + "x" * 36,
        ]
        for content in examples:
            with self.subTest(content=content[:8]):
                result = self.guard("--text", "metadata", text=content)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(content, result.stdout + result.stderr)

    def test_environment_files_and_conversation_logs_are_rejected(self):
        for name in [".env", "transcripts/session.jsonl", ".claude/settings.local.json"]:
            with self.subTest(name=name):
                self.write(name, "Synthetic fixture.\n")
                self.git("add", "--force", name)
                self.assertNotEqual(self.guard("--staged").returncode, 0)
                self.git("rm", "--cached", name)
        self.write(".env.example", "# Variables are not selected yet.\n")
        self.git("add", ".env.example")
        self.assertEqual(self.guard("--staged").returncode, 0)

    def test_readme_structure_and_external_relative_links_are_checked(self):
        self.write("README.md", "# Rehere\n")
        self.assertNotEqual(self.guard().returncode, 0)
        self.write("README.md", README + "\n[Private](../outside.md)\n")
        self.assertNotEqual(self.guard().returncode, 0)
        self.write("README.md", README + "\n[Missing](missing.md)\n")
        self.assertNotEqual(self.guard().returncode, 0)

    def test_binary_files_and_symlinks_are_rejected(self):
        (self.repo / "fixture.bin").write_bytes(b"\x00\xff")
        self.git("add", "fixture.bin")
        self.assertNotEqual(self.guard("--staged").returncode, 0)
        self.git("rm", "--cached", "fixture.bin")
        (self.repo / "alias.md").symlink_to("README.md")
        self.git("add", "alias.md")
        self.assertNotEqual(self.guard("--staged").returncode, 0)

    def test_branch_names_and_invalid_revision_ranges_fail_closed(self):
        self.assertEqual(self.conventions("branch", "fix/scene-save").returncode, 0)
        for branch in ["main", "master", "feat/Bad", "fix/has_underscore", "fix/a--b"]:
            self.assertNotEqual(self.conventions("branch", branch).returncode, 0)
        self.assertNotEqual(self.conventions("range", "missing..unknown").returncode, 0)

    def test_commit_format_and_private_body_are_rejected(self):
        good = "fix(scene): preserve the saved version\n\nKeep unrelated objects stable.\n"
        self.write("message.txt", good)
        self.assertEqual(self.conventions("commit", "message.txt").returncode, 0)
        self.write("message.txt", "fix: incomplete change\n")
        self.assertNotEqual(self.conventions("commit", "message.txt").returncode, 0)
        self.write("message.txt", good + "\nUser" + ": synthetic private note\n")
        self.assertNotEqual(self.conventions("commit", "message.txt").returncode, 0)

    def test_ai_signatures_are_rejected_in_files_commits_and_pr_text(self):
        credits = [
            "Co-authored-by: Codex <codex@openai.com>",
            "Co-authored-by: Claude <noreply@anthropic.com>",
            "Signed-off-by: Claude Code",
            "Reviewed-by: Codex",
            "Codex: automated contributor",
            "Generated " + "with [Claude Code](https://claude.com)",
            "Generated " + "by Codex",
        ]
        for credit in credits:
            with self.subTest(credit=credit.split(":", 1)[0]):
                self.assertNotEqual(self.guard("--text", "PR body", text=credit).returncode, 0)
                self.write("message.txt", "docs: clarify scene edits\n\nExplain scene changes.\n\n" + credit)
                self.assertNotEqual(self.conventions("commit", "message.txt").returncode, 0)
                self.write("example.py", "# " + credit + "\n")
                self.git("add", "example.py")
                self.assertNotEqual(self.guard("--staged").returncode, 0)
        human = "Co-authored-by: Example Contributor <contributor@example.org>"
        self.assertEqual(self.guard("--text", "PR body", text=human).returncode, 0)
        technical = "The public example compares Claude and Codex."
        self.assertEqual(self.guard("--text", "PR body", text=technical).returncode, 0)

    def test_pr_metadata_requires_sections_and_public_english_content(self):
        env = dict(os.environ, PR_TITLE="docs: clarify scene editing")
        env["PR_BODY"] = "\n".join(
            f"## {heading}\n\nPublic technical details.\n"
            for heading in ["Summary", "Why", "Changes", "Verification"]
        )
        env["PR_BODY"] += "\n## Checklist\n\n" + "\n".join([
            "- [x] I reviewed the diff for private content and English-only text.",
            "- [x] I checked that comments are necessary and current.",
            "- [x] I ran relevant checks and reported their actual results.",
        ])
        self.assertEqual(self.conventions("pr", env=env).returncode, 0)
        good_body = env["PR_BODY"]
        for credit in ["Co-authored-by: Codex", "Generated " + "with Claude Code"]:
            env["PR_BODY"] = good_body + "\n\n" + credit
            self.assertNotEqual(self.conventions("pr", env=env).returncode, 0)
        env["PR_BODY"] = good_body
        env["PR_BODY"] = env["PR_BODY"].replace("[x]", "[ ]")
        self.assertNotEqual(self.conventions("pr", env=env).returncode, 0)
        env["PR_BODY"] = "## Summary\n\nIncomplete.\n"
        self.assertNotEqual(self.conventions("pr", env=env).returncode, 0)
        env["PR_BODY"] = "\uc0ac\ub2f4"
        self.assertNotEqual(self.conventions("pr", env=env).returncode, 0)


if __name__ == "__main__":
    unittest.main()

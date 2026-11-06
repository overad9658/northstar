"""Focused checks for the local Dependabot manager."""

import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "dependabot_pr_manager", Path(__file__).with_name("dependabot-pr-manager.py")
)
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class ManagerTests(unittest.TestCase):
    def test_combines_independent_dependency_changes(self):
        base = {"name": "app", "dependencies": {"a": "^1", "b": "^1"}}
        first = {"name": "app", "dependencies": {"a": "^2", "b": "^1"}}
        second = {"name": "app", "dependencies": {"a": "^1", "b": "^2"}}
        combined = {"name": "app", "dependencies": dict(base["dependencies"])}
        manager.apply_changes(combined, manager.dependency_changes(base, first))
        manager.apply_changes(combined, manager.dependency_changes(base, second))
        self.assertEqual(combined["dependencies"], {"a": "^2", "b": "^2"})

    def test_rejects_conflicting_dependency_changes(self):
        combined = {"dependencies": {"a": "^2"}}
        with self.assertRaises(ValueError):
            manager.apply_changes(combined, [("dependencies", "a", "^1", "^3")])

    def test_rejects_unrelated_manifest_changes(self):
        with self.assertRaises(ValueError):
            manager.dependency_changes({"name": "before"}, {"name": "after"})

    def test_merges_nonconflicting_lockfile_changes(self):
        base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
        current = base.replace("two\n", "updated-two\n")
        incoming = base.replace("nine\n", "updated-nine\n")
        merged = manager.merge_file_text(current, base, incoming, 12, "pnpm-lock.yaml")
        self.assertIn("updated-two\n", merged)
        self.assertIn("updated-nine\n", merged)

    def test_stops_on_conflicting_lockfile_changes(self):
        base = "one\ntwo\nthree\n"
        current = base.replace("two\n", "first-update\n")
        incoming = base.replace("two\n", "second-update\n")
        with self.assertRaisesRegex(ValueError, "PR #12"):
            manager.merge_file_text(current, base, incoming, 12, "pnpm-lock.yaml")

    def test_recognizes_github_actions_files(self):
        self.assertTrue(manager.is_actions_file(".github/workflows/test.yml"))
        self.assertTrue(manager.is_actions_file(".github/workflows/release.yaml"))
        self.assertTrue(manager.is_actions_file("action.yml"))
        self.assertFalse(manager.is_actions_file(".github/dependabot.yml"))
        self.assertFalse(manager.is_actions_file(".github/workflows/../dependabot.yml"))

    def test_merges_independent_workflow_updates(self):
        base = "name: Test\nsteps:\n  - uses: actions/checkout@v4\n  - run: echo hi\n  - uses: actions/setup-node@v4\n  - run: echo done\n"
        current = base.replace("checkout@v4", "checkout@v5")
        incoming = base.replace("setup-node@v4", "setup-node@v5")
        merged = manager.merge_file_text(current, base, incoming, 12, ".github/workflows/test.yml")
        self.assertIn("checkout@v5", merged)
        self.assertIn("setup-node@v5", merged)

    def test_collects_npm_and_github_actions_prs(self):
        repo = "owner/repo"

        def pull(number):
            return {
                "number": number,
                "user": {"login": "dependabot[bot]"},
                "base": {"ref": "main", "sha": "base"},
                "head": {"ref": "dependabot/update", "sha": "head", "repo": {"full_name": repo}},
            }

        class FakeAPI:
            def __init__(self):
                self.repo = repo

            def pages(self, path):
                return {
                    "pulls?state=open&base=main": [pull(10), pull(11)],
                    "pulls/10/files": [{"filename": ".github/workflows/test.yml", "status": "modified"}],
                    "pulls/11/files": [
                        {"filename": "package.json", "status": "modified"},
                        {"filename": "pnpm-lock.yaml", "status": "modified"},
                    ],
                }[path]

            def file_text(self, path, sha):
                if path == "pnpm-lock.yaml":
                    return "old lock\n" if sha == "base" else "new lock\n"
                return "uses: actions/checkout@v4\n" if sha == "base" else "uses: actions/checkout@v5\n"

            def manifest(self, sha):
                version = "^1" if sha == "base" else "^2"
                return {"name": "app", "dependencies": {"a": version}}

        candidates = manager.collect_candidates(FakeAPI())
        self.assertEqual([item["number"] for item in candidates], [10, 11])
        self.assertEqual(candidates[0]["files"][0][0], ".github/workflows/test.yml")
        self.assertEqual(candidates[1]["files"][0][0], "pnpm-lock.yaml")

    def test_close_validates_all_recorded_prs_before_writing(self):
        repo = "owner/repo"
        combined = {
            "merged": True,
            "head": {"ref": manager.COMBINED_BRANCH, "repo": {"full_name": repo}},
            "base": {"ref": "main"},
            "body": "<!-- northstar-dependabot-prs: 12,13 -->",
        }
        good = {"user": {"login": "dependabot[bot]"}, "base": {"ref": "main"}, "state": "open"}
        bad = {"user": {"login": "someone"}, "base": {"ref": "main"}, "state": "open"}

        class FakeAPI:
            writes = []

            def request(self, path, method="GET", data=None):
                if method == "PATCH":
                    self.writes.append(path)
                return {"pulls/7": combined, "pulls/12": good, "pulls/13": bad}[path]

        api = FakeAPI()
        with self.assertRaises(ValueError):
            manager.close(api, repo, 7)
        self.assertEqual(api.writes, [])

    def test_close_only_touches_recorded_open_prs(self):
        repo = "owner/repo"
        combined = {
            "merged": True,
            "head": {"ref": manager.COMBINED_BRANCH, "repo": {"full_name": repo}},
            "base": {"ref": "main"},
            "body": "<!-- northstar-dependabot-prs: 12,13 -->",
        }
        target = {"user": {"login": "dependabot[bot]"}, "base": {"ref": "main"}}

        class FakeAPI:
            writes = []

            def request(self, path, method="GET", data=None):
                if method == "PATCH":
                    self.writes.append((path, data))
                    return {}
                return {
                    "pulls/7": combined,
                    "pulls/12": dict(target, state="open"),
                    "pulls/13": dict(target, state="closed"),
                }[path]

        api = FakeAPI()
        manager.close(api, repo, 7)
        self.assertEqual(api.writes, [("pulls/12", {"state": "closed"})])


if __name__ == "__main__":
    unittest.main()

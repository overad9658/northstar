#!/usr/bin/env python3
"""Combine npm and GitHub Actions Dependabot PRs and close them after merge."""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
COMBINED_BRANCH = "ci/combined-dependabot-updates"
MAIN_BRANCH = "main"
MANIFEST = "package.json"
LOCKFILE = "pnpm-lock.yaml"
DEPENDENCY_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
PR_MARKER = "<!-- northstar-dependabot-prs: {} -->"


def git(*args, cwd=ROOT, capture=False):
    result = subprocess.run(
        ["git", *args], cwd=cwd, check=True, text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else None


def repository_name(explicit):
    if explicit:
        name = explicit
    else:
        remote = git("remote", "get-url", "origin", capture=True)
        match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", remote)
        if not match:
            raise ValueError("Origin is not a GitHub repository; pass --repo OWNER/REPO.")
        name = match.group(1)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
        raise ValueError("Repository must be OWNER/REPO.")
    return name


def manager_token():
    token = os.environ.get("DEPENDABOT_PR_MANAGER_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        return token
    if shutil.which("gh"):
        result = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    raise ValueError("Set DEPENDABOT_PR_MANAGER_TOKEN or GH_TOKEN, or log in with gh auth login.")


class GitHub:
    def __init__(self, repo, token):
        self.repo = repo
        self.token = token

    def request(self, path, method="GET", data=None):
        url = "https://api.github.com/repos/{}/{}".format(self.repo, path.lstrip("/"))
        body = json.dumps(data).encode() if data is not None else None
        request = Request(url, data=body, method=method, headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
            "User-Agent": "northstar-dependabot-pr-manager",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    def pages(self, path):
        page = 1
        while True:
            separator = "&" if "?" in path else "?"
            items = self.request("{}{}per_page=100&page={}".format(path, separator, page))
            yield from items
            if len(items) < 100:
                return
            page += 1

    def file_text(self, path, sha):
        data = self.request("contents/{}?ref={}".format(path, quote(sha, safe="")))
        return base64.b64decode(data["content"]).decode()

    def manifest(self, sha):
        return json.loads(self.file_text(MANIFEST, sha))


def is_dependabot_pr(pull):
    return (
        pull.get("user", {}).get("login") == "dependabot[bot]"
        and pull.get("base", {}).get("ref") == MAIN_BRANCH
        and not pull.get("draft")
    )


def dependency_changes(before, after):
    before_other = {key: value for key, value in before.items() if key not in DEPENDENCY_SECTIONS}
    after_other = {key: value for key, value in after.items() if key not in DEPENDENCY_SECTIONS}
    if before_other != after_other:
        raise ValueError("PR changes fields outside dependency sections in package.json.")
    changes = []
    for section in DEPENDENCY_SECTIONS:
        old = before.get(section, {})
        new = after.get(section, {})
        if not isinstance(old, dict) or not isinstance(new, dict):
            raise ValueError("Invalid dependency section: " + section)
        for name in sorted(old.keys() | new.keys()):
            if old.get(name) != new.get(name):
                changes.append((section, name, old.get(name), new.get(name)))
    return changes


def apply_changes(manifest, changes):
    for section, name, old, new in changes:
        current = manifest.get(section, {}).get(name)
        if current not in (old, new):
            raise ValueError("Conflicting update for {} in {}: expected {}, found {}.".format(
                name, section, old, current,
            ))
        if new is None:
            manifest[section].pop(name, None)
        else:
            manifest.setdefault(section, {})[name] = new


def is_actions_file(path):
    return bool(re.fullmatch(r"(?:\.github/workflows/[^/]+|action)\.ya?ml", path))


def merge_file_text(current, base, incoming, number, filename):
    """Apply one PR's file changes using its base as the common ancestor."""
    with tempfile.TemporaryDirectory(prefix="northstar-file-merge-") as directory:
        paths = [Path(directory) / name for name in ("current", "base", "incoming")]
        for path, contents in zip(paths, (current, base, incoming)):
            path.write_text(contents)
        result = subprocess.run(
            ["git", "merge-file", "-p", *(str(path) for path in paths)],
            capture_output=True, text=True,
        )
    if result.returncode == 1:
        raise ValueError(
            "Changes to {} from PR #{} conflict with the combined updates; resolve this PR manually.".format(
                filename, number,
            )
        )
    if result.returncode:
        raise OSError("git merge-file failed for {} in PR #{}: {}".format(
            filename, number, result.stderr.strip(),
        ))
    return result.stdout


def verify_combined_pull(pull, repo):
    head = pull.get("head", {})
    branch = head.get("ref", "")
    if not (
        pull.get("merged") is True
        and (branch == COMBINED_BRANCH or branch.startswith(COMBINED_BRANCH + "-"))
        and (head.get("repo") or {}).get("full_name") == repo
        and pull.get("base", {}).get("ref") == MAIN_BRANCH
    ):
        raise ValueError("Merge this repository's combined Dependabot PR into main first.")


def included_pr_numbers(pull):
    match = re.search(r"<!-- northstar-dependabot-prs: ([0-9,]+) -->", pull.get("body") or "")
    if not match:
        raise ValueError("Combined PR has no recorded Dependabot PR numbers.")
    numbers = [int(number) for number in match.group(1).split(",")]
    if any(number <= 0 for number in numbers) or len(numbers) != len(set(numbers)):
        raise ValueError("Combined PR has invalid or duplicate Dependabot PR numbers.")
    return numbers


def collect_candidates(api):
    candidates = []
    for pull in api.pages("pulls?state=open&base=" + MAIN_BRANCH):
        head = pull.get("head", {})
        if (head.get("ref", "").startswith(COMBINED_BRANCH)
                and (head.get("repo") or {}).get("full_name") == api.repo):
            raise ValueError("An open combined Dependabot PR already exists; review it before grouping again.")
        if not is_dependabot_pr(pull) or (pull.get("head", {}).get("repo") or {}).get("full_name") != api.repo:
            continue
        number = pull["number"]
        changed_files = list(api.pages("pulls/{}/files".format(number)))
        files = {item["filename"] for item in changed_files}
        if files and all(is_actions_file(path) for path in files):
            if any(item["status"] != "modified" for item in changed_files):
                print("Skipping #{}: added or deleted GitHub Actions files need manual review.".format(number))
                continue
            updates = [
                (
                    path,
                    api.file_text(path, pull["base"]["sha"]),
                    api.file_text(path, pull["head"]["sha"]),
                )
                for path in sorted(files)
            ]
            candidates.append({"number": number, "manifest": [], "files": updates})
            continue
        if LOCKFILE not in files or not files <= {MANIFEST, LOCKFILE}:
            print("Skipping #{}: files are outside root npm or GitHub Actions workflows.".format(number))
            continue
        before = api.manifest(pull["base"]["sha"])
        after = api.manifest(pull["head"]["sha"])
        try:
            changes = dependency_changes(before, after)
        except ValueError as error:
            print("Skipping #{}: {}".format(number, error))
            continue
        base_lockfile = api.file_text(LOCKFILE, pull["base"]["sha"])
        incoming_lockfile = api.file_text(LOCKFILE, pull["head"]["sha"])
        if not changes and base_lockfile == incoming_lockfile:
            print("Skipping #{}: no dependency or lockfile changes.".format(number))
            continue
        candidates.append({
            "number": number,
            "manifest": changes,
            "files": [(LOCKFILE, base_lockfile, incoming_lockfile)],
        })
    return candidates


def group(api):
    if repository_name(None) != api.repo:
        raise ValueError("For grouping, --repo must match the origin GitHub repository used for git fetch and push.")
    candidates = collect_candidates(api)

    if not candidates:
        print("No eligible npm or GitHub Actions Dependabot PRs found.")
        return
    branch = "{}-{}".format(COMBINED_BRANCH, max(item["number"] for item in candidates))
    if git("ls-remote", "--heads", "origin", branch, capture=True):
        raise ValueError("The combined branch already exists on origin; review or remove it before grouping again.")

    git("fetch", "origin", MAIN_BRANCH)
    with tempfile.TemporaryDirectory(prefix="northstar-dependabot-") as directory:
        worktree = Path(directory) / "checkout"
        git("worktree", "add", "--detach", str(worktree), "origin/" + MAIN_BRANCH)
        try:
            path = worktree / MANIFEST
            manifest = json.loads(path.read_text())
            included = []
            changed_paths = set()
            for candidate in candidates:
                number = candidate["number"]
                apply_changes(manifest, candidate["manifest"])
                if candidate["manifest"]:
                    changed_paths.add(MANIFEST)
                for filename, base, incoming in candidate["files"]:
                    file_path = worktree / filename
                    file_path.write_text(merge_file_text(
                        file_path.read_text(), base, incoming, number, filename,
                    ))
                    changed_paths.add(filename)
                included.append(number)
            if MANIFEST in changed_paths:
                path.write_text(json.dumps(manifest, indent=2) + "\n")
            git("add", *sorted(changed_paths), cwd=worktree)
            if not git("diff", "--cached", "--name-only", cwd=worktree, capture=True):
                print("Selected updates are already on main.")
                return
            git("commit", "-m", "chore: combine Dependabot dependency updates", cwd=worktree)
            git("push", "origin", "HEAD:refs/heads/" + branch, cwd=worktree)
        finally:
            git("worktree", "remove", "--force", str(worktree))

    numbers = ",".join(str(number) for number in included)
    body = "Combined npm and GitHub Actions dependency updates from PRs {}.\n\n{}".format(
        ", ".join("#{}".format(number) for number in included), PR_MARKER.format(numbers),
    )
    created = api.request("pulls", method="POST", data={
        "title": "chore: combine Dependabot dependency updates",
        "head": branch,
        "base": MAIN_BRANCH,
        "body": body,
    })
    print("Created {}".format(created["html_url"]))


def close(api, repo, number):
    pull = api.request("pulls/{}".format(number))
    verify_combined_pull(pull, repo)
    numbers = included_pr_numbers(pull)
    targets = []
    for individual in numbers:
        target = api.request("pulls/{}".format(individual))
        if not is_dependabot_pr(target):
            raise ValueError("Recorded PR #{} is not a Dependabot PR against main.".format(individual))
        targets.append((individual, target))
    for individual, target in targets:
        if target["state"] == "open":
            api.request("pulls/{}".format(individual), method="PATCH", data={"state": "closed"})
            print("Closed #{}".format(individual))
        else:
            print("Already closed #{}".format(individual))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="GitHub OWNER/REPO; defaults to the origin remote")
    parser.add_argument("--dry-run", action="store_true", help="Show the requested operation without changing anything")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("group", help="Create a combined npm and GitHub Actions Dependabot PR")
    close_parser = commands.add_parser("close", help="Close included PRs after the combined PR merges")
    close_parser.add_argument("pr", type=int, help="Number of the merged combined PR")
    args = parser.parse_args(argv)

    try:
        repo = repository_name(args.repo)
        if args.command == "close" and args.pr <= 0:
            raise ValueError("PR number must be positive.")
        if args.dry_run:
            print("Would {} Dependabot PRs for {}{}".format(
                args.command, repo,
                " after checking PR #{}".format(args.pr) if args.command == "close" else "",
            ))
            return 0
        api = GitHub(repo, manager_token())
        if args.command == "group":
            group(api)
        else:
            close(api, repo, args.pr)
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError, HTTPError, URLError) as error:
        print("Error: {}".format(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

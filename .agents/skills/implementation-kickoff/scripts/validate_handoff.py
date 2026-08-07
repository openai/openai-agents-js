#!/usr/bin/env python3
"""Validate the Git invariants of an implementation-kickoff handoff."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


class GitCommandError(RuntimeError):
    """Report a failed Git inspection command."""


def run_git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=False,
        capture_output=True,
        text=True,
    )
    if check and result.returncode != 0:
        command = "git " + " ".join(args)
        detail = result.stderr.strip() or result.stdout.strip() or "unknown Git error"
        raise GitCommandError(f"{command} failed: {detail}")
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate a clean, single-commit implementation-kickoff handoff."
    )
    parser.add_argument("--repo", type=Path, required=True, help="Path to the task worktree.")
    parser.add_argument(
        "--base",
        required=True,
        help="Expected parent commit or ref for the single handoff commit.",
    )
    parser.add_argument(
        "--expected-branch",
        required=True,
        help="Exact local branch name expected at HEAD.",
    )
    parser.add_argument(
        "--required-trailer-email",
        action="append",
        default=[],
        help="Email that must appear in a Co-authored-by trailer. Repeat as needed.",
    )
    parser.add_argument("--json", action="store_true", help="Emit the result as JSON.")
    return parser.parse_args()


def validate(args: argparse.Namespace) -> tuple[dict[str, object], list[str]]:
    repo = args.repo.expanduser().resolve()
    failures: list[str] = []

    if not repo.is_dir():
        return {"repo": str(repo)}, [f"Repository path does not exist: {repo}"]

    top_level = Path(run_git(repo, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    if top_level != repo:
        failures.append(f"--repo must be the worktree root: expected {top_level}, got {repo}")

    status = run_git(repo, "status", "--porcelain=v1", "--untracked-files=all").stdout
    if status:
        failures.append("Worktree is not clean.")

    branch_result = run_git(repo, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
    branch = branch_result.stdout.strip() if branch_result.returncode == 0 else None
    if branch is None:
        failures.append("HEAD is detached.")
    elif branch != args.expected_branch:
        failures.append(f"Current branch is {branch!r}, expected {args.expected_branch!r}.")

    base = run_git(repo, "rev-parse", f"{args.base}^{{commit}}").stdout.strip()
    head = run_git(repo, "rev-parse", "HEAD").stdout.strip()
    parent_line = run_git(repo, "show", "-s", "--format=%P", "HEAD").stdout.strip()
    parents = parent_line.split() if parent_line else []
    if len(parents) != 1:
        failures.append(f"HEAD must have exactly one parent, found {len(parents)}.")
    elif parents[0] != base:
        failures.append(f"HEAD parent is {parents[0]}, expected base {base}.")

    ahead_text = run_git(repo, "rev-list", "--count", f"{base}..{head}").stdout.strip()
    ahead = int(ahead_text)
    if ahead != 1:
        failures.append(f"HEAD must be exactly one commit ahead of base, found {ahead} commits.")

    subject = run_git(repo, "show", "-s", "--format=%s", "HEAD").stdout.strip()
    if not subject:
        failures.append("HEAD commit subject is empty.")

    body = run_git(repo, "show", "-s", "--format=%B", "HEAD").stdout
    trailer_pattern = re.compile(r"^Co-authored-by:\s*.+\s+<([^>]+)>\s*$", re.IGNORECASE)
    trailer_emails = {
        match.group(1).strip().casefold()
        for line in body.splitlines()
        if (match := trailer_pattern.match(line)) is not None
    }
    for email in args.required_trailer_email:
        if email.strip().casefold() not in trailer_emails:
            failures.append(f"Missing required Co-authored-by trailer for {email}.")

    report: dict[str, object] = {
        "repo": str(repo),
        "base": base,
        "head": head,
        "branch": branch,
        "subject": subject,
        "ahead": ahead,
        "clean": not status,
        "coauthor_trailer_emails": sorted(trailer_emails),
        "valid": not failures,
    }
    return report, failures


def main() -> int:
    args = parse_args()
    try:
        report, failures = validate(args)
    except (GitCommandError, ValueError) as exc:
        report = {"repo": str(args.repo.expanduser().resolve()), "valid": False}
        failures = [str(exc)]

    if args.json:
        print(json.dumps({**report, "failures": failures}, indent=2, sort_keys=True))
    else:
        status = "valid" if not failures else "invalid"
        print(f"Implementation handoff: {status}")
        for key in ("repo", "base", "head", "branch", "subject", "ahead", "clean"):
            if key in report:
                print(f"{key}: {report[key]}")
        for failure in failures:
            print(f"error: {failure}", file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

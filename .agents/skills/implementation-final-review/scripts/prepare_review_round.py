#!/usr/bin/env python3
"""Generate deterministic evidence for one implementation final-review round."""

from __future__ import annotations

import argparse
import base64
import json
import os
import shlex
import subprocess
from pathlib import Path

from review_state import (
    _git,
    _load_pathspec_file,
    _parse_component_files,
    review_state,
)

_FINGERPRINT_LENGTH = 64
_REVIEWER_INSTRUCTIONS_HEADING = "## Reviewer instructions\n"
_DEFAULT_REVIEWER_BRIEF = (
    Path(__file__).resolve().parent.parent / "references" / "reviewer-brief.md"
)


def _read_required_text(path: Path, label: str) -> str:
    try:
        value = path.read_text()
    except (OSError, UnicodeError) as error:
        raise ValueError(f"Cannot read {label} {path}: {error}") from error
    if not value.strip():
        raise ValueError(f"{label.capitalize()} must not be empty: {path}")
    return value.rstrip() + "\n"


def _load_prior_clean_components(
    path: Path | None, current_components: set[str]
) -> dict[str, str]:
    if path is None:
        return {}
    try:
        payload = json.loads(path.read_text())
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read prior clean state {path}: {error}") from error
    if not isinstance(payload, dict) or set(payload) != {"clean_components"}:
        raise ValueError(
            "Prior clean state must contain exactly one clean_components object."
        )
    clean_components = payload["clean_components"]
    if not isinstance(clean_components, dict):
        raise ValueError("Prior clean state clean_components must be an object.")
    unknown = sorted(set(clean_components) - current_components)
    if unknown:
        raise ValueError(f"Prior clean state contains unknown components: {unknown}")
    validated: dict[str, str] = {}
    for name, fingerprint in clean_components.items():
        if not isinstance(fingerprint, str) or len(fingerprint) != _FINGERPRINT_LENGTH:
            raise ValueError(
                f"Prior clean component {name} must have a 64-character fingerprint."
            )
        try:
            int(fingerprint, 16)
        except ValueError as error:
            raise ValueError(
                f"Prior clean component {name} must have a hexadecimal fingerprint."
            ) from error
        validated[name] = fingerprint
    return validated


def _load_reviewer_contract(path: Path) -> str:
    brief = _read_required_text(path, "reviewer brief")
    _, separator, contract = brief.partition(_REVIEWER_INSTRUCTIONS_HEADING)
    if not separator or not contract.strip():
        raise ValueError(
            "Reviewer brief must contain a nonempty Reviewer instructions section."
        )
    return _REVIEWER_INSTRUCTIONS_HEADING + contract


def _component_candidates(
    state: dict[str, object], prior_clean: dict[str, str]
) -> tuple[list[str], list[str]]:
    components = state["components"]
    assert isinstance(components, dict)
    reusable: list[str] = []
    invalidated: list[str] = []
    for name, prior_fingerprint in sorted(prior_clean.items()):
        component = components[name]
        assert isinstance(component, dict)
        if component["content_fingerprint"] == prior_fingerprint:
            reusable.append(name)
        else:
            invalidated.append(name)
    return reusable, invalidated


def _shell_command(arguments: list[str]) -> str:
    return shlex.join(arguments)


def _resolved_git_directory(repo: Path, argument: str) -> Path:
    value = Path(_git(repo, "rev-parse", argument).decode().strip())
    return value.resolve() if value.is_absolute() else (repo / value).resolve()


def _is_within(path: Path, directory: Path) -> bool:
    try:
        path.relative_to(directory)
    except ValueError:
        return False
    return True


def _untracked_content(
    repo: Path, pathspecs: tuple[str, ...]
) -> list[dict[str, object]]:
    raw_paths = _git(
        repo,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        *pathspecs,
    )
    content: list[dict[str, object]] = []
    for raw_path in sorted(path for path in raw_paths.split(b"\0") if path):
        relative_path = os.fsdecode(raw_path)
        path = repo / relative_path
        if path.is_symlink():
            content.append(
                {
                    "path": relative_path,
                    "kind": "symlink",
                    "target": os.readlink(path),
                }
            )
            continue
        data = path.read_bytes()
        try:
            text_content = data.decode("utf-8")
        except UnicodeDecodeError:
            content.append(
                {
                    "path": relative_path,
                    "kind": "file",
                    "executable": bool(path.stat().st_mode & 0o111),
                    "encoding": "base64",
                    "content": base64.b64encode(data).decode("ascii"),
                }
            )
        else:
            content.append(
                {
                    "path": relative_path,
                    "kind": "file",
                    "executable": bool(path.stat().st_mode & 0o111),
                    "encoding": "utf-8",
                    "content": text_content,
                }
            )
    return content


def prepare_review_round(
    *,
    repo: Path,
    base: str,
    pathspec_file: Path,
    component_pathspec_files: list[str],
    base_packet: Path,
    round_delta: Path,
    output_dir: Path,
    prior_clean_state: Path | None = None,
    reviewer_brief: Path = _DEFAULT_REVIEWER_BRIEF,
) -> dict[str, object]:
    repo = repo.resolve()
    output_dir = output_dir.resolve()
    git_directories = {
        _resolved_git_directory(repo, "--git-dir"),
        _resolved_git_directory(repo, "--git-common-dir"),
    }
    if any(_is_within(output_dir, directory) for directory in git_directories):
        raise ValueError("Review output directory must not be inside .git.")

    pathspecs = _load_pathspec_file(pathspec_file)
    if not pathspecs:
        raise ValueError("The task pathspec file must contain at least one pathspec.")
    components = _parse_component_files(component_pathspec_files)
    if not components:
        raise ValueError("At least one semantic component manifest is required.")
    state = review_state(repo, base, pathspecs, components)
    stable_packet = _read_required_text(base_packet, "base packet")
    current_delta = _read_required_text(round_delta, "round delta")
    reviewer_contract = _load_reviewer_contract(reviewer_brief)
    prior_clean = _load_prior_clean_components(prior_clean_state, set(components))
    reusable, invalidated = _component_candidates(state, prior_clean)

    resolved_base = str(state["base"])
    tracked_diff = _git(
        repo, "diff", "--binary", "--full-index", resolved_base, "--", *pathspecs
    )
    context_diff = _git(
        repo, "diff", "--full-index", "--unified=80", resolved_base, "--", *pathspecs
    )
    raw_status = _git(
        repo,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        *pathspecs,
    ).decode(errors="replace")

    output_dir.mkdir(parents=True, exist_ok=True)
    state_path = output_dir / "review-state.json"
    diff_path = output_dir / "task.diff"
    context_path = output_dir / "task-context.diff"
    untracked_path = output_dir / "task-untracked.json"
    packet_path = output_dir / "review-packet.md"

    component_args = [
        argument
        for value in component_pathspec_files
        for argument in ("--component-pathspec-file", value)
    ]
    revalidation = _shell_command(
        [
            "PYTHONDONTWRITEBYTECODE=1",
            "python3",
            ".agents/skills/implementation-final-review/scripts/review_state.py",
            "--repo",
            os.fspath(repo),
            "--base",
            resolved_base,
            "--pathspec-file",
            os.fspath(pathspec_file),
            *component_args,
            "--pretty",
        ]
    )

    enriched_state = {
        **state,
        "prior_clean_candidates": reusable,
        "invalidated_prior_clean_components": invalidated,
    }
    state_path.write_text(
        json.dumps(enriched_state, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )
    diff_path.write_bytes(tracked_diff)
    context_path.write_bytes(context_diff)
    untracked_content = _untracked_content(repo, pathspecs)
    untracked_path.write_text(
        json.dumps(untracked_content, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n"
    )

    workspace = state["workspace"]
    assert isinstance(workspace, list)
    changed_paths = (
        "\n".join(
            f"- `{entry['path']}` ({entry['kind']}, `{entry.get('sha256', 'n/a')}`)"
            for entry in workspace
            if isinstance(entry, dict)
        )
        or "- none"
    )
    candidate_text = ", ".join(f"`{name}`" for name in reusable) or "none"
    invalidated_text = ", ".join(f"`{name}`" for name in invalidated) or "none"
    status_block = raw_status.rstrip() or "(clean)"
    packet = f"""# Independent Reviewer Packet

This packet contains stable task evidence plus only the current round delta. Historical round transcripts and superseded verification results are intentionally excluded.

## Stable Base Evidence

{stable_packet}
## Current Round Delta

{current_delta}
## Machine-Generated State

- Resolved base: `{resolved_base}`
- HEAD: `{state["head"]}`
- Combined content fingerprint: `{state["content_fingerprint"]}`
- Repository fingerprint: `{state["repository_fingerprint"]}`
- Exact fingerprint revalidation command: `{revalidation}`
- Full tracked diff: `{diff_path}`
- Wide-context tracked diff: `{context_path}`
- Complete task-owned untracked content: `{untracked_path}`
- State JSON: `{state_path}`
- Byte-identical prior-clean candidates: {candidate_text}
- Invalidated prior-clean components: {invalidated_text}

Prior-clean candidates are not automatically reusable clean credit. The reviewer and coordinator must still prove that the current delta does not change their required behavior, assertions, or boundary with changed components.

### Raw Task Status

```text
{status_block}
```

### Task Content Inventory

{changed_paths}

## Reviewer Contract

{reviewer_contract}
"""
    packet_path.write_text(packet)
    final_state = review_state(repo, resolved_base, pathspecs, components)
    if (
        final_state["content_fingerprint"] != state["content_fingerprint"]
        or final_state["repository_fingerprint"] != state["repository_fingerprint"]
    ):
        raise ValueError(
            "Task content changed while preparing the review bundle; ensure the "
            "output directory is excluded from the canonical manifest and retry."
        )
    return enriched_state


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--base", required=True)
    parser.add_argument("--pathspec-file", required=True, type=Path)
    parser.add_argument(
        "--component-pathspec-file", action="append", required=True, default=[]
    )
    parser.add_argument("--base-packet", required=True, type=Path)
    parser.add_argument("--round-delta", required=True, type=Path)
    parser.add_argument("--prior-clean-state", type=Path)
    parser.add_argument("--reviewer-brief", type=Path, default=_DEFAULT_REVIEWER_BRIEF)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        prepare_review_round(
            repo=args.repo,
            base=args.base,
            pathspec_file=args.pathspec_file,
            component_pathspec_files=args.component_pathspec_file,
            base_packet=args.base_packet,
            round_delta=args.round_delta,
            prior_clean_state=args.prior_clean_state,
            reviewer_brief=args.reviewer_brief,
            output_dir=args.output_dir,
        )
    except ValueError as error:
        parser.error(str(error))
    except subprocess.CalledProcessError as error:
        parser.error(f"Git command failed with exit status {error.returncode}.")
    except (OSError, UnicodeError) as error:
        parser.error(f"Cannot prepare review round: {error}")


if __name__ == "__main__":
    main()

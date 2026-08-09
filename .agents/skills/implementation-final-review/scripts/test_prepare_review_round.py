#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from prepare_review_round import prepare_review_round
from review_state import review_state


class PrepareReviewRoundTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.review_directory = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary_directory.name)
        self.review_root = Path(self.review_directory.name)
        self._git("init", "-q")
        self._git("config", "user.email", "review-round@example.test")
        self._git("config", "user.name", "Review Round Test")
        (self.repo / "src").mkdir()
        (self.repo / "providers").mkdir()
        (self.repo / "src" / "core.ts").write_text("export const core = 1;\n")
        (self.repo / "providers" / "adapter.ts").write_text(
            "export const adapter = 1;\n"
        )
        self._git("add", ".")
        self._git("commit", "-qm", "initial")
        self.base = self._git("rev-parse", "HEAD").strip()

        (self.repo / "src" / "core.ts").write_text("export const core = 2;\n")
        (self.repo / "providers" / "adapter.ts").write_text(
            "export const adapter = 2;\n"
        )
        (self.repo / "src" / "new.ts").write_text("export const newValue = 1;\n")
        self.task_paths = self.repo / "task.paths"
        self.core_paths = self.repo / "core.paths"
        self.provider_paths = self.repo / "providers.paths"
        self.task_paths.write_text("src\nproviders\n")
        self.core_paths.write_text("src\n")
        self.provider_paths.write_text("providers\n")
        self.base_packet = self.repo / "base.md"
        self.round_delta = self.repo / "delta.md"
        self.base_packet.write_text("Required behavior: preserve review assurance.\n")
        self.round_delta.write_text("Round 2 changes only provider wiring.\n")

    def tearDown(self) -> None:
        self.review_directory.cleanup()
        self.temporary_directory.cleanup()

    def _git(self, *args: str) -> str:
        return subprocess.check_output(("git", "-C", str(self.repo), *args), text=True)

    def _prepare(
        self, output_dir: Path, prior_clean_state: Path | None = None
    ) -> dict[str, object]:
        return prepare_review_round(
            repo=self.repo,
            base=self.base,
            pathspec_file=self.task_paths,
            component_pathspec_files=[
                f"core={self.core_paths}",
                f"provider-adapters={self.provider_paths}",
            ],
            base_packet=self.base_packet,
            round_delta=self.round_delta,
            prior_clean_state=prior_clean_state,
            output_dir=output_dir,
        )

    def test_generates_deterministic_current_round_bundle(self) -> None:
        output_dir = self.review_root / "review-output"

        first = self._prepare(output_dir)
        first_packet = (output_dir / "review-packet.md").read_text()
        first_state = (output_dir / "review-state.json").read_text()
        second = self._prepare(output_dir)

        self.assertEqual(first, second)
        self.assertEqual(first_packet, (output_dir / "review-packet.md").read_text())
        self.assertEqual(first_state, (output_dir / "review-state.json").read_text())
        self.assertIn("## Stable Base Evidence", first_packet)
        self.assertIn("## Current Round Delta", first_packet)
        self.assertIn("Historical round transcripts", first_packet)
        self.assertIn("## Reviewer Contract", first_packet)
        self.assertIn(
            "Exact fingerprint revalidation command: `PYTHONDONTWRITEBYTECODE=1 python3 ",
            first_packet,
        )
        self.assertIn("Return exactly one JSON object", first_packet)
        self.assertIn('"reviewed_fingerprints"', first_packet)
        self.assertTrue((output_dir / "task.diff").read_text())
        self.assertTrue((output_dir / "task-context.diff").read_text())
        untracked = json.loads((output_dir / "task-untracked.json").read_text())
        self.assertEqual(untracked[0]["path"], "src/new.ts")
        self.assertEqual(untracked[0]["encoding"], "utf-8")
        self.assertIn("newValue", untracked[0]["content"])

    def test_marks_only_byte_identical_prior_clean_components_as_candidates(
        self,
    ) -> None:
        components = {
            "core": ("src",),
            "provider-adapters": ("providers",),
        }
        before = review_state(self.repo, self.base, ("src", "providers"), components)
        prior = self.repo / "prior.json"
        prior.write_text(
            json.dumps(
                {
                    "clean_components": {
                        name: component["content_fingerprint"]
                        for name, component in before["components"].items()
                    }
                }
            )
        )
        (self.repo / "providers" / "adapter.ts").write_text(
            "export const adapter = 3;\n"
        )

        output_dir = self.review_root / "review-output"
        state = self._prepare(output_dir, prior)

        self.assertEqual(state["prior_clean_candidates"], ["core"])
        self.assertEqual(
            state["invalidated_prior_clean_components"], ["provider-adapters"]
        )
        packet = (output_dir / "review-packet.md").read_text()
        self.assertIn("not automatically reusable clean credit", packet)

    def test_malformed_prior_clean_state_fails_closed(self) -> None:
        prior = self.repo / "prior.json"
        prior.write_text(json.dumps({"clean_components": {"unknown": "0" * 64}}))

        with self.assertRaisesRegex(ValueError, "unknown components"):
            self._prepare(self.repo / "review-output", prior)

    def test_component_partition_errors_remain_fail_closed(self) -> None:
        self.provider_paths.write_text("src\nproviders\n")

        with self.assertRaisesRegex(ValueError, "overlapping"):
            self._prepare(self.repo / "review-output")

    def test_output_directory_inside_review_scope_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "output directory is excluded"):
            self._prepare(self.repo / "src" / "review-output")

    def test_output_directory_inside_git_directory_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "must not be inside .git"):
            self._prepare(self.repo / ".git" / "review-output")

    def test_reviewer_brief_without_instructions_fails_closed(self) -> None:
        malformed_brief = self.repo / "malformed-reviewer-brief.md"
        malformed_brief.write_text("# Missing required section\n")

        with self.assertRaisesRegex(ValueError, "Reviewer instructions"):
            prepare_review_round(
                repo=self.repo,
                base=self.base,
                pathspec_file=self.task_paths,
                component_pathspec_files=[
                    f"core={self.core_paths}",
                    f"provider-adapters={self.provider_paths}",
                ],
                base_packet=self.base_packet,
                round_delta=self.round_delta,
                reviewer_brief=malformed_brief,
                output_dir=self.repo / "review-output",
            )


if __name__ == "__main__":
    unittest.main()

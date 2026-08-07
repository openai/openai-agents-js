#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from review_state import _component, _load_pathspec_file, review_state


class ReviewStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary_directory.name)
        self._git("init", "-q")
        self._git("config", "user.email", "review-state@example.test")
        self._git("config", "user.name", "Review State Test")
        (self.repo / ".gitignore").write_text("plans/private.md\n")
        (self.repo / "src").mkdir()
        (self.repo / "test").mkdir()
        (self.repo / "plans").mkdir()
        (self.repo / "src" / "runtime.ts").write_text("export const value = 1;\n")
        (self.repo / "test" / "runtime.test.ts").write_text("expect(1).toBe(1);\n")
        self._git("add", ".")
        self._git("commit", "-qm", "initial")
        self.base = self._git("rev-parse", "HEAD").strip()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _git(self, *args: str) -> str:
        return subprocess.check_output(
            ("git", "-C", str(self.repo), *args), text=True
        )

    def _run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                sys.executable,
                str(Path(__file__).with_name("review_state.py")),
                "--repo",
                str(self.repo),
                "--base",
                self.base,
                *args,
            ),
            capture_output=True,
            text=True,
        )

    def test_equivalent_pathspecs_have_the_same_content_fingerprint(self) -> None:
        (self.repo / "src" / "runtime.ts").write_text("export const value = 2;\n")
        explicit = review_state(self.repo, self.base, ("src/runtime.ts",))
        directory = review_state(self.repo, self.base, ("src",))
        with_ignored_artifact = review_state(
            self.repo, self.base, ("src/runtime.ts", "plans/private.md")
        )

        self.assertEqual(
            explicit["content_fingerprint"], directory["content_fingerprint"]
        )
        self.assertEqual(
            explicit["content_fingerprint"],
            with_ignored_artifact["content_fingerprint"],
        )

    def test_component_fingerprints_invalidate_only_changed_content(self) -> None:
        runtime = self.repo / "src" / "runtime.ts"
        tests = self.repo / "test" / "runtime.test.ts"
        runtime.write_text("export const value = 2;\n")
        tests.write_text("expect(2).toBe(2);\n")
        components = {
            "runtime": ("src",),
            "tests-examples": ("test",),
        }
        before = review_state(self.repo, self.base, ("src", "test"), components)

        tests.write_text("expect(2).not.toBe(1);\n")
        after = review_state(self.repo, self.base, ("src", "test"), components)

        self.assertEqual(
            before["components"]["runtime"]["content_fingerprint"],
            after["components"]["runtime"]["content_fingerprint"],
        )
        self.assertNotEqual(
            before["components"]["tests-examples"]["content_fingerprint"],
            after["components"]["tests-examples"]["content_fingerprint"],
        )
        self.assertNotEqual(
            before["content_fingerprint"], after["content_fingerprint"]
        )

    def test_pathspec_file_preserves_literal_values_and_deduplicates(self) -> None:
        manifest = self.repo / "paths.txt"
        manifest.write_text("src\n\n#literal\n lead.ts\nsrc\n")

        self.assertEqual(
            _load_pathspec_file(manifest), ("src", "#literal", " lead.ts")
        )

    def test_direct_pathspec_preserves_leading_space(self) -> None:
        (self.repo / " lead.ts").write_text("export const value = 2;\n")

        completed = self._run_cli("--pathspec", " lead.ts")

        self.assertEqual(completed.returncode, 0, completed.stderr)
        state = json.loads(completed.stdout)
        self.assertEqual(
            [entry["path"] for entry in state["workspace"]], [" lead.ts"]
        )

    def test_empty_direct_pathspec_fails_closed(self) -> None:
        completed = self._run_cli("--pathspec", "")

        self.assertEqual(completed.returncode, 2)
        self.assertIn("Pathspecs must not be empty", completed.stderr)
        self.assertNotIn("Traceback", completed.stderr)

    def test_invalid_manifest_files_are_parser_errors(self) -> None:
        cases = (
            ("--pathspec-file", str(self.repo / "missing.paths")),
            ("--pathspec-file", str(self.repo)),
            ("--component-pathspec-file", "runtime="),
            ("--component-pathspec-file", f"runtime={self.repo / 'missing.paths'}"),
        )
        for arguments in cases:
            with self.subTest(arguments=arguments):
                completed = self._run_cli(*arguments)
                self.assertEqual(completed.returncode, 2)
                self.assertIn("error:", completed.stderr)
                self.assertNotIn("Traceback", completed.stderr)

    def test_invalid_repository_is_a_parser_error(self) -> None:
        missing_repo = self.repo / "missing-repo"
        completed = subprocess.run(
            (
                sys.executable,
                str(Path(__file__).with_name("review_state.py")),
                "--repo",
                str(missing_repo),
                "--base",
                self.base,
            ),
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("Git command failed", completed.stderr)
        self.assertNotIn("fatal:", completed.stderr)
        self.assertNotIn("Traceback", completed.stderr)

    def test_invalid_base_is_a_parser_error(self) -> None:
        completed = self._run_cli("--base", "missing-revision")

        self.assertEqual(completed.returncode, 2)
        self.assertIn("Git command failed", completed.stderr)
        self.assertNotIn("fatal:", completed.stderr)
        self.assertNotIn("Traceback", completed.stderr)

    def test_component_manifests_must_cover_combined_content(self) -> None:
        (self.repo / "src" / "runtime.ts").write_text("export const value = 2;\n")
        (self.repo / "test" / "runtime.test.ts").write_text("expect(2).toBe(2);\n")

        with self.assertRaisesRegex(ValueError, "missing=.*runtime.test.ts"):
            review_state(
                self.repo,
                self.base,
                ("src", "test"),
                {"runtime": ("src",)},
            )

    def test_component_manifests_must_not_overlap(self) -> None:
        (self.repo / "src" / "runtime.ts").write_text("export const value = 2;\n")

        with self.assertRaisesRegex(ValueError, "overlapping=.*runtime.ts"):
            review_state(
                self.repo,
                self.base,
                ("src",),
                {"runtime": ("src",), "tests-examples": ("src/runtime.ts",)},
            )

    def test_components_define_combined_scope_when_pathspecs_are_omitted(self) -> None:
        (self.repo / "src" / "runtime.ts").write_text("export const value = 2;\n")
        state = review_state(
            self.repo,
            self.base,
            components={"runtime": ("src",)},
        )

        self.assertEqual(state["pathspecs"], ["src"])
        self.assertEqual(
            [entry["path"] for entry in state["workspace"]], ["src/runtime.ts"]
        )

    def test_component_cli_value(self) -> None:
        self.assertEqual(_component("runtime=src"), ("runtime", "src"))
        self.assertEqual(_component("runtime= lead.ts"), ("runtime", " lead.ts"))

    def test_component_cli_rejects_nul(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            _component("runtime=src\0runtime.ts")


if __name__ == "__main__":
    unittest.main()

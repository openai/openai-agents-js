from __future__ import annotations

import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

from validate_handoff import load_shipped_paths, validate


class ValidateHandoffTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.name", "Test User")
        self._git("config", "user.email", "test@example.com")
        (self.repo / "README.md").write_text("base\n")
        self._git("add", "README.md")
        self._git("commit", "-qm", "base")
        self.base = self._git("rev-parse", "HEAD").stdout.strip()
        self._git("checkout", "-qb", "feat/review-workflow")

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ("git", *args),
            cwd=self.repo,
            check=True,
            capture_output=True,
            text=True,
        )

    def _commit(self, paths: dict[str, str]) -> None:
        for relative_path, content in paths.items():
            path = self.repo / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self._git("add", *paths)
        self._git("commit", "-qm", "change workflow")

    def _args(self, manifest: Path) -> Namespace:
        return Namespace(
            repo=self.repo,
            base=self.base,
            expected_branch="feat/review-workflow",
            required_trailer_email=[],
            shipped_path_manifest=manifest,
        )

    def test_exact_shipped_manifest_is_valid(self) -> None:
        self._commit({"src/change.py": "value = 1\n"})
        manifest = self.root / "shipped.paths"
        manifest.write_text("src/change.py\n")

        report, failures = validate(self._args(manifest))

        self.assertEqual(failures, [])
        self.assertTrue(report["valid"])
        self.assertEqual(report["shipped_paths"], ["src/change.py"])

    def test_operational_file_not_in_manifest_fails(self) -> None:
        self._commit(
            {
                "src/change.py": "value = 1\n",
                "plans/task.md": "operational plan\n",
            }
        )
        manifest = self.root / "shipped.paths"
        manifest.write_text("src/change.py\n")

        report, failures = validate(self._args(manifest))

        self.assertFalse(report["valid"])
        self.assertIn("unexpected=['plans/task.md']", failures[0])

    def test_explicit_ignored_deliverable_is_valid_after_force_staging(self) -> None:
        (self.repo / ".git" / "info" / "exclude").write_text("fixture.generated\n")
        fixture = self.repo / "fixture.generated"
        fixture.write_text("shipped fixture\n")
        self._git("add", "-f", "fixture.generated")
        self._git("commit", "-qm", "add ignored fixture")
        manifest = self.root / "shipped.paths"
        manifest.write_text("fixture.generated\n")

        report, failures = validate(self._args(manifest))

        self.assertEqual(failures, [])
        self.assertTrue(report["valid"])
        self.assertEqual(report["shipped_paths"], ["fixture.generated"])

    def test_manifest_paths_must_be_normalized_and_unique(self) -> None:
        manifest = self.root / "shipped.paths"
        manifest.write_text("src/change.py\nsrc/change.py\n")
        with self.assertRaisesRegex(
            ValueError, "Duplicate shipped-path manifest entry"
        ):
            load_shipped_paths(manifest)

        manifest.write_text("../outside.txt\n")
        with self.assertRaisesRegex(ValueError, "normalized repository-relative paths"):
            load_shipped_paths(manifest)


if __name__ == "__main__":
    unittest.main()

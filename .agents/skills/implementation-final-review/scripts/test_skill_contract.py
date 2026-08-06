#!/usr/bin/env python3

from __future__ import annotations

import unittest
from pathlib import Path


class SkillContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.skill_root = Path(__file__).resolve().parent.parent
        cls.skill = (cls.skill_root / "SKILL.md").read_text()
        cls.agent_config = (cls.skill_root / "agents" / "openai.yaml").read_text()
        cls.reviewer_brief = (cls.skill_root / "references" / "reviewer-brief.md").read_text()

    def test_repo_local_name_is_generic(self) -> None:
        self.assertEqual(self.skill.splitlines()[1], "name: implementation-final-review")
        self.assertIn("# Implementation Final Review\n", self.skill)
        self.assertIn('display_name: "Implementation Final Review"', self.agent_config)
        self.assertIn("$implementation-final-review", self.agent_config)

    def test_quality_gates_cover_prior_failure_modes(self) -> None:
        required_text = (
            "contract-surface inventory",
            "every consumer, forwarding branch, and adapter",
            "Search adjacent contract surfaces even when they are absent from the diff",
            "await-boundary matrix",
            "a newer operation that starts and completes while suspended",
            "current active state is insufficient",
            "A bare `clean`",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

    def test_pathspec_manifest_contract_is_fail_closed(self) -> None:
        required_text = (
            "one literal Git pathspec per nonempty line",
            "do not add comments or trim intentional whitespace",
            "unreadable manifests",
            "Git failures as errors rather than broadening scope",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

    def test_package_boundaries_remain_explicit(self) -> None:
        required_text = (
            "package exports and generated declarations",
            "package/runtime export boundary",
            "ESM/CJS/types",
            "$changeset-validation",
            "$code-change-verification",
            "$pr-draft-summary",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

    def test_reviewer_brief_avoids_repeated_context_discovery(self) -> None:
        required_text = (
            "Exact fingerprint revalidation command",
            "Complete three-dot diff command",
            "verify the supplied merge base when applicable",
            "Do not edit or stage files",
            "inspect memory",
            "rediscover workflow skills",
            "A bare `clean` or generic checklist is incomplete",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.reviewer_brief)

        self.assertNotIn("calculate the merge base", self.reviewer_brief)

    def test_incomplete_reviewer_packets_fail_closed(self) -> None:
        skill_text = (
            "Populate every template field or mark it explicitly `none` or `not applicable`",
            "do not dispatch an incomplete packet",
            "missing packet evidence cannot be reconstructed by the reviewer",
        )
        brief_text = (
            "Fill every field or mark it explicitly `none` or `not applicable`",
            "do not dispatch an incomplete packet",
            "report the missing field and do not return a creditable clean verdict",
            "do not use reopening to replace missing packet contents",
        )

        for text in skill_text:
            with self.subTest(source="skill", text=text):
                self.assertIn(text, self.skill)
        for text in brief_text:
            with self.subTest(source="brief", text=text):
                self.assertIn(text, self.reviewer_brief)

    def test_speed_contract_preserves_independent_assurance(self) -> None:
        required_text = (
            "reuse the same requirement",
            "only the specialty assignment may differ",
            "one multi-target wait",
            "do not poll reviewers separately",
            "Immediately after reviewer dispatch",
            "instead of waiting for a clean verdict",
            "against the same frozen fingerprint",
            "two independent reviewers concurrently",
            "same combined fingerprint",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

    def test_overlapped_final_gates_preserve_fingerprint_integrity(self) -> None:
        required_text = (
            "does not edit, format, regenerate, stage, or create any task-owned deliverable",
            "defer it until review is clean",
            "fingerprints immediately before the gate starts and after it exits",
            "A concurrent pass earns final-gate credit only when both fingerprints match the reviewed fingerprint exactly",
            "cancel or stop the obsolete verification when practical",
            "cannot satisfy completion after a semantic edit",
            "before-and-after component fingerprints match the exact clean-reviewed fingerprint",
            "discard every speculative final-gate result from the prior fingerprint",
            "rerun every mandatory repository gate on the new content",
            "Only after both review and verification evidence apply to the final fingerprint, invoke `$pr-draft-summary` last",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

        brief_text = (
            "Eligible concurrent final-gate commands and non-mutation basis",
            "Gates deferred because they may mutate task-owned content",
        )
        for text in brief_text:
            with self.subTest(source="brief", text=text):
                self.assertIn(text, self.reviewer_brief)

        dispatch = self.skill.index("Immediately after reviewer dispatch")
        gate_start = self.skill.index("start every eligible final repository gate")
        reviewer_wait = self.skill.index("Wait for all concurrent reviewers before editing")
        clean_gate_acceptance = self.skill.index("A speculative final-gate pass")
        pr_summary = self.skill.index("invoke `$pr-draft-summary` last")

        self.assertLess(dispatch, gate_start)
        self.assertLess(gate_start, reviewer_wait)
        self.assertLess(clean_gate_acceptance, pr_summary)


if __name__ == "__main__":
    unittest.main()

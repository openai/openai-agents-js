#!/usr/bin/env python3

from __future__ import annotations

import unittest
from pathlib import Path


class SkillContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = Path(__file__).resolve().parents[4]
        cls.skill_root = Path(__file__).resolve().parent.parent
        cls.skill = (cls.skill_root / "SKILL.md").read_text()
        cls.agent_config = (cls.skill_root / "agents" / "openai.yaml").read_text()
        cls.reviewer_brief = (cls.skill_root / "references" / "reviewer-brief.md").read_text()
        cls.repo_instructions = (cls.repo_root / "AGENTS.md").read_text()

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

    def test_iterative_review_uses_risk_tiered_test_coverage(self) -> None:
        required_text = (
            "for changes unrelated to every owner in",
            "run `pnpm test:review`",
            "for a leaf subsystem change",
            "plus that subsystem's complete test file or directory",
            "with `pnpm exec vitest run <path>`",
            "for cross-cutting core changes",
            "shared test-infrastructure changes",
            "The reduced check earns no final-gate credit",
            "including `pnpm test`",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

        self.assertNotIn("pnpm test -- <path>", self.skill)
        self.assertIn("Do not use `pnpm test <path>`", self.skill)

    def test_reviewers_start_without_inherited_conversation_context(self) -> None:
        required_text = (
            'fork_turns:"none"',
            "Never inherit the implementer's conversation",
            "parent-prepared implementation scope contract",
            "must not invoke `$implementation-strategy` again",
        )
        combined = self.skill + self.reviewer_brief + self.repo_instructions

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, combined)

    def test_semantic_components_preserve_only_justified_clean_evidence(self) -> None:
        required_text = (
            "semantic review components",
            "do not infer component ownership automatically",
            "only a clean candidate",
            "does not change its required behavior, assertions, or boundary",
            "byte-identical prior-clean candidates",
            "not automatically reusable clean credit",
        )
        combined = self.skill + self.reviewer_brief

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, combined)

    def test_round_packets_are_base_plus_delta_without_history_accumulation(self) -> None:
        required_text = (
            "immutable task evidence in one base packet",
            "current-fingerprint changes",
            "Do not append historical round transcripts",
            "prepare_review_round.py",
            "exact reviewer instructions and result schema",
            "Historical round transcripts and superseded verification results are intentionally excluded",
            "Return exactly one JSON object",
        )
        helper = (
            self.skill_root / "scripts" / "prepare_review_round.py"
        ).read_text()
        combined = self.skill + helper + self.reviewer_brief

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, combined)

    def test_review_orchestration_uses_long_waits_and_bounded_clarification(self) -> None:
        required_text = (
            "180000-300000 millisecond timeout",
            "interleave `list_agents`",
            "at most once",
            "second incomplete response invalidates that review",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

    def test_repeated_findings_require_repository_wide_closure(self) -> None:
        required_text = (
            "root-cause closure record",
            "repository-wide search commands and complete hits",
            "`retain`, `replace`, or `delete` disposition",
            "Do not dispatch reviewers while any hit lacks a disposition",
            "focused invariant probe",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

    def test_round_cap_is_task_global(self) -> None:
        required_text = (
            "counter is task-global",
            "renamed `fresh` cycles",
            "do not reset it",
            "materially changes the requirement into a separate task",
        )

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, self.skill)

    def test_reviewer_result_is_structured_and_tracks_inspection_budget(self) -> None:
        required_text = (
            '"checked_inventory_ids"',
            '"unchecked_inventory_ids"',
            '"inspection_budget"',
            '"sibling_instance_scan"',
            "target no more than 12 shell inspection calls",
            "not a hard cap",
        )
        combined = self.skill + self.reviewer_brief

        for text in required_text:
            with self.subTest(text=text):
                self.assertIn(text, combined)


if __name__ == "__main__":
    unittest.main()

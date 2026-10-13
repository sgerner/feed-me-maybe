#!/usr/bin/env python3
"""Focused regression tests for temporal cohort export and evaluator metrics."""

from __future__ import annotations

import importlib.util
import json
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPORTER_PATH = ROOT / "scripts" / "export-decision-cohort.py"
EVALUATOR_PATH = ROOT / "scripts" / "evaluate-decisions.ts"
SPEC = importlib.util.spec_from_file_location("export_decision_cohort", EXPORTER_PATH)
assert SPEC and SPEC.loader
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class TemporalExportTests(unittest.TestCase):
    cutoff = exporter.parse_timestamp("2026-09-22T00:00:00Z")
    as_of = exporter.parse_timestamp("2026-10-13T03:05:00Z")

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "fixture.sqlite"
        self.connection = sqlite3.connect(self.db_path)
        self.connection.executescript(
            """
            CREATE TABLE feeds (
              id TEXT PRIMARY KEY, title TEXT, url TEXT, category TEXT
            );
            CREATE TABLE articles (
              id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, url TEXT,
              image_url TEXT, title TEXT, author TEXT, summary TEXT,
              content TEXT, categories TEXT, published_at INTEGER,
              fetched_at INTEGER, heuristic_score REAL, combined_score REAL,
              jev_score REAL, hidden INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0
            );
            CREATE TABLE user_interactions (
              id TEXT PRIMARY KEY, article_id TEXT NOT NULL,
              interaction_type TEXT NOT NULL, timestamp INTEGER NOT NULL,
              metadata TEXT
            );
            CREATE TABLE article_ai_metadata (
              id TEXT PRIMARY KEY, article_id TEXT UNIQUE, summary TEXT,
              topics TEXT, entities TEXT, content_type TEXT,
              ai_relevance_score REAL, quality_score REAL, novelty_score REAL,
              signals TEXT, processed_at INTEGER
            );
            CREATE TABLE user_preference_memory (
              id TEXT PRIMARY KEY, type TEXT, label TEXT, polarity TEXT,
              strength REAL, evidence_count INTEGER, last_reinforced INTEGER
            );
            """
        )
        self.connection.execute(
            "INSERT INTO feeds VALUES (?, ?, ?, ?)",
            ("feed", "Example Wire", "https://example.test/feed", "technology"),
        )
        self._article("history-early", self.cutoff - 10_000, "History early")
        self._article("history-early-2", self.cutoff - 9_500, "History early two")
        self._article("history-late-ai", self.cutoff - 9_000, "History late metadata")
        self._article("history-postcutoff", self.cutoff - 8_000, "History post cutoff")
        self._article("new-open", self.cutoff + 10_000, "New candidate", summary="raw open summary")
        self._article("new-down-late-ai", self.cutoff + 20_000, "Late AI candidate", summary="raw fallback summary")
        self._article("new-mixed", self.cutoff + 30_000, "Mixed candidate")

        early_open = self.cutoff - 7_000
        late_open = self.cutoff - 6_000
        self._interaction("history-early", "open", early_open)
        self._interaction("history-early-2", "open", early_open + 1)
        self._interaction("history-late-ai", "open", late_open)
        self._interaction("history-postcutoff", "open", self.cutoff + 5_000)
        self._interaction("new-open", "open", self.cutoff + 100_000)
        self._interaction("new-down-late-ai", "thumbs_down", self.cutoff + 200_000)
        mixed_open = self.cutoff + 300_000
        self._interaction("new-mixed", "open", mixed_open)
        self._interaction("new-mixed", "thumbs_down", mixed_open + 86_400_000)

        self._metadata("history-early", ["pre-cutoff-topic"], "early summary", early_open - 1)
        self._metadata("history-early-2", ["pre-cutoff-topic"], "early summary two", early_open)
        # This metadata is available by the profile cutoff, but did not exist
        # when the earlier interaction updated preference memory.
        self._metadata("history-late-ai", ["processed-too-late"], "late history summary", late_open + 1)
        self._metadata("history-postcutoff", ["post-cutoff-topic"], "post cutoff", self.cutoff + 1)
        self._metadata("new-open", ["candidate-allowed"], "candidate summary", self.cutoff + 50_000)
        # Candidate metadata after the first label event must not be present in
        # the state sent to the evaluator.
        self._metadata("new-down-late-ai", ["candidate-too-late"], "late candidate summary", self.cutoff + 200_001)
        self._metadata("new-mixed", ["mixed-candidate-topic"], "mixed summary", mixed_open - 1)
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.temp.cleanup()

    def _article(
        self,
        article_id: str,
        fetched_at: int,
        title: str,
        *,
        summary: str = "summary",
    ) -> None:
        self.connection.execute(
            """INSERT INTO articles
               (id, feed_id, url, image_url, title, author, summary, content,
                categories, published_at, fetched_at, heuristic_score,
                combined_score, jev_score)
               VALUES (?, 'feed', ?, ?, ?, 'Test Author', ?, 'article content',
                       '[\"science\"]', ?, ?, 55, 61, 0.63)""",
            (
                article_id,
                f"https://example.test/{article_id}",
                f"https://example.test/{article_id}.jpg",
                title,
                summary,
                fetched_at - 3_600_000,
                fetched_at,
            ),
        )

    def _interaction(self, article_id: str, kind: str, timestamp: int) -> None:
        self.connection.execute(
            "INSERT INTO user_interactions VALUES (?, ?, ?, ?, '{}')",
            (f"{article_id}-{kind}-{timestamp}", article_id, kind, timestamp),
        )

    def _metadata(self, article_id: str, topics: list[str], summary: str, processed_at: int) -> None:
        self.connection.execute(
            """INSERT INTO article_ai_metadata
               (id, article_id, summary, topics, entities, content_type,
                ai_relevance_score, quality_score, novelty_score, signals,
                processed_at)
               VALUES (?, ?, ?, ?, '[]', 'news', 0.8, 0.6, 0.4, '[]', ?)""",
            (f"metadata-{article_id}", article_id, summary, json.dumps(topics), processed_at),
        )

    def _export(self) -> dict:
        return exporter.export_cohort(
            Namespace(
                input=str(self.db_path),
                profile="temporal",
                cutoff="2026-09-22T00:00:00Z",
                as_of="2026-10-13T03:05:00Z",
                max_per_label=40,
                current_limit=80,
            )
        )

    def test_temporal_profile_and_candidate_metadata_respect_event_time(self) -> None:
        result = self._export()
        by_id = {row["id"]: row for row in result["rows"]}

        self.assertEqual(set(by_id), {"new-open", "new-down-late-ai", "new-mixed"})
        self.assertEqual(by_id["new-open"]["label"], 1)
        self.assertEqual(by_id["new-down-late-ai"]["label"], 0)
        self.assertEqual(by_id["new-mixed"]["label"], 0)  # any later down overrides an open
        self.assertTrue(by_id["new-mixed"]["labelContext"]["mixedOpenAndDown"])
        self.assertAlmostEqual(by_id["new-open"]["baseline"]["aiComposite"], 0.72)
        self.assertIsNone(by_id["new-down-late-ai"]["baseline"]["aiComposite"])

        profile = by_id["new-open"]["state"]["reader_profile"]
        positive_values = {item["value"] for item in profile["positive_preferences"]}
        negative_values = {item["value"] for item in profile["negative_preferences"]}
        self.assertIn("topic:precutofftopic", positive_values)
        self.assertNotIn("topic:processedtoolate", positive_values)
        self.assertNotIn("topic:postcutofftopic", positive_values)
        # The later thumbs_down determines the row label, not the frozen
        # pre-cutoff profile that the scorer receives.
        mixed_profile = by_id["new-mixed"]["state"]["reader_profile"]
        mixed_positive_values = {
            item["value"] for item in mixed_profile["positive_preferences"]
        }
        mixed_negative_values = {
            item["value"] for item in mixed_profile["negative_preferences"]
        }
        self.assertNotIn("topic:mixedcandidatetopic", negative_values)
        self.assertNotIn("topic:mixedcandidatetopic", mixed_positive_values)
        self.assertNotIn("topic:mixedcandidatetopic", mixed_negative_values)

        open_state = by_id["new-open"]["state"]["candidate"]
        self.assertEqual(open_state["topics"], ["candidate-allowed"])
        self.assertEqual(open_state["summary"], "candidate summary")
        late_state = by_id["new-down-late-ai"]["state"]["candidate"]
        self.assertEqual(late_state["topics"], [])
        self.assertEqual(late_state["content_type"], "")
        self.assertEqual(late_state["summary"], "raw fallback summary")

        # Age and metadata are frozen at first action, even when the mixed label
        # includes a later downvote.
        expected_age = round((self.cutoff + 300_000 - (self.cutoff + 30_000 - 3_600_000)) / 3_600_000, 1)
        self.assertEqual(by_id["new-mixed"]["state"]["candidate"]["age_hours"], expected_age)
        self.assertNotIn("label", by_id["new-mixed"]["state"])

    def test_export_does_not_modify_database(self) -> None:
        before = self.db_path.read_bytes()
        self._export()
        self.assertEqual(self.db_path.read_bytes(), before)


class EvaluatorMetricTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node.js is required for evaluator summary test")
    def test_auc_gives_half_credit_for_tied_positive_negative_scores(self) -> None:
        cohort_hash = "fixture-cohort"
        experiment_hash = "fixture-experiment"
        records = [
            {
                "recordType": "run",
                "cohortHash": cohort_hash,
                "experimentHash": experiment_hash,
                "rowCount": 4,
                "provenance": {"fixture": True},
            }
        ]
        examples = [("p-tie", 1, 0.5), ("n-tie", 0, 0.5), ("p-high", 1, 0.9), ("n-low", 0, 0.1)]
        for row_id, label, score in examples:
            records.append(
                {
                    "recordType": "call",
                    "cohortHash": cohort_hash,
                    "experimentHash": experiment_hash,
                    "callKey": f"{row_id}-subq-compact-would_open",
                    "rowId": row_id,
                    "label": label,
                    "baseline": {"jevScore": None, "heuristic": None, "aiComposite": None},
                    "provider": "subq",
                    "variant": "compact",
                    "questionSet": "would_open",
                    "status": "ok",
                    "scores": {"would_open": score},
                }
            )
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "records.jsonl"
            path.write_text("".join(json.dumps(record) + "\n" for record in records))
            completed = subprocess.run(
                ["node", "--experimental-strip-types", str(EVALUATOR_PATH), "--summarize", str(path)],
                check=True,
                capture_output=True,
                text=True,
                cwd=ROOT,
            )
        summary = json.loads(completed.stdout)
        metrics = summary["metrics"]["subq_compact"]
        self.assertEqual(metrics["auc"], 0.875)
        self.assertAlmostEqual(metrics["brier"], 0.13)


if __name__ == "__main__":
    unittest.main()

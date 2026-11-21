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
              signals TEXT, processed_at INTEGER, analysis_status TEXT DEFAULT 'ready'
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
        self.assertIn("topic:pre_cutoff_topic", positive_values)
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

    def test_ignores_failed_enrichment_auto_hides_and_duplicate_opens(self) -> None:
        self.connection.execute(
            "UPDATE article_ai_metadata SET analysis_status = 'failed' WHERE article_id = 'new-open'"
        )
        self._interaction("history-early", "open", self.cutoff - 4_000)
        self.connection.execute(
            "INSERT INTO user_interactions VALUES (?, ?, ?, ?, ?)",
            ("auto-hidden", "history-early", "hide", self.cutoff - 3_000, '{"auto":true}'),
        )
        self.connection.commit()

        row = next(row for row in self._export()["rows"] if row["id"] == "new-open")
        self.assertIsNone(row["baseline"]["aiComposite"])
        self.assertEqual(row["state"]["candidate"]["summary"], "raw open summary")
        profile = row["state"]["reader_profile"]
        self.assertEqual(profile["preferred_sources"], [{"source": "Example Wire", "interactions": 3}])
        self.assertEqual(profile["avoided_sources"], [])

    def test_undo_is_applied_as_of_the_profile_or_label_snapshot(self) -> None:
        vote_at = self.cutoff + 220_000
        undone_at = vote_at + 60_000
        self._article("undone-down", self.cutoff + 70_000, "Undo candidate")
        self._interaction("undone-down", "thumbs_down", vote_at)
        self.connection.execute(
            "UPDATE user_interactions SET metadata = ? WHERE article_id = 'undone-down'",
            (json.dumps({"operation_id": "vote", "undone_at": undone_at}),),
        )
        self.connection.commit()

        after = {row["id"]: row for row in self._export()["rows"]}
        self.assertNotIn("undone-down", after)
        before = exporter.export_cohort(
            Namespace(
                input=str(self.db_path),
                profile="temporal",
                cutoff=exporter.iso_timestamp(self.cutoff),
                as_of=exporter.iso_timestamp(vote_at + 1),
                max_per_label=40,
                current_limit=80,
            )
        )
        self.assertEqual(next(row["label"] for row in before["rows"] if row["id"] == "undone-down"), 0)

    def test_export_does_not_modify_database(self) -> None:
        before = self.db_path.read_bytes()
        self._export()
        self.assertEqual(self.db_path.read_bytes(), before)

    def test_profile_alignment_normalization_gating_and_no_cap(self) -> None:
        self.connection.execute(
            "INSERT INTO feeds (id, title, url, category) VALUES (?, ?, ?, ?)",
            ("blank-feed", "   ", "https://blank.test/rss", "tech"),
        )
        # Seed 260 stale high-evidence positive topics before cutoff plus 1 fresh boost
        stale_ts = self.cutoff - (200 * 24 * 60 * 60 * 1000)
        for i in range(260):
            aid = f"stale-{i}"
            self.connection.execute(
                """INSERT INTO articles
                   (id, feed_id, url, title, author, summary, content, categories, published_at, fetched_at)
                   VALUES (?, 'feed', ?, ?, 'Writer', 's', 'c', ?, ?, ?)""",
                (
                    aid,
                    f"https://example.test/{aid}",
                    f"Stale {i}",
                    json.dumps([f"oldtopic_{i}"]),
                    stale_ts - 1000,
                    stale_ts,
                ),
            )
            for j in range(5):
                self._interaction(aid, "open", stale_ts + j)

        # Fresh normalized/multi-author article with release_note + clickbait + primary_source
        self.assertEqual(
            exporter.parse_authors("By Alice <a@ex.com>, Bob (b@ex.com) & Carol and Dave; Eve"),
            ["alice", "bob", "carol", "dave"],
        )
        fresh_ts = self.cutoff - 1_000
        self.connection.execute(
            """INSERT INTO articles
               (id, feed_id, url, title, author, summary, content, categories, published_at, fetched_at)
               VALUES ('fresh-norm', 'blank-feed', 'https://blank.test/a1', 'Update',
                       'By Alice <a@ex.com>, Bob (b@ex.com) & Carol and Dave; Eve',
                       's', 'c', '["C++", "C#", "F#", ".NET", "Node.js"]', ?, ?)""",
            (fresh_ts - 1000, fresh_ts),
        )
        self.connection.execute(
            """INSERT INTO article_ai_metadata
               (id, article_id, summary, topics, entities, content_type,
                ai_relevance_score, quality_score, novelty_score, signals, processed_at)
               VALUES ('meta-fresh-norm', 'fresh-norm', 'summary', '["Café"]', '[]',
                       'release_note', 0.8, 0.7, 0.5, '["primary_source","clickbait"]', ?)""",
            (fresh_ts - 500,),
        )
        self._interaction("fresh-norm", "boost", fresh_ts)
        # Disliked article on blank-feed that also had open and primary_source
        self.connection.execute(
            """INSERT INTO articles
               (id, feed_id, url, title, author, summary, content, categories, published_at, fetched_at)
               VALUES ('blank-down', 'blank-feed', 'https://blank.test/down', 'Down story',
                       'Writer', 's', 'c', '[]', ?, ?)""",
            (fresh_ts - 2000, fresh_ts - 1000),
        )
        self.connection.execute(
            """INSERT INTO article_ai_metadata
               (id, article_id, summary, topics, entities, content_type,
                ai_relevance_score, quality_score, novelty_score, signals, processed_at)
               VALUES ('meta-blank-down', 'blank-down', 'summary', '[]', '[]',
                       'news', 0.4, 0.4, 0.4, '["primary_source"]', ?)""",
            (fresh_ts - 1500,),
        )
        self._interaction("blank-down", "open", fresh_ts - 900)
        self._interaction("blank-down", "thumbs_down", fresh_ts - 800)
        self.connection.commit()

        result = self._export()
        row = next(r for r in result["rows"] if r["id"] == "new-open")
        profile = row["state"]["reader_profile"]
        pos_values = {p["value"] for p in profile["positive_preferences"]}
        neg_values = {p["value"] for p in profile["negative_preferences"]}

        self.assertIn("topic:c_plus_plus", pos_values)
        self.assertIn("topic:c_sharp", pos_values)
        self.assertIn("topic:f_sharp", pos_values)
        self.assertIn("topic:dotnet", pos_values)
        self.assertIn("topic:nodejs", pos_values)
        self.assertIn("topic:café", pos_values)
        self.assertIn("content_type:release_note", pos_values)
        self.assertNotIn("content_type:news", neg_values)
        self.assertNotIn("signal:clickbait", pos_values)
        self.assertNotIn("signal:primary_source", neg_values)
        self.assertIn("author:alice", pos_values)
        self.assertIn("author:dave", pos_values)
        self.assertNotIn("author:eve", pos_values)
        self.assertIn({"source": "https://blank.test/rss", "interactions": 1}, profile["preferred_sources"])
        self.assertIn({"source": "https://blank.test/rss", "interactions": 1}, profile["avoided_sources"])

        # Current mode: no LIMIT 250 truncation, no log1p magnification, polarity-specific evidence_count
        for i in range(260):
            self.connection.execute(
                """INSERT INTO user_preference_memory
                   (id, type, label, polarity, strength, evidence_count, last_reinforced)
                   VALUES (?, 'topic', ?, 'positive', 0.9, 10, ?)""",
                (f"stale-mem-{i}", f"stale_{i}", stale_ts),
            )
        self.connection.execute(
            """INSERT INTO user_preference_memory
               (id, type, label, polarity, strength, evidence_count, last_reinforced)
               VALUES ('fresh-pos', 'topic', 'topic:systems', 'positive', 0.85, 3, ?)""",
            (fresh_ts,),
        )
        self.connection.execute(
            """INSERT INTO user_preference_memory
               (id, type, label, polarity, strength, evidence_count, last_reinforced)
               VALUES ('fresh-neg', 'topic', 'topic:systems', 'negative', 0.25, 40, ?)""",
            (fresh_ts,),
        )
        self.connection.execute(
            """INSERT INTO articles
               (id, feed_id, url, title, author, summary, content, categories, published_at, fetched_at)
               VALUES ('blank-unlabeled', 'blank-feed', 'https://blank.test/unlabeled', 'Unlabeled blank feed story',
                       'Writer', 's', 'c', '[]', ?, ?)""",
            (fresh_ts - 500, fresh_ts),
        )
        self.connection.commit()

        current = exporter.export_cohort(
            Namespace(
                input=str(self.db_path),
                profile="current",
                cutoff="2026-09-22T00:00:00Z",
                as_of=exporter.iso_timestamp(fresh_ts),
                max_per_label=40,
                current_limit=80,
            )
        )
        cur_row = next(r for r in current["rows"] if r["id"] == "blank-unlabeled")
        self.assertEqual(cur_row["state"]["candidate"]["source"], "https://blank.test/rss")
        cur_pos = cur_row["state"]["reader_profile"]["positive_preferences"]
        sys_pref = next(p for p in cur_pos if p["value"] == "topic:systems")
        self.assertEqual(sys_pref["evidence_count"], 3)
        self.assertAlmostEqual(sys_pref["strength"], 0.6, places=2)


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

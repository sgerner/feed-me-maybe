#!/usr/bin/env python3
"""Export a read-only decision-scoring cohort from a Feed Me Maybe SQLite DB.

The emitted ``state`` matches the shape sent to Jev by ``src/lib/server/ai/jev.ts``.
Temporal mode reconstructs preference memory from pre-cutoff interactions instead
of reading the mutable ``user_preference_memory`` table. Current mode reproduces
the present profile builder and selects a recent, still-unlabeled candidate pool.

Only Python's standard library is used. The SQLite connection is opened in
read-only/query-only mode; only the requested JSON output path is written.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote


DEFAULT_CUTOFF = "2026-09-22T00:00:00Z"
HALF_LIFE_MS = 45 * 24 * 60 * 60 * 1000
AI_COMPOSITE_WEIGHTS = (0.7, 0.2, 0.1)
SIGNAL_WEIGHTS = {
    "official_announcement": 1.25,
    "primary_source": 1.25,
    "specific_details": 1.1,
    "technical_depth": 1.25,
    "data_driven": 1.2,
    "actionable": 1.05,
    "hands_on": 1.1,
    "concrete_update": 1.1,
    "cited_sources": 1.15,
    "speculation": 1.35,
    "rumor": 1.45,
    "leak": 1.4,
    "hype": 1.2,
    "clickbait": 1.3,
    "seo_filler": 1.1,
    "opinion_only": 1.2,
    "future_guessing": 1.3,
    "thin_rewrite": 1.1,
    "ad_copy": 1.1,
}
STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "your", "have",
    "has", "are", "was", "were", "will", "would", "could", "should",
    "about", "into", "their", "there", "after", "before", "what", "when",
    "where", "which", "while", "who", "how", "its", "his", "her", "our",
    "you", "new", "over", "under", "out", "off", "all", "not", "also",
    "just", "more", "than", "some", "very",
}


def parse_timestamp(value: str) -> int:
    """Parse an ISO-8601 timestamp into Unix milliseconds (naive means UTC)."""
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp() * 1000)


def iso_timestamp(epoch_ms: int | float | None) -> str | None:
    if epoch_ms is None:
        return None
    return dt.datetime.fromtimestamp(
        float(epoch_ms) / 1000, tz=dt.timezone.utc
    ).isoformat().replace("+00:00", "Z")


def compact_text(value: Any, limit: int) -> str:
    text = "" if value is None else str(value)
    text = re.sub(r"<[^>]*>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def coerce_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value).strip()
    if not isinstance(value, dict):
        return ""
    for key in ("_", "#text", "term", "name", "label", "value"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def parse_text_array(value: Any, limit: int) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except (TypeError, json.JSONDecodeError):
        return []
    values = parsed if isinstance(parsed, list) else ([] if parsed is None else [parsed])
    result: list[str] = []
    seen: set[str] = set()
    for item in values:
        text = coerce_text(item)
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
        if len(result) >= limit:
            break
    return result


def normalize_token(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower()).strip()


def normalize_label(text: str) -> str:
    return re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9]+", "_", text.lower())).strip()


def tokenize(text: str) -> list[str]:
    return [
        token
        for token in re.split(r"[^a-z0-9]+", text.lower())
        if len(token) >= 3 and token not in STOPWORDS
    ]


def detect_content_type(title: str, summary: str, content: str) -> str:
    blob = f"{title} {summary} {content}".lower()
    patterns = (
        (r"\bobituary\b|\bobit\b|\bin memoriam\b|\bpassed away\b|\bdied at\b|\bdeath of\b", "obituary"),
        (r"\bpodcast\b|\bepisode\b|\baudio\b", "podcast"),
        (r"\bvideo\b|\bwatch\b|\bstream\b", "video"),
        (r"\btutorial\b|\bguide\b|\bhow to\b|\bwalkthrough\b|\bexplainer\b", "tutorial"),
        (r"\brelease notes?\b|\bchangelog\b|\bwhat'?s new\b|\bversion \d+", "release_note"),
        (r"\breview\b|\bhands[- ]on\b|\bfirst look\b|\bpreview\b", "review"),
        (r"\binterview\b|\bq&a\b|\bquestions and answers\b", "interview"),
        (r"\bannouncement\b|\bannounces?\b|\blaunches?\b|\bintroduces?\b|\bdebuts?\b", "announcement"),
        (r"\banalysis\b|\bdeep dive\b|\bexplainer\b", "analysis"),
        (r"\bopinion\b|\beditorial\b|\bguest essay\b", "opinion"),
    )
    for pattern, content_type in patterns:
        if re.search(pattern, blob):
            return content_type
    return "news"


def article_features(row: sqlite3.Row, implicit: bool) -> list[tuple[str, str, float]]:
    """Python equivalent of preferences.ts extractFeatures()."""
    features: dict[tuple[str, str], float] = {}
    author = normalize_label(row["author"] or "")
    if author:
        features[("author", f"author:{author}")] = 0.65

    for category in parse_text_array(row["categories"], 5):
        token = normalize_token(category)
        if token:
            features[("topic", f"topic:{token}")] = 1.1
    for topic in parse_text_array(row["ai_topics"], 8):
        token = normalize_token(topic)
        if token:
            features[("topic", f"topic:{token}")] = 1.5
    for entity in parse_text_array(row["ai_entities"], 8):
        token = normalize_token(entity)
        if token:
            features[("entity", f"entity:{token}")] = 1.2
    for signal in parse_text_array(row["ai_signals"], 8):
        label = normalize_label(signal)
        if label:
            features[("signal", f"signal:{label}")] = SIGNAL_WEIGHTS.get(label, 1.05)

    title = row["title"] or ""
    summary = row["summary"] or ""
    content = (row["content"] or "")[:8000]
    content_type = normalize_token(row["ai_content_type"] or "") or detect_content_type(
        title, summary, content
    )
    features[("content_type", f"content_type:{content_type}")] = 1.8
    if content_type == "obituary":
        features[("negative_filter", "negative_filter:obituary")] = 2.5

    if not implicit:
        tokens = tokenize(title)
        for token in tokens[:8]:
            features[("phrase", f"phrase:{token}")] = 0.35
        for index in range(min(5, max(0, len(tokens) - 1))):
            gram = sorted(tokens[index:index + 2])
            features[("phrase", f"phrase:{':'.join(gram)}")] = 0.75
        for index in range(min(3, max(0, len(tokens) - 2))):
            gram = sorted(tokens[index:index + 3])
            features[("phrase", f"phrase:{':'.join(gram)}")] = 1.0
    return [(kind, label, weight) for (kind, label), weight in features.items()]


def open_readonly(path: Path) -> sqlite3.Connection:
    absolute = path.expanduser().resolve()
    uri = "file:" + quote(str(absolute), safe="/:") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})")}


def validate_schema(connection: sqlite3.Connection) -> dict[str, set[str]]:
    tables = {
        name: table_columns(connection, name)
        for name in ("articles", "feeds", "article_ai_metadata", "user_interactions", "user_preference_memory")
    }
    required = {
        "articles": {"id", "feed_id", "title", "summary", "content", "categories", "published_at", "fetched_at"},
        "feeds": {"id", "title", "url", "category"},
        "user_interactions": {"article_id", "interaction_type", "timestamp"},
    }
    missing = [f"{table}.{column}" for table, cols in required.items() for column in cols - tables[table]]
    missing_tables = [table for table in ("articles", "feeds", "user_interactions") if not tables[table]]
    if missing_tables or missing:
        details = ", ".join(missing_tables + missing)
        raise ValueError(f"Input database is missing required schema: {details}")
    return tables


def profile_from_current_memory(
    connection: sqlite3.Connection, tables: dict[str, set[str]], as_of_ms: int
) -> dict[str, Any]:
    rows: list[sqlite3.Row] = []
    if tables["user_preference_memory"]:
        rows = connection.execute(
            """SELECT type, label, polarity, strength, evidence_count, last_reinforced
               FROM user_preference_memory
               WHERE evidence_count > 0
               ORDER BY evidence_count DESC, last_reinforced DESC
               LIMIT 250"""
        ).fetchall()

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        kind = compact_text(row["type"], 40)
        label = compact_text(row["label"], 120)
        if not kind or not label:
            continue
        key = (kind, label)
        current = grouped.setdefault(key, {"type": kind, "label": label, "positive": 0.0, "negative": 0.0, "evidence_count": 0})
        age_days = max(0.0, (as_of_ms - int(row["last_reinforced"] or 0)) / (24 * 60 * 60 * 1000))
        decayed = max(0.0, min(1.0, float(row["strength"] or 0) * math.pow(0.5, age_days / 45.0)))
        weighted = decayed * (1 + math.log1p(max(0, int(row["evidence_count"] or 0))))
        polarity = "negative" if row["polarity"] == "negative" else "positive"
        current[polarity] += weighted
        current["evidence_count"] += int(row["evidence_count"] or 0)

    return format_profile(grouped, source_counts(connection, as_of_ms, strict_before=False))


def source_counts(
    connection: sqlite3.Connection, before_ms: int, *, strict_before: bool
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    comparator = "<" if strict_before else "<="
    positive = connection.execute(
        f"""SELECT COALESCE(NULLIF(f.title, ''), f.url) AS source, COUNT(*) AS interaction_count
            FROM user_interactions ui JOIN articles a ON a.id = ui.article_id
            JOIN feeds f ON f.id = a.feed_id
            WHERE ui.interaction_type IN ('open', 'read') AND ui.timestamp {comparator} ?
            GROUP BY f.id ORDER BY interaction_count DESC, source ASC LIMIT 5""",
        (before_ms,),
    ).fetchall()
    negative = connection.execute(
        f"""SELECT COALESCE(NULLIF(f.title, ''), f.url) AS source, COUNT(*) AS interaction_count
            FROM user_interactions ui JOIN articles a ON a.id = ui.article_id
            JOIN feeds f ON f.id = a.feed_id
            WHERE ui.interaction_type IN ('thumbs_down', 'hide') AND ui.timestamp {comparator} ?
            GROUP BY f.id ORDER BY interaction_count DESC, source ASC LIMIT 5""",
        (before_ms,),
    ).fetchall()
    preferred = [{"source": compact_text(row["source"], 100), "interactions": int(row["interaction_count"] or 0)} for row in positive]
    avoided = [{"source": compact_text(row["source"], 100), "interactions": int(row["interaction_count"] or 0)} for row in negative]
    return preferred, avoided


def format_profile(
    grouped: dict[tuple[str, str], dict[str, Any]],
    sources: tuple[list[dict[str, Any]], list[dict[str, Any]]],
) -> dict[str, Any]:
    preferences = []
    for item in grouped.values():
        net = item["positive"] - item["negative"]
        if abs(net) >= 0.08:
            preferences.append({**item, "net": net})
    positive = sorted((p for p in preferences if p["net"] > 0), key=lambda p: p["net"], reverse=True)[:14]
    negative = sorted((p for p in preferences if p["net"] < 0), key=lambda p: p["net"])[:14]

    def serialize(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "type": item["type"],
                "value": item["label"],
                "strength": round(min(1.0, abs(float(item["net"]))), 3),
                "evidence_count": int(item["evidence_count"]),
            }
            for item in items
        ]

    return {
        "positive_preferences": serialize(positive),
        "negative_preferences": serialize(negative),
        "preferred_sources": sources[0],
        "avoided_sources": sources[1],
    }


def interaction_features(connection: sqlite3.Connection, tables: dict[str, set[str]], cutoff_ms: int) -> list[sqlite3.Row]:
    ai_join = ""
    ai_select = "'' AS ai_topics, '' AS ai_entities, '' AS ai_content_type, '' AS ai_signals"
    if tables["article_ai_metadata"]:
        ai_join = """LEFT JOIN article_ai_metadata am
                     ON am.article_id = a.id
                    AND am.processed_at IS NOT NULL
                    AND am.processed_at < ?
                    AND am.processed_at <= ui.timestamp"""
        ai_select = "COALESCE(am.topics, '[]') AS ai_topics, COALESCE(am.entities, '[]') AS ai_entities, COALESCE(am.content_type, '') AS ai_content_type, COALESCE(am.signals, '[]') AS ai_signals"

    sql = f"""SELECT ui.article_id, ui.interaction_type, ui.timestamp, ui.metadata,
                     a.title, a.summary, substr(a.content, 1, 8000) AS content,
                     a.author, a.categories,
                     f.id AS feed_id, COALESCE(NULLIF(f.title, ''), f.url) AS source,
                     {ai_select}
              FROM user_interactions ui
              JOIN articles a ON a.id = ui.article_id
              JOIN feeds f ON f.id = a.feed_id
              {ai_join}
              WHERE ui.timestamp < ?
              ORDER BY ui.timestamp ASC, ui.rowid ASC"""
    params = (cutoff_ms, cutoff_ms) if ai_join else (cutoff_ms,)
    return connection.execute(sql, params).fetchall()


def interaction_delta(interaction_type: str) -> tuple[float, float, bool] | None:
    if interaction_type == "boost":
        return (0.45, 0.0, False)
    if interaction_type == "thumbs_up":
        return (0.24, 0.0, False)
    if interaction_type == "save":
        return (0.28, 0.0, False)
    if interaction_type == "open":
        return (0.03, 0.0, True)
    if interaction_type == "read":
        return (0.01, 0.0, True)
    if interaction_type == "thumbs_down":
        return (0.0, 0.3, False)
    if interaction_type == "hide":
        return (0.0, 0.04, False)
    return None


def temporal_profile(
    events: list[sqlite3.Row], candidate_id: str, cutoff_ms: int
) -> tuple[dict[str, Any], int, int]:
    """Replay pre-cutoff interactions, omitting this candidate's own history."""
    memory: dict[tuple[str, str, str], dict[str, float | int]] = {}
    positives: Counter[str] = Counter()
    negatives: Counter[str] = Counter()
    used_events = 0

    for event in events:
        if event["article_id"] == candidate_id:
            continue
        interaction_type = str(event["interaction_type"])
        timestamp = int(event["timestamp"])
        if interaction_type in ("open", "read"):
            positives[str(event["feed_id"])] += 1
        elif interaction_type in ("thumbs_down", "hide"):
            negatives[str(event["feed_id"])] += 1

        delta = interaction_delta(interaction_type)
        if delta is None:
            continue
        metadata = {}
        try:
            metadata = json.loads(event["metadata"] or "{}")
        except (TypeError, json.JSONDecodeError):
            pass
        # Preference-model auto-hides are generated from the profile itself and
        # are not fed back into memory by the application interaction handler.
        if interaction_type == "hide" and isinstance(metadata, dict) and metadata.get("auto"):
            continue

        positive_delta, negative_delta, implicit = delta
        features = article_features(event, implicit)
        if not features:
            continue
        used_events += 1
        for kind, label, weight in features:
            for polarity, amount in (("positive", positive_delta), ("negative", negative_delta)):
                if amount <= 0:
                    continue
                key = (kind, label, polarity)
                contribution = amount * weight
                existing = memory.get(key)
                if existing:
                    age = max(0.0, (timestamp - int(existing["last_reinforced"])) / HALF_LIFE_MS)
                    decayed = float(existing["strength"]) * math.pow(0.5, age)
                    strength = max(0.0, min(1.0, decayed + contribution))
                    evidence = int(existing["evidence_count"]) + 1
                else:
                    strength = max(0.02, min(1.0, contribution))
                    evidence = 1
                memory[key] = {"strength": strength, "evidence_count": evidence, "last_reinforced": timestamp}

    # Mirror the live builder's top-250 row cap before aggregation. A temporal
    # reconstruction has one row per feature/polarity pair.
    selected = sorted(
        memory.items(),
        key=lambda pair: (int(pair[1]["evidence_count"]), int(pair[1]["last_reinforced"])),
        reverse=True,
    )[:250]
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for (kind, label, polarity), item in selected:
        current = grouped.setdefault((kind, label), {"type": kind, "label": label, "positive": 0.0, "negative": 0.0, "evidence_count": 0})
        age_days = max(0.0, (cutoff_ms - int(item["last_reinforced"])) / HALF_LIFE_MS)
        decayed = max(0.0, min(1.0, float(item["strength"]) * math.pow(0.5, age_days)))
        weighted = decayed * (1 + math.log1p(max(0, int(item["evidence_count"]))))
        current[polarity] += weighted
        current["evidence_count"] += int(item["evidence_count"])

    def ranked_sources(counts: Counter[str]) -> list[dict[str, Any]]:
        names: dict[str, str] = {}
        for event in events:
            names.setdefault(str(event["feed_id"]), compact_text(event["source"], 100))
        rows = sorted(counts.items(), key=lambda item: (-item[1], names.get(item[0], "")))[:5]
        return [{"source": names.get(feed_id, ""), "interactions": count} for feed_id, count in rows]

    profile = format_profile(grouped, (ranked_sources(positives), ranked_sources(negatives)))
    return profile, used_events, len(memory)


def state_for_article(
    row: sqlite3.Row,
    *,
    reader_profile: dict[str, Any],
    snapshot_ms: int,
) -> dict[str, Any]:
    published = row["published_at"] or row["fetched_at"] or 0
    age_hours: float | None = None
    if published:
        age_hours = round(max(0.0, (snapshot_ms - int(published)) / 3_600_000), 1)
    return {
        "reader_profile": reader_profile,
        "candidate": {
            "title": compact_text(row["title"], 240),
            "author": compact_text(row["author"], 120),
            "source": compact_text(row["feed_title"], 120),
            "source_category": compact_text(row["feed_category"], 80),
            "summary": compact_text(row["ai_summary"] or row["summary"], 1400),
            "content_excerpt": compact_text(row["content"], 2200),
            "categories": parse_text_array(row["categories"], 8),
            "topics": parse_text_array(row["ai_topics"], 8),
            "entities": parse_text_array(row["ai_entities"], 8),
            "content_type": compact_text(row["ai_content_type"], 50),
            "signals": parse_text_array(row["ai_signals"], 8),
            "age_hours": age_hours,
        },
    }


def baseline_for(row: sqlite3.Row) -> dict[str, Any]:
    relevance = float(row["ai_relevance_score"] or 0)
    quality = float(row["quality_score"] or 0)
    novelty = float(row["novelty_score"] or 0)
    heuristic = row["heuristic_score"]
    ai_composite = None
    if row["ai_processed_at"] is not None:
        ai_composite = round(
            relevance * AI_COMPOSITE_WEIGHTS[0]
            + quality * AI_COMPOSITE_WEIGHTS[1]
            + novelty * AI_COMPOSITE_WEIGHTS[2],
            6,
        )
    return {
        "jevScore": finite_or_none(row["jev_score"]),
        "heuristic": 50.0 if heuristic is None else finite_or_none(heuristic),
        "aiComposite": ai_composite,
        "storedCombinedScore": finite_or_none(row["combined_score"]),
    }


def finite_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def candidate_select(
    connection: sqlite3.Connection,
    tables: dict[str, set[str]],
    *,
    as_of_ms: int,
    cutoff_ms: int | None,
    max_per_label: int,
    current_limit: int,
) -> tuple[list[sqlite3.Row], dict[str, int]]:
    ai_select = "NULL AS ai_processed_at, '' AS ai_summary, '[]' AS ai_topics, '[]' AS ai_entities, '' AS ai_content_type, '[]' AS ai_signals, 0 AS ai_relevance_score, 0 AS quality_score, 0 AS novelty_score"
    ai_join = ""
    if tables["article_ai_metadata"]:
        cutoff_condition = "AND am.processed_at IS NOT NULL AND am.processed_at <= ui.first_action_at" if cutoff_ms is not None else ""
        ai_join = f"""LEFT JOIN article_ai_metadata am ON am.article_id = a.id {cutoff_condition}"""
        ai_select = "am.processed_at AS ai_processed_at, COALESCE(am.summary, '') AS ai_summary, COALESCE(am.topics, '[]') AS ai_topics, COALESCE(am.entities, '[]') AS ai_entities, COALESCE(am.content_type, '') AS ai_content_type, COALESCE(am.signals, '[]') AS ai_signals, COALESCE(am.ai_relevance_score, 0) AS ai_relevance_score, COALESCE(am.quality_score, 0) AS quality_score, COALESCE(am.novelty_score, 0) AS novelty_score"

    base_join = """FROM articles a
                 JOIN feeds f ON f.id = a.feed_id"""
    if cutoff_ms is None:
        # Current mode is a prospective pool; no earlier open/read/down label.
        where = "a.fetched_at <= ? AND NOT EXISTS (SELECT 1 FROM user_interactions ui WHERE ui.article_id = a.id AND ui.interaction_type IN ('open','read','thumbs_down'))"
        extra = ""
        if "hidden" in tables["articles"]:
            extra += " AND COALESCE(a.hidden, 0) = 0"
        if "rejected" in tables["articles"]:
            extra += " AND COALESCE(a.rejected, 0) = 0"
        rows = connection.execute(
            f"""SELECT a.id, a.feed_id, a.url, a.image_url, a.title, a.author, a.summary, a.content, a.categories,
                       a.published_at, a.fetched_at, a.heuristic_score, a.combined_score, a.jev_score,
                       f.title AS feed_title, f.category AS feed_category, {ai_select}
                {base_join} {ai_join}
                WHERE {where}{extra}
                ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id ASC LIMIT ?""",
            (as_of_ms, current_limit),
        ).fetchall()
        total = connection.execute(f"SELECT COUNT(*) AS n {base_join} WHERE {where}{extra}", (as_of_ms,)).fetchone()["n"]
        return rows, {"eligible_unlabeled_recent": int(total), "selected": len(rows)}

    # Holdout candidates arrived after the frozen profile cutoff and were
    # labelled by a later open/down event no later than the snapshot.
    action_rows = connection.execute(
        """SELECT a.id, a.feed_id, MIN(ui.timestamp) AS first_action_at,
                  MAX(CASE WHEN ui.interaction_type = 'open' THEN 1 ELSE 0 END) AS has_open,
                  MAX(CASE WHEN ui.interaction_type = 'thumbs_down' THEN 1 ELSE 0 END) AS has_down,
                  SUM(CASE WHEN ui.interaction_type = 'open' THEN 1 ELSE 0 END) AS open_count,
                  SUM(CASE WHEN ui.interaction_type = 'thumbs_down' THEN 1 ELSE 0 END) AS down_count,
                  (SELECT ui2.interaction_type FROM user_interactions ui2
                   WHERE ui2.article_id = a.id
                     AND ui2.interaction_type IN ('open', 'thumbs_down')
                     AND ui2.timestamp > ? AND ui2.timestamp <= ?
                   ORDER BY ui2.timestamp ASC, ui2.rowid ASC LIMIT 1) AS first_action_type
           FROM articles a JOIN user_interactions ui ON ui.article_id = a.id
           WHERE ui.interaction_type IN ('open', 'thumbs_down')
             AND ui.timestamp > ? AND ui.timestamp <= ?
             AND a.fetched_at > ? AND a.fetched_at <= ?
           GROUP BY a.id, a.feed_id
           ORDER BY first_action_at DESC, a.id ASC""",
        (cutoff_ms, as_of_ms, cutoff_ms, as_of_ms, cutoff_ms, as_of_ms),
    ).fetchall()
    by_label: dict[int, list[sqlite3.Row]] = {0: [], 1: []}
    mixed = 0
    for row in action_rows:
        label = 0 if row["has_down"] else 1
        if row["has_down"] and row["has_open"]:
            mixed += 1
        by_label[label].append(row)
    # Spread the sample throughout the held-out window, rather than comparing
    # only its latest opens with downvotes from many different dates.
    sampled = {
        label: sorted(items, key=lambda row: hashlib.sha256(str(row['id']).encode()).digest())[:max_per_label]
        for label, items in by_label.items()
    }
    selected_actions = sampled[0] + sampled[1]
    ids = [str(row["id"]) for row in selected_actions]
    if not ids:
        return [], {
            "eligible_postcutoff_with_label": 0,
            "eligible_negative": len(by_label[0]),
            "eligible_positive": len(by_label[1]),
            "selected_negative": 0,
            "selected_positive": 0,
            "mixed_open_and_down": mixed,
        }

    placeholders = ",".join("?" for _ in ids)
    candidates = connection.execute(
        f"""SELECT a.id, a.feed_id, a.url, a.image_url, a.title, a.author, a.summary, a.content, a.categories,
                   a.published_at, a.fetched_at, a.heuristic_score, a.combined_score, a.jev_score,
                   f.title AS feed_title, f.category AS feed_category,
                   ui.first_action_at, ui.has_open, ui.has_down, ui.open_count, ui.down_count,
                   (SELECT ui2.interaction_type FROM user_interactions ui2
                    WHERE ui2.article_id = a.id
                      AND ui2.interaction_type IN ('open', 'thumbs_down')
                      AND ui2.timestamp > ? AND ui2.timestamp <= ?
                    ORDER BY ui2.timestamp ASC, ui2.rowid ASC LIMIT 1) AS first_action_type,
                   {ai_select}
            FROM articles a JOIN feeds f ON f.id = a.feed_id
            JOIN (
              SELECT article_id, MIN(timestamp) AS first_action_at,
                     MAX(CASE WHEN interaction_type = 'open' THEN 1 ELSE 0 END) AS has_open,
                     MAX(CASE WHEN interaction_type = 'thumbs_down' THEN 1 ELSE 0 END) AS has_down,
                     SUM(CASE WHEN interaction_type = 'open' THEN 1 ELSE 0 END) AS open_count,
                     SUM(CASE WHEN interaction_type = 'thumbs_down' THEN 1 ELSE 0 END) AS down_count
              FROM user_interactions WHERE interaction_type IN ('open', 'thumbs_down') AND timestamp > ? AND timestamp <= ?
              GROUP BY article_id
            ) ui ON ui.article_id = a.id
            {ai_join}
            WHERE a.id IN ({placeholders})
            ORDER BY ui.first_action_at DESC, a.id ASC""",
        (cutoff_ms, as_of_ms, cutoff_ms, as_of_ms, *ids),
    ).fetchall()
    return candidates, {
        "eligible_postcutoff_with_label": len(action_rows),
        "eligible_negative": len(by_label[0]),
        "eligible_positive": len(by_label[1]),
        "selected_negative": min(max_per_label, len(by_label[0])),
        "selected_positive": min(max_per_label, len(by_label[1])),
        "mixed_open_and_down": mixed,
    }


def export_cohort(args: argparse.Namespace) -> dict[str, Any]:
    input_path = Path(args.input)
    connection = open_readonly(input_path)
    tables = validate_schema(connection)
    cutoff_ms = parse_timestamp(args.cutoff)
    as_of_ms = parse_timestamp(args.as_of) if args.as_of else int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    mode = args.profile
    temporal = mode == "temporal"
    selected, sample_stats = candidate_select(
        connection,
        tables,
        as_of_ms=as_of_ms,
        cutoff_ms=cutoff_ms if temporal else None,
        max_per_label=args.max_per_label,
        current_limit=args.current_limit,
    )

    history: list[sqlite3.Row] = []
    history_types: Counter[str] = Counter()
    if temporal:
        history = interaction_features(connection, tables, cutoff_ms)
        history_types.update(str(row["interaction_type"]) for row in history)
    current_profile = None if temporal else profile_from_current_memory(connection, tables, as_of_ms)
    history_ids = {str(event['article_id']) for event in history}
    profile_cache: dict[str, tuple[dict[str, Any], int, int]] = {}

    rows: list[dict[str, Any]] = []
    profile_stats = {"profile_history_interactions": len(history), "profile_events_used": 0, "unique_profile_articles": len({str(row["article_id"]) for row in history}), "profile_memory_features": 0}
    for article in selected:
        if temporal:
            # Newly ingested holdout articles normally have no training history,
            # so reconstruct the shared frozen profile only once. Preserve
            # candidate exclusion for imported records with earlier events.
            excluded_id = str(article['id']) if str(article['id']) in history_ids else ''
            if excluded_id not in profile_cache:
                profile_cache[excluded_id] = temporal_profile(history, excluded_id, cutoff_ms)
            reader_profile, used, features = profile_cache[excluded_id]
            profile_stats["profile_events_used"] = max(profile_stats["profile_events_used"], used)
            profile_stats["profile_memory_features"] = max(profile_stats["profile_memory_features"], features)
            label = 0 if article["has_down"] else 1
            first_action = int(article["first_action_at"])
            snapshot_ms = first_action
            label_context = {
                "firstActionAt": iso_timestamp(first_action),
                "firstActionType": str(article["first_action_type"] or "unknown"),
                "mixedOpenAndDown": bool(article["has_open"] and article["has_down"]),
                "feedId": article["feed_id"],
                "feed": compact_text(article["feed_title"], 120),
            }
        else:
            reader_profile = current_profile or {}
            label = None
            snapshot_ms = as_of_ms
            label_context = None
        state = state_for_article(article, reader_profile=reader_profile, snapshot_ms=snapshot_ms)
        row = {
            "id": str(article["id"]),
            "label": label,
            "state": state,
            "baseline": baseline_for(article),
            "imageUrl": article["image_url"],
        }
        if label_context is not None:
            row["labelContext"] = label_context
        rows.append(row)

    metadata = {
        "profileMode": mode,
        "inputSnapshot": str(input_path.resolve()),
        "readOnly": True,
        "exportedAtUtc": iso_timestamp(as_of_ms),
        "cutoffUtc": iso_timestamp(cutoff_ms),
        "stateSnapshotSemantics": (
            "profile is frozen at cutoff; candidate state uses first post-cutoff label timestamp; article text fields are read from the supplied snapshot and may have been edited after either time"
            if temporal
            else "profile and article metadata reflect the supplied snapshot as of exportedAtUtc"
        ),
        "profileReconstruction": (
            "Replayed only pre-cutoff interactions; excludes the candidate's own history; interaction-derived AI features require processed_at <= that interaction and < cutoff"
            if temporal
            else "Mirrors current user_preference_memory and all-time source counts from jev.ts"
        ),
        "labelSemantics": (
            "label=1 when an article's first post-cutoff open/down event set has open and no thumbs_down; label=0 when any thumbs_down exists (down overrides mixed open/down). Open is a weak positive; absent open is not a negative. The database has no impression/rank log."
            if temporal
            else "No label assigned; candidates have no open/read/thumbs_down interaction and are intended for prospective follow-up."
        ),
        "baselineSemantics": "baseline values come from the current stored snapshot and are descriptive only in temporal mode; Jev/combined scores may use future profile feedback or be stale. aiComposite = 0.7*relevance + 0.2*quality + 0.1*novelty.",
        "aiMetadataPolicy": (
            "Temporal history requires processed_at <= each interaction and before cutoff; candidate metadata is included only when processed_at <= its first labeling event."
            if temporal
            else "Current candidate metadata is included as stored in the snapshot."
        ),
        "selection": sample_stats,
        "samplingPolicy": "deterministic SHA-256 article-id sample within each label; all negatives retained when below cap",
        "profileStats": profile_stats,
        "profileInteractionTypeCounts": dict(sorted(history_types.items())),
        "rowCount": len(rows),
        "database": {
            "sqliteVersion": sqlite3.sqlite_version,
            "articleCount": int(connection.execute("SELECT COUNT(*) AS n FROM articles").fetchone()["n"]),
            "interactionCount": int(connection.execute("SELECT COUNT(*) AS n FROM user_interactions").fetchone()["n"]),
        },
    }
    connection.close()
    return {"provenance": metadata, "rows": rows}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="SQLite production snapshot path (opened read-only)")
    parser.add_argument("output", help="JSON output path, or '-' for stdout")
    parser.add_argument("--profile", choices=("current", "temporal"), default="temporal")
    parser.add_argument("--cutoff", default=DEFAULT_CUTOFF, help=f"Temporal profile cutoff (default: {DEFAULT_CUTOFF})")
    parser.add_argument("--as-of", help="Current profile/state timestamp as ISO-8601 UTC; defaults to export time")
    parser.add_argument("--max-per-label", type=int, default=40, help="Temporal rows per label (default: 40)")
    parser.add_argument("--current-limit", type=int, default=80, help="Current unlabeled rows to export (default: 80)")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = export_cohort(args)
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if args.output == "-":
            sys.stdout.write(encoded + "\n")
        else:
            output_path = Path(args.output).expanduser()
            if output_path.resolve() == Path(args.input).expanduser().resolve():
                raise ValueError("Input snapshot and output JSON path must differ")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(encoded + "\n", encoding="utf-8")
            print(
                json.dumps(
                    {
                        "output": str(output_path.resolve()),
                        "rows": result["provenance"]["rowCount"],
                        "profile": result["provenance"]["profileMode"],
                        "selection": result["provenance"]["selection"],
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

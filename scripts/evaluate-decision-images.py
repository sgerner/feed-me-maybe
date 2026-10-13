#!/usr/bin/env python3
"""Compare SubQ text-only and one-image decisions for a frozen cohort.

Example (Python 3.10+):
  SUBQ_API_KEY_FILE=/path/to/key.txt python3 scripts/evaluate-decision-images.py \
    image-cohort.json image-results.jsonl --questions decision-questions.json --limit 12
  SUBQ_API_KEY_FILE=/path/to/key.txt python3 scripts/evaluate-decision-images.py \
    candidate-cohort.json signal-results.jsonl --questions signal-questions.json --text-only --limit 80

The default cohort mode uses rows with ``id``, ``state``, and ``imageUrl``.
With ``--text-only``, rows need a profile-free ``state.candidate`` object and
the question file contains only evidence_quality and hype_speculation.
Successful calls are resumable. The JSONL stores hashes and metadata, never
state or image bytes.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import ipaddress
import json
import os
import socket
import ssl
import sys
import time
import warnings
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit


ENDPOINT_HOST = "api.subq.ai"
ENDPOINT_PATH = "/v1/systemone"
MODEL = "subq-snap-preview"
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_ROWS = 12
FETCH_TIMEOUT_SECONDS = 15
API_TIMEOUT_SECONDS = 30
FORMAT_VERSION = 1
IMAGE_QUESTION_NAMES = ("would_open", "evidence_quality", "hype_speculation")
TEXT_ONLY_QUESTION_NAMES = ("evidence_quality", "hype_speculation")
MAGIC_MIMES = {
    "png": ("image/png", lambda data: data.startswith(b"\x89PNG\r\n\x1a\n")),
    "jpeg": ("image/jpeg", lambda data: data.startswith(b"\xff\xd8\xff")),
    "webp": (
        "image/webp",
        lambda data: len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
    ),
}


class ImageInputError(Exception):
    """A public image URL or its content is not suitable for this experiment."""


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection pinned to addresses already checked as public."""

    def __init__(
        self,
        host: str,
        port: int,
        addresses: list[tuple[int, int, int, tuple[Any, ...]]],
        timeout: float,
    ) -> None:
        super().__init__(host, port=port, timeout=timeout, context=ssl.create_default_context())
        self.addresses = addresses

    def connect(self) -> None:
        last_error: OSError | None = None
        for family, socktype, proto, sockaddr in self.addresses:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(self.timeout)
            try:
                sock.connect(sockaddr)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError as error:
                last_error = error
                sock.close()
        if last_error:
            raise last_error
        raise OSError("No public network address was available")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return sha256_bytes(encoded)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_key() -> str:
    key_file = os.environ.get("SUBQ_API_KEY_FILE", "").strip()
    if not key_file:
        raise ValueError("SUBQ_API_KEY_FILE must point to a file containing the API key")
    key = Path(key_file).read_text(encoding="utf-8").strip()
    if not key:
        raise ValueError("SUBQ_API_KEY_FILE points to an empty file")
    return key


def load_cohort(path: Path) -> tuple[dict[str, Any], str]:
    raw_bytes = path.read_bytes()
    try:
        data = json.loads(raw_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Input is not valid JSON: {error}") from error
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
        raise ValueError("Input must be an object with a rows array")
    return data, sha256_bytes(raw_bytes)


def load_questions(
    path: Path, question_names: tuple[str, ...]
) -> tuple[dict[str, Any], str]:
    raw_bytes = path.read_bytes()
    try:
        parsed = json.loads(raw_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Questions file is not valid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError("Questions file must be a JSON object")
    if isinstance(parsed.get("questions"), dict):
        parsed = parsed["questions"]
    missing = [name for name in question_names if name not in parsed]
    if missing:
        raise ValueError(f"Questions file is missing: {', '.join(missing)}")
    questions: dict[str, Any] = {}
    for name in question_names:
        question = parsed[name]
        if (
            not isinstance(question, dict)
            or question.get("type") != "noul"
            or not isinstance(question.get("instructions"), str)
            or not isinstance(question.get("criteria"), dict)
        ):
            raise ValueError(f"Question {name!r} must be a noul question with instructions and criteria")
        questions[name] = question
    return questions, sha256_bytes(raw_bytes)


def jsonl_records(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"Malformed JSONL at {path}:{line_number}: {error}") from error
        if isinstance(record, dict):
            records.append(record)
    return records


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as output:
        output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def resolve_public_addresses(host: str, port: int) -> list[tuple[int, int, int, tuple[Any, ...]]]:
    normalized = host.rstrip(".").lower()
    if normalized == "localhost" or normalized.endswith(".localhost"):
        raise ImageInputError("localhost image URLs are not allowed")
    try:
        literal = ipaddress.ip_address(normalized)
        if not literal.is_global:
            raise ImageInputError("image URL resolves to a non-public address")
        infos = socket.getaddrinfo(str(literal), port, type=socket.SOCK_STREAM)
    except ValueError:
        try:
            infos = socket.getaddrinfo(normalized, port, type=socket.SOCK_STREAM)
        except OSError as error:
            raise ImageInputError(f"image hostname lookup failed ({type(error).__name__})") from error
    except OSError as error:
        raise ImageInputError(f"image hostname lookup failed ({type(error).__name__})") from error

    addresses: list[tuple[int, int, int, tuple[Any, ...]]] = []
    seen: set[tuple[int, str]] = set()
    for family, socktype, proto, _canonical, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        address_text = str(sockaddr[0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(address_text)
        except ValueError as error:
            raise ImageInputError("image hostname returned an invalid address") from error
        if not address.is_global:
            raise ImageInputError("image URL resolves to a non-public address")
        key = (family, address_text)
        if key not in seen:
            seen.add(key)
            addresses.append((family, socktype, proto, sockaddr))
    if not addresses:
        raise ImageInputError("image hostname has no public address")
    return addresses


def identify_image(data: bytes) -> str:
    for _kind, (mime, matches) in MAGIC_MIMES.items():
        if matches(data):
            return mime
    raise ImageInputError("image content is not PNG, JPEG, or WebP")


def verify_with_pillow(data: bytes, mime: str) -> None:
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError:
        return

    expected = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}[mime]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format != expected:
                    raise ImageInputError("image decoder format does not match file signature")
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise ImageInputError("image dimensions exceed the safe decoding limit")
                image.verify()
    except ImageInputError:
        raise
    except Exception as error:  # Pillow's error types vary by format/plugin.
        raise ImageInputError(f"image decode validation failed ({type(error).__name__})") from error


def fetch_image(url: Any) -> tuple[bytes, str, str]:
    if not isinstance(url, str) or not url.strip():
        raise ImageInputError("imageUrl must be a non-empty URL")
    try:
        parsed = urlsplit(url.strip())
        port = parsed.port or 443
    except ValueError as error:
        raise ImageInputError("image URL is malformed") from error
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ImageInputError("image URL must use HTTPS and include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise ImageInputError("image URLs with user information are not allowed")
    host = parsed.hostname.encode("idna").decode("ascii")
    if not 1 <= port <= 65535:
        raise ImageInputError("image URL has an invalid port")
    addresses = resolve_public_addresses(host, port)
    connection = PinnedHTTPSConnection(host, port, addresses, FETCH_TIMEOUT_SECONDS)
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if parsed.query:
        path += "?" + quote(parsed.query, safe="=&?/:@!$'()*+,;%-._~")
    host_header = f"[{host}]" if ":" in host and not host.startswith("[") else host
    if port != 443:
        host_header = f"{host_header}:{port}"
    try:
        connection.request(
            "GET",
            path,
            headers={"Host": host_header, "Accept": "image/png,image/jpeg,image/webp", "Accept-Encoding": "identity"},
        )
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise ImageInputError("image redirects are disabled")
        if response.status != 200:
            raise ImageInputError(f"image server returned HTTP {response.status}")
        if response.getheader("Content-Encoding", "identity").lower() not in ("", "identity"):
            raise ImageInputError("compressed image responses are not accepted")
        content_length = response.getheader("Content-Length")
        if content_length:
            try:
                if int(content_length) > MAX_IMAGE_BYTES:
                    raise ImageInputError("image exceeds the 4 MiB download limit")
            except ValueError:
                pass
        data = response.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            raise ImageInputError("image exceeds the 4 MiB download limit")
        header_mime = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        magic_mime = identify_image(data)
        if header_mime != magic_mime:
            raise ImageInputError("image Content-Type does not match its file signature")
        verify_with_pillow(data, magic_mime)
        return data, magic_mime, sha256_bytes(data)
    except ImageInputError:
        raise
    except (OSError, ssl.SSLError, http.client.HTTPException) as error:
        raise ImageInputError(f"image download failed ({type(error).__name__})") from error
    finally:
        connection.close()


def extract_scores(data: Any, question_names: tuple[str, ...]) -> dict[str, float]:
    if not isinstance(data, dict) or not isinstance(data.get("answers"), dict):
        raise ValueError("response has no answers object")
    scores: dict[str, float] = {}
    for name in question_names:
        answer = data["answers"].get(name)
        raw = answer.get("noul") if isinstance(answer, dict) else None
        if (
            raw is None
            or isinstance(raw, bool)
            or not isinstance(raw, (float, int, str))
            or (isinstance(raw, str) and not raw.strip())
        ):
            raise ValueError(f"response has no usable {name}.noul score")
        value = float(raw)
        if not 0 <= value <= 1:
            raise ValueError(f"response {name}.noul is outside 0..1")
        scores[name] = value
    return scores


def usage_tokens(data: Any) -> dict[str, int | float] | None:
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return None
    result: dict[str, int | float] = {}
    for key, value in usage.items():
        if (
            "token" not in str(key).lower()
            or isinstance(value, bool)
            or not isinstance(value, (int, float))
        ):
            continue
        result[str(key)] = value
    return result or None


def api_call(
    *,
    api_key: str,
    state: Any,
    questions: dict[str, Any],
    question_names: tuple[str, ...],
    image: tuple[bytes, str, str] | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"model": MODEL, "state": state, "questions": questions}
    image_sha: str | None = None
    image_mime: str | None = None
    image_bytes: int | None = None
    if image is not None:
        content, image_mime, image_sha = image
        image_bytes = len(content)
        payload["images"] = [
            {"mediaType": image_mime, "base64": base64.b64encode(content).decode("ascii")}
        ]
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    body_sha = sha256_bytes(body)
    started = time.monotonic_ns()
    usage: dict[str, int | float] | None = None
    resolved_model: str | None = None
    http_status: int | None = None
    try:
        connection = http.client.HTTPSConnection(
            ENDPOINT_HOST, timeout=API_TIMEOUT_SECONDS, context=ssl.create_default_context()
        )
        try:
            connection.request(
                "POST",
                ENDPOINT_PATH,
                body=body,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Content-Length": str(len(body)),
                },
            )
            response = connection.getresponse()
            http_status = response.status
            response_bytes = response.read(2 * 1024 * 1024 + 1)
        finally:
            connection.close()

        if len(response_bytes) > 2 * 1024 * 1024:
            raise ValueError("response exceeded the 2 MiB parsing limit")
        if http_status != 200:
            return {
                "status": "error",
                "httpStatus": http_status,
                "error": f"HTTP {http_status}",
                "scores": {name: None for name in question_names},
                "usageTokens": None,
                "resolvedModel": None,
                "latencyMs": round((time.monotonic_ns() - started) / 1_000_000, 3),
                "serializedBytes": len(body),
                "requestBodySha256": body_sha,
                "imageSha256": image_sha,
                "imageMime": image_mime,
                "imageBytes": image_bytes,
            }
        try:
            parsed = json.loads(response_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("response was not valid JSON") from error
        usage = usage_tokens(parsed)
        if isinstance(parsed, dict) and isinstance(parsed.get("model"), str):
            resolved_model = parsed["model"]
        scores = extract_scores(parsed, question_names)
        return {
            "status": "ok",
            "httpStatus": http_status,
            "error": None,
            "scores": scores,
            "usageTokens": usage,
            "resolvedModel": resolved_model,
            "latencyMs": round((time.monotonic_ns() - started) / 1_000_000, 3),
            "serializedBytes": len(body),
            "requestBodySha256": body_sha,
            "imageSha256": image_sha,
            "imageMime": image_mime,
            "imageBytes": image_bytes,
        }
    except (OSError, ssl.SSLError, http.client.HTTPException, ValueError) as error:
        return {
            "status": "error",
            "httpStatus": http_status,
            "error": str(error)[:300],
            "scores": {name: None for name in question_names},
            "usageTokens": usage,
            "resolvedModel": resolved_model,
            "latencyMs": round((time.monotonic_ns() - started) / 1_000_000, 3),
            "serializedBytes": len(body),
            "requestBodySha256": body_sha,
            "imageSha256": image_sha,
            "imageMime": image_mime,
            "imageBytes": image_bytes,
        }


def row_call_key(cohort_hash: str, experiment_hash: str, row_id: str, mode: str) -> str:
    material = json.dumps(
        [cohort_hash, experiment_hash, row_id, mode], separators=(",", ":")
    ).encode("utf-8")
    return sha256_bytes(material)


def pair_key(cohort_hash: str, experiment_hash: str, row_id: str) -> str:
    material = json.dumps(
        [cohort_hash, experiment_hash, row_id, "paired_comparison"],
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256_bytes(material)


def append_pair_if_ready(
    *,
    output: Path,
    cohort_hash: str,
    experiment_hash: str,
    row_id: str,
    state_hash: str,
    text_key: str,
    image_key: str,
    successful_calls: dict[str, dict[str, Any]],
    existing_pairs: set[str],
) -> None:
    key = pair_key(cohort_hash, experiment_hash, row_id)
    if key in existing_pairs or text_key not in successful_calls or image_key not in successful_calls:
        return
    text_record = successful_calls[text_key]
    image_record = successful_calls[image_key]
    text_scores = text_record.get("scores", {})
    image_scores = image_record.get("scores", {})
    delta = {
        name: float(image_scores[name]) - float(text_scores[name])
        for name in IMAGE_QUESTION_NAMES
    }
    append_jsonl(
        output,
        {
            "recordType": "comparison",
            "formatVersion": FORMAT_VERSION,
            "cohortHash": cohort_hash,
            "experimentHash": experiment_hash,
            "pairKey": key,
            "rowId": row_id,
            "stateSha256": state_hash,
            "imageSha256": image_record.get("imageSha256"),
            "imageMime": image_record.get("imageMime"),
            "imageBytes": image_record.get("imageBytes"),
            "textOnlyScores": text_scores,
            "withImageScores": image_scores,
            "scoreDeltaWithImageMinusText": delta,
            "interpretation": "paired modality response shift; no quality truth labels",
            "recordedAt": utc_now(),
        },
    )
    existing_pairs.add(key)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Frozen cohort JSON with row states")
    parser.add_argument("output", type=Path, help="Append-only JSONL results path")
    parser.add_argument("--questions", required=True, type=Path, help="JSON export of the relevant decision questions")
    parser.add_argument("--text-only", action="store_true", help="Run profile-free candidate states without fetching images")
    parser.add_argument("--limit", type=int, default=12, help="Maximum rows: 1..12 with images, or 1..80 with --text-only")
    args = parser.parse_args()
    maximum = 80 if args.text_only else MAX_ROWS
    if not 1 <= args.limit <= maximum:
        parser.error(f"--limit must be between 1 and {maximum}")
    return args


def run() -> int:
    args = parse_args()
    cohort, cohort_hash = load_cohort(args.input)
    question_names = TEXT_ONLY_QUESTION_NAMES if args.text_only else IMAGE_QUESTION_NAMES
    questions, questions_hash = load_questions(args.questions, question_names)
    api_key = read_key()
    experiment_metadata: dict[str, Any] = {
        "formatVersion": FORMAT_VERSION,
        "evaluationKind": (
            "profile-free cached-candidate text-only signals; no truth labels"
            if args.text_only
            else "paired text-only versus one-image modality ablation; no truth labels"
        ),
        "endpoint": f"https://{ENDPOINT_HOST}{ENDPOINT_PATH}",
        "model": MODEL,
        "questionNames": list(question_names),
        "questionsSha256": questions_hash,
    }
    if args.text_only:
        experiment_metadata["mode"] = "profile_free_text_only"
    else:
        experiment_metadata.update(
            {
                "imageLimitBytes": MAX_IMAGE_BYTES,
                "imageTypes": ["image/png", "image/jpeg", "image/webp"],
            }
        )
    experiment_hash = sha256_json(experiment_metadata)
    prior = jsonl_records(args.output)
    completed = {
        str(record["callKey"])
        for record in prior
        if record.get("recordType") == "call"
        and record.get("cohortHash") == cohort_hash
        and record.get("experimentHash") == experiment_hash
        and record.get("status") == "ok"
        and isinstance(record.get("callKey"), str)
    }
    successful_calls = {
        str(record["callKey"]): record
        for record in prior
        if record.get("recordType") == "call"
        and record.get("cohortHash") == cohort_hash
        and record.get("experimentHash") == experiment_hash
        and record.get("status") == "ok"
        and isinstance(record.get("callKey"), str)
    }
    existing_pairs = {
        str(record["pairKey"])
        for record in prior
        if record.get("recordType") == "comparison"
        and record.get("cohortHash") == cohort_hash
        and record.get("experimentHash") == experiment_hash
        and isinstance(record.get("pairKey"), str)
    }

    selected_rows = (
        [row for row in cohort["rows"] if isinstance(row, dict)]
        if args.text_only
        else [
            row
            for row in cohort["rows"]
            if isinstance(row, dict)
            and isinstance(row.get("imageUrl"), str)
            and row["imageUrl"].strip()
        ]
    )
    selected_rows = selected_rows[: args.limit]
    append_jsonl(
        args.output,
        {
            "recordType": "run",
            "formatVersion": FORMAT_VERSION,
            "cohortHash": cohort_hash,
            "experimentHash": experiment_hash,
            "experimentMetadata": experiment_metadata,
            "startedAt": utc_now(),
            "rowLimit": args.limit,
            "rowsRequested": len(selected_rows),
            "cohortProvenance": cohort.get("provenance"),
        },
    )

    failures = 0
    fatal_error: str | None = None
    for index, row in enumerate(selected_rows):
        row_id = str(row.get("id", "")).strip()
        if not row_id:
            append_jsonl(
                args.output,
                {
                    "recordType": "skip",
                    "cohortHash": cohort_hash,
                    "experimentHash": experiment_hash,
                    "rowIndex": index,
                    "reason": "row has no id",
                    "recordedAt": utc_now(),
                },
            )
            continue
        if "state" not in row:
            append_jsonl(
                args.output,
                {
                    "recordType": "skip",
                    "cohortHash": cohort_hash,
                    "experimentHash": experiment_hash,
                    "rowId": row_id,
                    "reason": "image row has no state",
                    "recordedAt": utc_now(),
                },
            )
            continue

        state_hash = sha256_json(row["state"])
        if args.text_only:
            state = row["state"]
            if (
                not isinstance(state, dict)
                or set(state) != {"candidate"}
                or not isinstance(state.get("candidate"), dict)
            ):
                append_jsonl(
                    args.output,
                    {
                        "recordType": "skip",
                        "formatVersion": FORMAT_VERSION,
                        "cohortHash": cohort_hash,
                        "experimentHash": experiment_hash,
                        "rowId": row_id,
                        "reason": "--text-only requires state to contain only a candidate object",
                        "recordedAt": utc_now(),
                    },
                )
                continue

            call_key = row_call_key(
                cohort_hash, experiment_hash, row_id, "profile_free_text_only"
            )
            if call_key in completed:
                continue
            result = api_call(
                api_key=api_key,
                state=state,
                questions=questions,
                question_names=question_names,
                image=None,
            )
            record = {
                "recordType": "call",
                "formatVersion": FORMAT_VERSION,
                "cohortHash": cohort_hash,
                "experimentHash": experiment_hash,
                "callKey": call_key,
                "rowId": row_id,
                "mode": "profile_free_text_only",
                "stateSha256": state_hash,
                "questionNames": list(question_names),
                "model": MODEL,
                "endpoint": f"https://{ENDPOINT_HOST}{ENDPOINT_PATH}",
                "recordedAt": utc_now(),
                **result,
            }
            append_jsonl(args.output, record)
            if result["status"] == "ok":
                completed.add(call_key)
            else:
                failures += 1
            print(
                f"{result['status'].upper()} row={row_id} mode=profile_free_text_only "
                f"latency={result['latencyMs']}ms bytes={result['serializedBytes']}"
                + (f" error={result['error']}" if result["error"] else "")
            )
            if result["httpStatus"] in (401, 402, 403):
                fatal_error = f"SubQ returned HTTP {result['httpStatus']}; stopped before further calls"
                break
            continue

        text_key = row_call_key(cohort_hash, experiment_hash, row_id, "text_only")
        image_key = row_call_key(cohort_hash, experiment_hash, row_id, "with_image")
        need_text = text_key not in completed
        need_image = image_key not in completed
        if not need_text and not need_image:
            append_pair_if_ready(
                output=args.output,
                cohort_hash=cohort_hash,
                experiment_hash=experiment_hash,
                row_id=row_id,
                state_hash=state_hash,
                text_key=text_key,
                image_key=image_key,
                successful_calls=successful_calls,
                existing_pairs=existing_pairs,
            )
            continue

        try:
            image_content = fetch_image(row.get("imageUrl"))
        except ImageInputError as error:
            append_jsonl(
                args.output,
                {
                    "recordType": "skip",
                    "formatVersion": FORMAT_VERSION,
                    "cohortHash": cohort_hash,
                    "experimentHash": experiment_hash,
                    "rowId": row_id,
                    "reason": str(error),
                    "recordedAt": utc_now(),
                },
            )
            print(f"SKIP row={row_id}: {error}")
            continue

        for mode, key, image in (
            ("text_only", text_key, None),
            ("with_image", image_key, image_content),
        ):
            if mode == "text_only" and not need_text:
                continue
            if mode == "with_image" and not need_image:
                continue
            result = api_call(
                api_key=api_key,
                state=row["state"],
                questions=questions,
                question_names=question_names,
                image=image,
            )
            record = {
                "recordType": "call",
                "formatVersion": FORMAT_VERSION,
                "cohortHash": cohort_hash,
                "experimentHash": experiment_hash,
                "callKey": key,
                "rowId": row_id,
                "mode": mode,
                "stateSha256": state_hash,
                "questionNames": list(question_names),
                "model": MODEL,
                "endpoint": f"https://{ENDPOINT_HOST}{ENDPOINT_PATH}",
                "recordedAt": utc_now(),
                **result,
            }
            append_jsonl(args.output, record)
            if result["status"] == "ok":
                completed.add(key)
                successful_calls[key] = record
            else:
                failures += 1
            print(
                f"{result['status'].upper()} row={row_id} mode={mode} "
                f"latency={result['latencyMs']}ms bytes={result['serializedBytes']}"
                + (f" error={result['error']}" if result["error"] else "")
            )
            if result["httpStatus"] in (401, 402, 403):
                fatal_error = f"SubQ returned HTTP {result['httpStatus']}; stopped before further calls"
                break
        if fatal_error:
            break
        append_pair_if_ready(
            output=args.output,
            cohort_hash=cohort_hash,
            experiment_hash=experiment_hash,
            row_id=row_id,
            state_hash=state_hash,
            text_key=text_key,
            image_key=image_key,
            successful_calls=successful_calls,
            existing_pairs=existing_pairs,
        )

    if fatal_error:
        print(f"evaluate-decision-images: {fatal_error}", file=sys.stderr)
        return 1
    if failures:
        print(
            f"evaluate-decision-images: {failures} API call(s) failed and were recorded; rerun to resume",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except (OSError, ValueError) as error:
        print(f"evaluate-decision-images: {error}", file=sys.stderr)
        raise SystemExit(1)

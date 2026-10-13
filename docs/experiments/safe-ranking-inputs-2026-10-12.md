# Conservative ranking input cleanup — October 12, 2026

Production scoring for either Jev or SubQ now removes null values, blank strings,
and empty arrays from the full decision state. It also removes excerpt sentences
that repeat an entire summary sentence exactly, allowing only whitespace to
differ. Punctuation, capitalization, numbers, negation, all preference rows, and
all other article text remain intact. Text limits and ranking weights are unchanged.

The experimental compact, minimal, packed, and batch inputs remain offline-only.
Their larger savings did not consistently preserve ranking quality in the original
study. The production helper does not truncate additional text or profile entries.

## Production-data replay

Reused the original study's frozen temporal cohorts and exact `would_open`
question. Compared full inputs with conservatively cleaned inputs on the same
articles and profiles. Models were Jev `jev-1.13.0` and SubQ `subq-snap-preview`.

| Cohort                       | Provider | Full AUC | Cleaned AUC | Full input tokens | Cleaned input tokens | Reduction |
| ---------------------------- | -------- | -------: | ----------: | ----------------: | -------------------: | --------: |
| September 22 cutoff, 58 rows | Jev      |   0.8354 |      0.8410 |           112,150 |              110,896 |     1.12% |
| September 22 cutoff, 58 rows | SubQ     |   0.8264 |      0.8389 |            82,819 |               81,916 |     1.09% |
| September 1 cutoff, 80 rows  | Jev      |   0.7281 |      0.7284 |           149,406 |              145,893 |     2.35% |
| September 1 cutoff, 80 rows  | SubQ     |   0.7431 |      0.7700 |           109,347 |              106,766 |     2.36% |

Both providers returned valid results for every evaluated row. These modest
savings showed no AUC decline in either sampled cohort. This supports enabling
the fact-preserving cleanup, but is not a guarantee or a claim of ranking uplift:
the study uses observational opens/downvotes without impression logs, and the
cohorts overlap.

During review, the first sentence normalizer was tightened to preserve case and
punctuation literally. All 58 states in the later-cutoff cohort and 79 of 80 in
the earlier-cutoff cohort were unchanged; their matching requests' responses were
reused. The one changed earlier-cutoff state was sent again to both models. The
table uses the final literal-normalization state and replacement responses.

Private frozen states, response records, follow-up records, and validation logs:
`/home/steven/.local/share/feed-me-maybe/evaluations/2026-10-12-safe-inputs/`.
The original comparison and its limitations are in
[the SubQ study](subq-snap-2026-10-12.md).

Regression coverage checks no mutation, no added truncation, every preference
retained, exact sentence reuse, punctuation/case differences, decimals, counts,
dates, negation, and preservation of meaningful zero/false values. Provider
tests also exercise malformed response handling and provider switches while
requests are in flight.

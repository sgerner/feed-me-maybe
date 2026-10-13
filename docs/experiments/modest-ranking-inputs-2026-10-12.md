# Additional modest-regression token reductions

The local scorer now strips redundant preference type prefixes and rounds
ordinary preference strengths to two decimals. For example, `{type: 'topic',
value: 'topic:AI', strength: 0.837}` becomes `{type: 'topic', value: 'AI',
strength: 0.84}`. Strengths smaller than 0.01 retain their original precision.
Every preference, evidence count, source count, and article text field remains.
Memory/database labels are unchanged; only the outgoing decision state differs.

This saves another **2.7% for Jev and 3.6% for SubQ** relative to the already
cleaned requests. These changes are local and uncommitted; production remains on
the previously deployed Jev configuration.

## Paired production-data replays

Used the same frozen 58- and 80-article temporal cohorts from the earlier study,
with the unchanged `would_open` question. A conservative acceptance criterion was
no more than a 0.01 AUC decline in either cohort for either provider. The selected
variant satisfied that criterion against both original and fresh controls.

| Cohort                       | Provider | Original cleaned AUC | Fresh cleaned control AUC | Prefix + rounded strengths AUC | Additional input reduction |
| ---------------------------- | -------- | -------------------: | ------------------------: | -----------------------------: | -------------------------: |
| September 22 cutoff, 58 rows | Jev      |               0.8410 |                    0.8243 |                         0.8340 |                      2.72% |
| September 1 cutoff, 80 rows  | Jev      |               0.7284 |                    0.7178 |                         0.7197 |                      2.69% |
| September 22 cutoff, 58 rows | SubQ     |               0.8389 |                    0.8389 |                         0.8500 |                      3.61% |
| September 1 cutoff, 80 rows  | SubQ     |               0.7700 |                    0.7700 |                         0.7731 |                      3.60% |

The largest decline against original controls was 0.00875 AUC (0.88 percentage
points), for Jev. Against fresh controls, the selected variant was higher in all
four comparisons. Unchanged Jev control requests themselves varied by up to
0.0167 AUC, so small gains/losses cannot be attributed confidently to the input
change. These are action-conditioned observational labels on reused, overlapping
cohorts; no production uplift or calibration claim is made.

Combined with the deployed empty-field/exact-duplicate cleanup, total input savings
against the original full payload are approximately **3.8–5.9%**.

## Rejected alternatives

- Stripping prefixes alone saved 2.6–3.5%, but SubQ declined by slightly more than
  0.01 AUC in the earlier cohort against its original control.
- Omitting preference evidence counts saved 16.5–21.2%, but lost up to 0.0472 AUC
  against original controls and up to 0.0347 against fresh controls.
- Limiting positives to ten saved 4.7–6.4%, but lost 0.0347 AUC for SubQ in the
  later cohort. Every dislike was retained, yet the cut still failed the criterion.
- A top-twelve pilot did not remove any rows: these reconstructed profiles have
  eleven positive preferences. Its results are a repeatability observation, not
  evidence that trimming twelve preferences is safe for current profiles.

The larger-savings variants remain experimental helpers and are not used by the
local production scoring path. `buildRankingPreferenceInput` enables only prefix
removal and two-decimal strengths. Its maximum strength change is 0.005, and it
never removes evidence counts or preference rows.

Aggregates are in `modest-ranking-inputs-2026-10-12.json`. Frozen variant inputs
and raw response records are private at:
`/home/steven/.local/share/feed-me-maybe/evaluations/2026-10-12-modest-inputs/`.

To reproduce, transform each original safe full state with
`buildNamedPreferenceInputVariants`, keeping all other row fields, then use the
existing `scripts/evaluate-decisions.ts` runner with `--variants full`. Each
replay makes paid Jev/SubQ API calls; `--summarize` makes none. Models resolved to
`jev-1.13.0` and `subq-snap-preview` throughout.

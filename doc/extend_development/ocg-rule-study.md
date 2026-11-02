# OCG Rule Study

`scripts/study-ocg-rules.mjs` reads MinerU `*_content_list.json` exports, preserving each source block and physical PDF page. Volumes are supplied in order. Page numbering in the printed book may differ from physical PDF pages.

## Run

```sh
node scripts/study-ocg-rules.mjs \
  --source /absolute/path/to/volume-1 \
  --source /absolute/path/to/volume-2 \
  --out /absolute/path/to/local-data/rule-study
```

This only builds the plan and source index. Add `--run` to call NVIDIA DeepSeek; add `--synthesize` to consolidate all completed chapters. `--limit 3` is an optional smoke test; incomplete coverage is explicitly recorded and not synthesized.

Keys are read from `NVIDIA_API_KEY`, `NVIDIA_API_KEY_2`, `NVIDIA_API_KEY_3`, or `~/.workbuddy/nvidia.key`, `nvidia2.key`, `nvidia3.key`. Never place keys in arguments, source, artifacts, or Git. Each key has a two-second minimum request spacing; at most six workers run, with bounded retry/backoff. HTTP 429 is retried without removing the key. Thinking is disabled with NVIDIA's `chat_template_kwargs.thinking=false`; JSON object output is requested.

## Artifacts

- `manifest.json`: ordered input files, fingerprints, physical page ranges and chunk IDs.
- `source-blocks.json`: exact extracted source text, block IDs and page locations, including explicitly unread image markers.
- `chapters/*.json`: model summaries, scopes, preconditions, exceptions, uncertainties and source quotes.
- `progress.json`: completed/failed counts. A rerun reuses valid matching checkpoints and retries missing/invalid ones.
- `knowledge.json`: consolidated rules and explicit extraction completeness, not a claim that every rule was captured or proved correct.
- `synthesis*.json`: cross-chapter checks and references, only produced after every selected chapter is complete.

Frontmatter, contact details and download instructions are not rule chapters and are excluded from model summarization. Cross-volume chapter continuity is retained. Source images are not interpreted by this text-only pipeline.

Quotes must match their referenced input blocks after whitespace normalization. This catches invented citations, not incorrect inference from a real quotation. Generated conclusions remain unreviewed. Historical rules, TCG differences and card-specific examples must not be silently treated as current universal OCG rules. The source is a community reference, not an official rulebook or complete set of card rulings.

Block IDs retain their original positions before headers/footers/page numbers are removed. Non-consecutive IDs do not demonstrate missing pages. Model uncertainty lists can themselves contain unsupported claims of missing material and require review. A rule referring to "this kind of card" also requires checking its preceding section before it can become a general principle.

Keep full artifacts in local runtime data, outside the public repository. Review relevant source paragraphs before distilling short operational checks into the skill prompt. Never auto-replace the production prompt with a model-generated draft.

## Tests

```sh
node test/ocg-study-test.mjs
```

Tests exercise page offsets, cross-volume continuity, chunk coverage, unread images, exact source citations and content-based cache invalidation without network access.

# Rembr System-One evaluation

This harness freezes the existing Rembr decision behaviour before external
decision providers are evaluated. It deliberately keeps fixtures synthetic or
explicitly sanitised and writes generated results to the ignored
`evaluation-results/` directory.

Run the existing-code baseline:

```bash
npm run eval:system-one:baseline
```

The command records the git commit, fixture SHA-256, raw predictions, metrics
and a Markdown report. TypeSafe credentials are not used by this command.

Run the current production-shaped generative components through the configured
OpenAI-compatible route:

```bash
TEXT_GENERATION_PROVIDER=openai-compatible \
LM_STUDIO_BASE_URL=http://127.0.0.1:14000/v1 \
LM_STUDIO_MODEL=<openai-compatible-model> \
npm run eval:system-one:generative-baseline
```

This B1 run is restricted to relationship and contradiction cases in the
development split. It preserves the current Rembr prompts, parsers, timeouts
and deterministic fallbacks.

Run Jev on the development split with the API key held only in the clipboard:

```bash
TYPESAFE_KEY_SOURCE=clipboard \
TYPESAFE_MAX_INPUT_TOKENS=1000000 \
npm run eval:system-one:jev
```

The runner pins `jev-1.13.0`, rejects non-synthetic fixtures, retains response
probabilities and token usage, and stops admitting work at the configured input
token cap. It never writes the API key. Calibration can be selected with
`EVALUATION_SPLIT=calibration`. Locked evaluation additionally requires
`ALLOW_LOCKED_EVALUATION=true` and should only be used after the decision schema
and thresholds have been frozen.

Provider comparisons must use the identical fixture hash. Question design may
use only development and calibration cases; the locked split is held until the
schema and thresholds are frozen.

Run the separately frozen, human-adjudicated boundary pack through the current
implementation first:

```bash
EVALUATION_FIXTURE_SET=boundary npm run eval:system-one:baseline
```

The boundary pack is genericised from Rembr service rules, existing tests and
observed failure contours. It contains no customer text, names, identifiers,
addresses or credentials. It is deliberately marked `sanitised`, so sending it
to a provider requires an additional explicit switch:

```bash
EVALUATION_FIXTURE_SET=boundary \
EVALUATION_SPLIT=locked \
ALLOW_LOCKED_EVALUATION=true \
ALLOW_SANITISED_EVALUATION=true \
TYPESAFE_KEY_SOURCE=clipboard \
TYPESAFE_MAX_INPUT_TOKENS=500000 \
npm run eval:system-one:jev
```

Keep these results under `evaluation-results/system-one-boundary/`; do not
combine them with the original synthetic fixture hash or reports.

To measure the effect of a narrow state envelope without changing the J2
rubric, add `EVALUATION_STATE_ENVELOPE=strip-shared-sentences-v1`. This removes
only exact sentences present on both sides of a relationship or contradiction
pair, and only when each side still contains a distinct sentence. The selected
envelope is recorded in the run manifest.

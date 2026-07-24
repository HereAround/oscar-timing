# OSCAR Timing Dashboard

A focused static dashboard for visualizing OSCAR benchmark timings.

## Live dashboard

<https://speed.oscar-system.org>

## Run locally

From the repository root, run:

```bash
python3 -m http.server
```

Open the URL shown in the terminal. Opening `index.html` directly does not work
because browsers block its JSON request from a `file:` URL.

## Data pipeline

A dedicated benchmark server periodically checks OSCAR for new commits and
benchmarks them in chronological order. It writes `data/timing_summary.json`
and commits that file here; this repository does not fetch benchmark data.

Each data update adds its source CSV under `data/raw/` and regenerates
`data/timing_summary.json`. The raw files are retained as producer inputs and
as the reproducible archive behind the generated summary.

Pushing to `main` deploys only the dashboard, favicon, domain configuration,
and summary JSON to GitHub Pages. The raw benchmark exports remain in Git but
are intentionally excluded from the public Pages artifact.

## License

[MIT](LICENSE)

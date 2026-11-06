# Contributing

## Requirements

- Windows 10/11
- Python 3.11
- Node.js 20 or newer for the UI tests
- WebView2 runtime

## Local setup

```powershell
git clone git@github.com:raven-moonfade/readme-live-workspace.git
cd readme-live-workspace
py -3.11 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r requirements-v1.txt
npm install
npx playwright install chromium
```

Start the app with `run_debug.bat` while developing.

To build the standalone Windows package:

```powershell
$env:README_BUILD_PYTHON = "C:\path\to\python-3.11\python.exe"
& $env:README_BUILD_PYTHON -m pip install -r packaging\requirements-build.txt
.\packaging\build-standalone.ps1
```

## Tests

Run the full suite when the change affects shared behavior:

```powershell
& .\.venv\Scripts\python.exe tools\run_all_tests.py
```

Use `--backend-only`, `--ui-only`, `--skip-smoke`, or `--list` for a faster
feedback loop. UI tests write screenshots under `qa/shots/ui/`; this directory
is ignored by Git.

For UI changes, include before/after screenshots at 760, 1024, and 1280 pixels
wide in both light and dark themes when the affected surface supports them.

## Pull requests

- Keep changes focused and describe the user-visible effect.
- Add or update tests for bug fixes and behavior changes.
- Do not commit `config.json`, `config.legacy.json`, `data/`, `logs/`, `cache/`,
  `exports/`, `.venv/`, or `dist/`.
- Do not include real cookies, tokens, room identifiers, or account data in
  fixtures, screenshots, logs, or issue text.
- Run the relevant checks before opening a pull request.

## Commit messages

Use a short imperative subject, for example:

```text
fix: preserve active session state after reconnect
docs: clarify portable installation
```

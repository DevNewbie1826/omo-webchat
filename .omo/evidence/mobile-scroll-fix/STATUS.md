# Baseline capture blocked on dependencies

The harness files are implemented but browser measurements have NOT been verified or captured.

Attempted command:

```sh
bun /Volumes/storage/workspace/cli-webchat-scroll-fix/.omo/evidence/mobile-scroll-fix/harness/run-scroll-qa.mjs --mode baseline
```

It exited 1 at dependency preflight because `frontend/node_modules/@tanstack/virtual-core/dist/esm/index.js` does not exist; the entire `frontend/node_modules` directory is absent. Installing dependencies would exceed this child task's explicit write boundary, which allows only the evidence directory, temporary `.qa-harness`, and temporary virtual-core patch. The parent must provision frontend dependencies before this harness can execute.

`node --check` passed for the runner. LSP diagnostics could not initialize because TypeScript is not installed. No measurement JSON contains fabricated numbers; the only baseline output is the failed-attempt cleanup receipt. No server was started and no virtual-core file was patched. Port 5211 is free and `.qa-harness` is absent.

The evidence directory is ignored by existing git rules, so ordinary `git status --short` does not list these files. Nothing was staged, committed, or pushed.

Fixture assumptions: cadence is based on assistant ordinals (not raw even/odd row indices), so assistant rows actually cycle through all four paragraph counts. Images are at indices 41,83,125,167,209,251,293. Text placeholders are replaced with real inline SVG image blocks by `__loadImages()`. M5 uses loaded images and retains the constant 80px comparator in both modes. M2 exercises the forced iOS branch of desktop WebKit, not physical iOS hardware.

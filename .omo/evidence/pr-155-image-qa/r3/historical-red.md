# Image display QA: FAIL

Real Google Chrome, headless, 1280x800. A fresh browser context was created for each check, carrying only login storage. Real omo provider/model responded; no mocked engine or network responses.

Setup: bun install and make build succeeded (install.log, build.log). Server bound 127.0.0.1:18087 with isolated state under this evidence directory. Workspace was rooted at /Volumes/storage/workspace/cli-webchat-image-display; test-display.png was temporarily copied there as explicitly requested, then removed.

## RED
1. FAIL: live read completed, expanded disclosure showed only `Read image file [image/png]`, no image. `.th-chat-tool-media img` did not appear within the bounded 15-second wait after tool completion. Screenshot: /tmp/webchat-image-qa/check1.png. DOM: check1-dom.txt. No page errors or media requests observed.

## GREEN (other checks, not a fix of RED)
2. PASS: fresh context, entered chat, reloaded and queried current live DOM. Image decoded with complete=true, naturalWidth=640, naturalHeight=400; two hydrated tool cards. Screenshot: /tmp/webchat-image-qa/check2.png. DOM: check2-dom.txt.
3. PASS: actual plain-text exchange produced exactly IMAGE_QA_TEXT_OK. Screenshot: /tmp/webchat-image-qa/check3.png. DOM: check3-dom.txt.
4. PASS: fresh context, expanded hydrated card, collapsed (aria-expanded=false), then expanded and decoded image again; zero page errors. Screenshots: /tmp/webchat-image-qa/check4-collapsed.png and /tmp/webchat-image-qa/check4.png. DOM: check4-dom.txt.

Machine evidence: /tmp/webchat-image-qa/results.json. All four final PNG signatures and 1280x800 dimensions validated with file and opened for visual inspection.

Important contract discrepancy: hydrated images have data:image/png;base64 sources and no /media requests were observed. These successful hydration checks do NOT verify the requested image_ref lazy-fetch path. Live display is a blocking product failure. No product edits were made to repair it. Independent dual-oracle dispatch was unavailable in this child's toolset; no full visual-QA completion certification is claimed.

Earlier automation errors: create.mjs initially matched two New Workspace buttons; corrected selector to first. Initial check1.mjs used the wrong tool class and timed out; all.mjs uses the actual .th-tool-head and independently reproduces the missing live image after real read completion. The four final check PNGs are from all.mjs, not these earlier attempts.

Cleanup receipt: server PID 23715 received SIGTERM; subsequent ps showed no process and lsof showed no listener on 18087. Temporary worktree-root test-display.png removed. Browser instances closed in finally blocks. Build/install outputs are the explicitly requested setup artifacts; no pre-existing files were deleted. No commits or pushes.

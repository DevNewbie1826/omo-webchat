# omo-webchat showreel

A 15-second introduction film for omo-webchat: 1920x1080, 60 fps, H.264 with AAC audio.

**[Watch `omo-webchat-showreel.mp4`](omo-webchat-showreel.mp4)**

## How it is made

Picture and sound share one clock:

- `music.py` synthesizes the original score (128 BPM, F minor, 32 beats = 15.0 s) from
  oscillators and seeded noise, so the track is ours to ship and regenerates byte-for-byte.
  While it arranges the sounds it writes `beatmap.json`, a list of every hit (kicks, claps,
  impacts, the four theme inversions, the snare roll, the final button).
- `scene.html` draws every frame as a pure function of time, `window.__seek(t)`. Each cut,
  inversion and pop is placed on a cue read from `beatmap.json`, so the motion lands on the
  music by construction.
- `render.mjs` serves the page, captures each frame with `Bun.WebView` at 2x (3840x2160,
  downscaled with Lanczos for clean edges), blends two sub-frames per frame for motion blur,
  and muxes the result with the score through ffmpeg.

The screens in `assets/` are app captures with fictional demo data (both themes).

## Regenerate

Requirements: macOS (the WebKit backend of `Bun.WebView`), Bun 1.4+, Python 3 with NumPy,
and ffmpeg with libx264.

```sh
bun docs/showreel/render.mjs                                      # full render (~20 min)
bun docs/showreel/render.mjs --fps 30 --shutter 1 --out /tmp/d.mp4  # quick draft
bun docs/showreel/render.mjs --from 11 --to 13.5 --out /tmp/c.mp4   # one section
bun docs/showreel/render.mjs --stills 2,6.5,13.8                  # PNG stills for review
```

The score alone: `python3 docs/showreel/music.py /tmp/score.wav docs/showreel/beatmap.json`.

#!/usr/bin/env bun
// Renders docs/showreel/omo-webchat-showreel.mp4 from scene.html + music.py.
//   bun docs/showreel/render.mjs                 full render
//   bun docs/showreel/render.mjs --stills 2,5.9  PNG stills into $TMPDIR/omo-showreel-stills
//   bun docs/showreel/render.mjs --fps 30 --shutter 1 --out /tmp/draft.mp4   quick draft
//   bun docs/showreel/render.mjs --from 11 --to 13.5 --out /tmp/cut.mp4      one section
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const FPS = Number(opt("fps", 60));
const SHUTTER = Number(opt("shutter", 2));
const OUT = resolve(opt("out", join(HERE, "omo-webchat-showreel.mp4")));
const STILLS = opt("stills", "");
const DURATION = 15;
const FROM = Number(opt("from", 0));
const TO = Number(opt("to", DURATION));

const run = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
};

const work = mkdtempSync(join(tmpdir(), "omo-showreel-"));
const wav = join(work, "music.wav");
await run(["python3", join(HERE, "music.py"), wav, join(HERE, "beatmap.json")]);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = Bun.file(join(ROOT, path));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

const view = new Bun.WebView({ width: 1920, height: 1080, backend: "webkit" });
await view.navigate(`http://127.0.0.1:${server.port}/docs/showreel/scene.html`);
await view.evaluate("window.__boot.then(() => true)");
if (!(await view.evaluate("window.__ready === true"))) throw new Error("scene did not boot");
for (let t = 0; t < DURATION; t += 0.25) {
  await view.evaluate(`window.__seek(${t})`);
  await view.screenshot();
  if (Math.round(t * 4) % 8 === 0) console.log(`warm ${t.toFixed(2)}`);
}
console.log("warm done");

const capture = async (t, format = "png") => {
  await view.evaluate(`window.__seek(${t})`);
  const shotOpts = format === "jpeg" ? { format: "jpeg", quality: 95 } : { format: "png" };
  return new Uint8Array(await (await view.screenshot(shotOpts)).arrayBuffer());
};

try {
  if (STILLS) {
    const dir = join(tmpdir(), "omo-showreel-stills");
    mkdirSync(dir, { recursive: true });
    for (const t of STILLS.split(",").map(Number)) {
      const png = join(dir, `t${t.toFixed(3)}.png`);
      await Bun.write(png, await capture(t));
      console.log(png);
    }
  } else {
    const first = Math.round(FROM * FPS), frames = Math.round(TO * FPS);
    const inRate = FPS * SHUTTER;
    const vf = [
      "scale=1920:1080:flags=lanczos:out_range=tv",
      SHUTTER > 1 ? `tmix=frames=${SHUTTER},select='not(mod(n\\,${SHUTTER}))',setpts=N/${FPS}/TB` : null,
      "format=yuv420p",
    ].filter(Boolean).join(",");
    const ff = Bun.spawn([
      "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(inRate), "-c:v", "mjpeg", "-i", "-",
      "-ss", String(FROM), "-i", wav,
      "-vf", vf, "-r", String(FPS),
      "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "tv",
      "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
      "-t", String(TO - FROM), "-movflags", "+faststart", OUT,
    ], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
    const t0 = performance.now();
    for (let f = first; f < frames; f++) {
      for (let k = 0; k < SHUTTER; k++) {
        const t = (f + (SHUTTER > 1 ? (k / SHUTTER - 0.25) * 0.5 : 0)) / FPS;
        ff.stdin.write(await capture(Math.max(0, t), "jpeg"));
      }
      if (f % 60 === 0) console.log(`frame ${f}/${frames} ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }
    await ff.stdin.end();
    if ((await ff.exited) !== 0) throw new Error("ffmpeg encode failed");
    console.log(`wrote ${OUT}`);
  }
} finally {
  view.close?.();
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
}
process.exit(0);

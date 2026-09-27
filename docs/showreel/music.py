#!/usr/bin/env python3
"""Original score for the omo-webchat showreel.

Everything is synthesized here from oscillators and seeded noise, so the track
is ours to ship and regenerates byte-for-byte. The same arrangement that places
each sound also writes beatmap.json, which the scene reads to place every visual
hit. Picture and sound therefore share one clock and cannot drift.

128 BPM, F minor, 32 beats = exactly 15.0 s.

Usage: python3 music.py <out.wav> <beatmap.json>
"""

import json
import subprocess
import sys
import wave

import numpy as np

SR = 48000
BPM = 128
BEAT = 60.0 / BPM
BAR = 4 * BEAT
DUR = 15.0
N = int(SR * DUR)
RNG = np.random.default_rng(1826)

BUS = {name: [np.zeros(N), np.zeros(N)] for name in ("drums", "music")}
cues = []


def cue(t, kind, label=""):
    cues.append({"t": round(t, 6), "kind": kind, "label": label})


def b(beat):
    return beat * BEAT


def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def noise(n):
    return RNG.standard_normal(n)


def fft_filter(x, lo=0.0, hi=None, slope=0.15):
    """Zero-phase band filter with soft (octave-proportional) edges."""
    n = len(x)
    size = 1 << int(np.ceil(np.log2(max(n, 2))))
    spec = np.fft.rfft(x, size)
    f = np.fft.rfftfreq(size, 1 / SR)
    g = np.ones_like(f)
    if lo > 0:
        g *= 1 / (1 + (lo / np.maximum(f, 1e-3)) ** (1 / slope * 0.5))
    if hi is not None:
        g *= 1 / (1 + (np.maximum(f, 1e-3) / hi) ** (1 / slope * 0.5))
    return np.fft.irfft(spec * g, size)[:n]


def tv_filter(x, fc_of_t, mode="lp", q_oct=1.0):
    """Time-varying filter by overlap-add STFT (for sweeps and risers)."""
    win, hop = 4096, 1024
    w = np.hanning(win)
    pad = np.concatenate([np.zeros(win), x, np.zeros(win)])
    out = np.zeros_like(pad)
    norm = np.zeros_like(pad)
    f = np.fft.rfftfreq(win, 1 / SR)
    ff = np.maximum(f, 1e-3)
    for s in range(0, len(pad) - win, hop):
        t = (s - win + win / 2) / SR
        fc = max(20.0, fc_of_t(max(t, 0.0)))
        if mode == "lp":
            g = 1 / (1 + (ff / fc) ** 4)
        else:
            g = np.exp(-0.5 * (np.log2(ff / fc) / (q_oct / 2)) ** 2)
        seg = np.fft.irfft(np.fft.rfft(pad[s:s + win] * w) * g, win)
        out[s:s + win] += seg * w
        norm[s:s + win] += w * w
    out /= np.maximum(norm, 1e-6)
    return out[win:win + len(x)]


def place(sig, t, gain=1.0, pan=0.0, right=None, bus="drums"):
    i = int(round(t * SR))
    if i >= N:
        return
    left_sig = sig
    right_sig = sig if right is None else right
    n = min(len(left_sig), N - i)
    if n <= 0:
        return
    gl = np.cos((pan + 1) * np.pi / 4) * np.sqrt(2)
    gr = np.sin((pan + 1) * np.pi / 4) * np.sqrt(2)
    BUS[bus][0][i:i + n] += left_sig[:n] * gain * gl
    BUS[bus][1][i:i + n] += right_sig[:n] * gain * gr


def tt(sec):
    return np.arange(int(sec * SR)) / SR



def kick():
    t = tt(0.42)
    freq = 43 + 120 * np.exp(-t / 0.032)
    body = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t / 0.13)
    click = fft_filter(noise(len(t)), 1500, 9000) * np.exp(-t / 0.004) * 0.35
    return np.tanh(1.8 * (body + click)) / np.tanh(1.8)


def clap():
    t = tt(0.4)
    env = np.zeros_like(t)
    for d in (0.0, 0.009, 0.019):
        env += np.where(t >= d, np.exp(-(t - d) / 0.005), 0)
    env += np.where(t >= 0.028, np.exp(-(t - 0.028) / 0.11) * 0.8, 0)
    return fft_filter(noise(len(t)), 900, 6000) * env


def hat(open_=False):
    t = tt(0.25 if open_ else 0.08)
    return fft_filter(noise(len(t)), 7500) * np.exp(-t / (0.09 if open_ else 0.018))


def tick(pitch=1.0):
    t = tt(0.05)
    f = 2400 * pitch
    s = np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2.01 * f * t)
    return s * np.exp(-t / 0.009)


def snare(bright=1.0):
    t = tt(0.22)
    tone = np.sin(2 * np.pi * (185 + 60 * np.exp(-t / 0.01)) * t) * np.exp(-t / 0.045)
    nz = fft_filter(noise(len(t)), 1400 * bright, 9000) * np.exp(-t / 0.07)
    return 0.55 * tone + nz


def crash(sec=2.4):
    t = tt(sec)
    nz = fft_filter(noise(len(t)), 3200, 16000)
    return nz * np.exp(-t / (sec / 3.2)) * (1 - np.exp(-t / 0.002))


def boom(sec=2.2, f0=58):
    t = tt(sec)
    freq = f0 * 0.55 + f0 * np.exp(-t / 0.35)
    s = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t / 0.75)
    s += fft_filter(noise(len(t)), 30, 400) * np.exp(-t / 0.25) * 0.5
    return np.tanh(2.2 * s) / np.tanh(2.2)


def swell(sec):
    t = tt(sec)
    nz = tv_filter(noise(len(t)), lambda x: 500 * (16 ** (x / sec)), "bp", 2.5)
    return nz * (t / sec) ** 2.2


def whoosh(sec=0.6):
    t = tt(sec)
    nz = tv_filter(noise(len(t)), lambda x: 300 + 6000 * np.sin(np.pi * x / sec) ** 2, "bp", 1.6)
    return nz * np.sin(np.pi * t / sec) ** 2


def saw(freq, t):
    return 2 * ((freq * t) % 1.0) - 1


def supersaw(notes, sec, attack=0.004, release=0.18, cutoff=5200, voices=7, detune=0.22):
    t = tt(sec + release)
    left = np.zeros_like(t)
    right = np.zeros_like(t)
    for m in notes:
        for v in range(voices):
            d = (v - (voices - 1) / 2) / ((voices - 1) / 2) * detune
            ph = RNG.random()
            s = saw(midi(m + d), t + ph / midi(m))
            if v % 2:
                left += s
            else:
                right += s
    env = np.minimum(t / attack, 1.0) * np.exp(-np.maximum(t - sec, 0) / (release / 4))
    k = 1 / (len(notes) * voices)
    return fft_filter(left * env * k, 60, cutoff), fft_filter(right * env * k, 60, cutoff)


def pluck(m, sec=0.22):
    t = tt(sec)
    f = midi(m)
    s = np.sign(np.sin(2 * np.pi * f * t)) * 0.6 + saw(f * 1.003, t) * 0.4
    return fft_filter(s * np.exp(-t / 0.07), 150, 3800)


def bass_note(m, sec):
    t = tt(sec)
    f = midi(m)
    s = saw(f, t) * 0.55 + np.sin(2 * np.pi * f * t) * 0.9
    env = np.minimum(t / 0.003, 1) * np.exp(-t / 0.16)
    return fft_filter(s * env, 30, 700)



CHORDS = {
    "Fm": [53, 56, 60, 65],
    "Db": [49, 53, 56, 61],
    "Ab": [51, 56, 60, 63],
    "Eb": [51, 55, 58, 63],
}
ROOT = {"Fm": 29, "Db": 25, "Ab": 32, "Eb": 27}
PROG = ["Fm", "Fm", "Db", "Ab", "Eb", "Fm", "Db", "Fm"]

kicks = []

# Bar 0 - cold open: filtered pad blooming, UI ticks typing, pickup into the hit.
pl, pr = supersaw(CHORDS["Fm"] + [41], BAR + 0.1, attack=0.9, release=0.2, voices=5)
pl = tv_filter(pl, lambda x: 260 * (9 ** min(x / BAR, 1)))
pr = tv_filter(pr, lambda x: 260 * (9 ** min(x / BAR, 1)))
place(pl, 0.0, 0.55, right=pr, bus="music")
for i in range(12):
    t = b(0.5 + i * 0.25)
    place(tick(1.0 + 0.06 * (i % 3)), t, 0.11, pan=0.3 * ((i % 2) * 2 - 1))
    cue(t, "type", str(i))
for i in range(4):
    place(hat(), b(i + 0.5), 0.10, pan=0.25)
place(swell(1.6), BAR - 1.6, 0.30)
for k, s in enumerate((3.25, 3.5, 3.625, 3.75, 3.875)):
    place(snare(1 + 0.1 * k), b(s), 0.22 + 0.06 * k, pan=0.1)
    cue(b(s), "pickup")


def groove_bar(bar, chord, stabs=True, arp=False, clap_on=True, kick_on=True):
    t0 = bar * BAR
    for beat in range(4):
        t = t0 + b(beat)
        if kick_on:
            place(kick(), t, 0.95)
            kicks.append(t)
            cue(t, "kick")
        place(hat(), t + b(0.5), 0.16, pan=0.2)
        place(hat(), t + b(0.25), 0.06, pan=-0.35)
        place(hat(), t + b(0.75), 0.07, pan=0.35)
        if clap_on and beat in (1, 3):
            place(clap(), t, 0.42, pan=-0.05)
            cue(t, "clap")
        place(bass_note(ROOT[chord] + 12, b(0.45)), t + b(0.5), 0.55, bus="music")
        place(bass_note(ROOT[chord] + 12, b(0.2)), t + b(0.75), 0.30, bus="music")
    if stabs:
        for pos in (0, 3, 6, 10, 12):
            sl, sr = supersaw(CHORDS[chord], b(0.22), release=0.12, cutoff=4200)
            place(sl, t0 + b(pos / 4), 0.36, right=sr, bus="music")
            cue(t0 + b(pos / 4), "stab", chord)
    if arp:
        tones = CHORDS[chord] + [CHORDS[chord][1] + 12, CHORDS[chord][2] + 12]
        for i in range(16):
            m = tones[(i * 3) % len(tones)] + 12
            pan = 0.45 if i % 2 else -0.45
            place(pluck(m), t0 + b(i / 4), 0.13, pan=pan, bus="music")
            place(pluck(m), t0 + b(i / 4 + 0.75), 0.05, pan=-pan, bus="music")


def hit(t, big=False, label=""):
    place(boom(2.4 if big else 0.8, 60 if big else 72), t, 0.85 if big else 0.4)
    place(crash(3.0 if big else 1.8), t, 0.30 if big else 0.2, pan=-0.2)
    place(crash(3.0 if big else 1.8), t + 0.011, 0.30 if big else 0.2, pan=0.2)
    cue(t, "impact", label)


# Bar 1 - the logo lands
hit(BAR, label="logo")
groove_bar(1, "Fm", stabs=True)
cue(BAR + b(2), "word", "sub")

# Bars 2-5 - feature run, one theme inversion per bar downbeat
labels = ["invert-light-hero", "invert-dark-dag", "invert-light-split", "invert-dark-mobile"]
for i, bar in enumerate(range(2, 6)):
    t0 = bar * BAR
    place(whoosh(0.55), t0 - 0.42, 0.34, pan=-0.4 + 0.8 * (i % 2))
    hit(t0, label=labels[i])
    cue(t0, "invert", labels[i])
    groove_bar(bar, PROG[bar], stabs=True, arp=bar >= 4)

# Bar 6 - build: roll accelerates, riser climbs, drums fall away before the drop.
t0 = 6 * BAR
for beat in range(2):
    place(kick(), t0 + b(beat), 0.9)
    kicks.append(t0 + b(beat))
    cue(t0 + b(beat), "kick")
place(bass_note(ROOT["Db"] + 12, b(1.4)), t0 + b(0.5), 0.5, bus="music")
pos = 0.0
k = 0
while pos < 3.5 - 1e-9:
    step = 0.5 if pos < 1 else (0.25 if pos < 2 else 0.125)
    place(snare(1.0 + pos * 0.25), t0 + b(pos), 0.16 + 0.1 * pos, pan=0.15 * ((k % 2) * 2 - 1))
    cue(t0 + b(pos), "roll", str(k))
    pos += step
    k += 1
rl, rr = supersaw([65, 72], 3.5 * BEAT, attack=1.2, release=0.05, cutoff=7000, voices=5)
place(tv_filter(rl, lambda x: 500 * (14 ** min(x / (3.5 * BEAT), 1))), t0, 0.4,
      right=tv_filter(rr, lambda x: 500 * (14 ** min(x / (3.5 * BEAT), 1))), bus="music")
place(swell(3.6 * BEAT), t0 + b(0.4), 0.42)
place(whoosh(0.5), t0, 0.3)
hit(t0, label="mosaic")
cue(t0 + b(3.5), "gap", "drop-silence")

# Bar 7 - final drop and lockup, then a tail.
t0 = 7 * BAR
hit(t0, big=True, label="final")
fl, fr = supersaw(CHORDS["Fm"] + [41, 72], 1.4, release=0.5, cutoff=6000)
place(fl, t0, 0.62, right=fr, bus="music")
place(kick(), t0, 1.0)
kicks.append(t0)
cue(t0, "kick")
pl, pr = supersaw(CHORDS["Fm"], DUR - t0, attack=0.25, release=0.01, cutoff=1800, voices=5)
place(pl, t0 + 0.05, 0.28, right=pr, bus="music")
place(bass_note(ROOT["Fm"] + 12, 1.6), t0, 0.7, bus="music")
for beat, m in ((1, 72), (1.5, 75), (2, 77)):
    place(pluck(m, 0.4), t0 + b(beat), 0.16, pan=0.35 if beat != 1.5 else -0.35, bus="music")
place(tick(1.4), t0 + b(2), 0.2)
cue(t0 + b(2), "button", "command")
place(hat(True), t0 + b(2), 0.12)


# Sidechain the melodic bed against every kick so the groove pumps.
duck = np.ones(N)
tn = np.arange(N) / SR
for k in kicks:
    i = int(k * SR)
    seg = tn[i:i + int(0.3 * SR)] - k
    duck[i:i + len(seg)] = np.minimum(duck[i:i + len(seg)], 1 - 0.55 * np.exp(-seg / 0.09))


def reverb(x, sec=1.9, seed=7):
    rng = np.random.default_rng(seed)
    t = tt(sec)
    ir = rng.standard_normal(len(t)) * np.exp(-t / (sec / 5.5))
    ir = fft_filter(ir, 250, 7000)
    ir /= np.sqrt(np.sum(ir ** 2))
    size = 1 << int(np.ceil(np.log2(len(x) + len(ir))))
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:len(x)]
    return y


(dl, dr), (ml, mr) = BUS["drums"], BUS["music"]
ml, mr = ml * duck, mr * duck
mix_l = dl + ml + 0.28 * reverb(ml, seed=7) + 0.1 * reverb(dl, seed=9)
mix_r = dr + mr + 0.28 * reverb(mr, seed=8) + 0.1 * reverb(dr, seed=10)

mix_l = fft_filter(mix_l, 28)
mix_r = fft_filter(mix_r, 28)

fade = np.ones(N)
fl_n = int(0.35 * SR)
fade[-fl_n:] = np.cos(np.linspace(0, np.pi / 2, fl_n)) ** 2
fade[:96] = np.linspace(0, 1, 96)
mix_l *= fade
mix_r *= fade


def limit(l, r, ceiling):
    blk = 32
    n = len(l)
    nb = (n + blk - 1) // blk
    pad = nb * blk - n
    peak = np.maximum(np.abs(np.pad(l, (0, pad))), np.abs(np.pad(r, (0, pad)))).reshape(nb, blk).max(1)
    g = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    g = np.minimum.reduce([np.roll(g, s) for s in (-2, -1, 0, 1, 2)])
    sm = np.empty_like(g)
    cur = 1.0
    rel = np.exp(-1 / (0.06 * SR / blk))
    for i, v in enumerate(g):
        cur = v if v < cur else v + (cur - v) * rel
        sm[i] = cur
    gs = np.interp(np.arange(n), np.arange(nb) * blk + blk / 2, sm)
    return l * gs, r * gs


def loudness(l, r):
    pcm = np.stack([l, r], 1).astype("<f4").tobytes()
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
         "-af", "ebur128=peak=true", "-f", "null", "-"],
        input=pcm, capture_output=True, check=True)
    txt = p.stderr.decode()
    tail = txt[txt.rfind("Summary:"):]
    i_lufs = float(tail.split("I:")[1].split("LUFS")[0])
    return i_lufs


TARGET = -14.0
CEIL = 10 ** (-1.6 / 20)
sat = lambda x: np.tanh(x * 1.2) / 1.2
pre = 0.9 / max(np.abs(mix_l).max(), np.abs(mix_r).max())
out_l, out_r = sat(mix_l * pre), sat(mix_r * pre)
for _ in range(4):
    gain = 10 ** ((TARGET - loudness(*limit(out_l, out_r, CEIL))) / 20)
    out_l, out_r = out_l * gain, out_r * gain
out_l, out_r = limit(out_l, out_r, CEIL)

dither = (np.random.default_rng(99).random((N, 2)) - np.random.default_rng(100).random((N, 2))) / 32768
pcm = np.clip(np.stack([out_l, out_r], 1) + dither, -1, 1)
pcm16 = (pcm * 32767).round().astype("<i2")

wav_path, map_path = sys.argv[1], sys.argv[2]
with wave.open(wav_path, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm16.tobytes())

cues.sort(key=lambda c: (c["t"], c["kind"]))
with open(map_path, "w") as f:
    json.dump({"bpm": BPM, "beat": BEAT, "bar": BAR, "duration": DUR, "cues": cues}, f, indent=1)
    f.write("\n")
print(f"wrote {wav_path} ({DUR}s) and {map_path} ({len(cues)} cues)")

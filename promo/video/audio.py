"""Music and sound effects for the promo, all synthesised here. Reads build/events.json (written by render.js), writes build/audio.wav.
Usage: python3 promo/video/audio.py   (needs numpy and scipy)

The music is a lo-fi loop at 90 BPM in F major (Fmaj9 / Em7 / Dm9 / Cmaj9): electric piano, warm pad, sub bass and soft
drums. Scene changes sit on bar lines, so the drums drop in exactly when the checklist appears (8.0 s).
"""
import json, os, sys
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100
BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build')
ev = json.load(open(os.path.join(BUILD, 'events.json')))
DUR = ev['duration']
N = int((DUR + 0.2) * SR)
rng = np.random.default_rng(7)
BEAT = 60 / 90
BAR = BEAT * 4

def midi(m): return 440.0 * 2 ** ((m - 69) / 12)
def t_(n): return np.arange(n) / SR
def lp(x, f, order=2): return signal.sosfilt(signal.butter(order, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, order=2): return signal.sosfilt(signal.butter(order, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi, order=2): return signal.sosfilt(signal.butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)

def add(buf, at, x, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= buf.shape[1] or i + len(x) <= 0: return
    if i < 0: x = x[-i:]; i = 0
    x = x[: buf.shape[1] - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[0, i:i + len(x)] += x * gain * l * 1.414
    buf[1, i:i + len(x)] += x * gain * r * 1.414

def env(n, a=0.005, d=1.0, rel=0.05):
    t = t_(n)
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-t * d)
    k = int(rel * SR)
    if k and k < n: e[-k:] *= np.linspace(1, 0, k)
    return e

def reverb(x, secs=1.6, decay=3.2, wet=0.25, tone=5000):
    n = int(secs * SR)
    ir = rng.standard_normal((2, n)) * np.exp(-t_(n) * decay)
    ir = np.stack([lp(ir[0], tone), lp(ir[1], tone)])
    ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    out = np.stack([signal.fftconvolve(x[c], ir[c])[: x.shape[1]] for c in range(2)])
    return x * (1 - wet) + out * wet

# ------------------------------------------------------------------ music ------------------------------------------------------------------
CHORDS = {
    'F': ([53, 57, 60, 64, 67], 41),
    'Em': ([52, 55, 59, 62, 66], 40),
    'Dm': ([50, 53, 57, 60, 64], 38),
    'C': ([48, 52, 55, 59, 62], 36),
}
ORDER = ['F', 'Em', 'Dm', 'C']
NBARS = int(np.ceil(DUR / BAR)) + 1
def chord_of(bar):
    if bar >= 16: return 'F'  # the end card resolves home
    return ORDER[(bar - 13) % 4]

def epiano(f, n, vel):
    t = t_(n)
    trem = 1 + 0.12 * np.sin(2 * np.pi * 4.3 * t)
    x = (np.sin(2 * np.pi * f * t) * np.exp(-t * 1.1)
         + 0.35 * np.sin(2 * np.pi * 2 * f * t + 0.3) * np.exp(-t * 2.4)
         + 0.12 * np.sin(2 * np.pi * 3.01 * f * t) * np.exp(-t * 5)
         + 0.05 * np.sin(2 * np.pi * 7.1 * f * t) * np.exp(-t * 14))  # the "tine"
    return x * trem * env(n, 0.004, 0.0, 0.08) * vel

def pad(notes, n):
    t = t_(n)
    x = np.zeros(n)
    for m in notes:
        f = midi(m)
        for det in (-0.12, 0.0, 0.11):
            ff = f * 2 ** (det / 12)
            for h in range(1, 6):
                x += np.sin(2 * np.pi * ff * h * t + rng.uniform(0, 6)) / h
    a = np.minimum(1, t / 0.8) * np.minimum(1, (n - np.arange(n)) / (0.6 * SR))
    return lp(x * a, 1400) / (len(notes) * 6)

def kick(vel=1.0):
    n = int(0.42 * SR); t = t_(n)
    f = 46 + 90 * np.exp(-t * 30)
    ph = 2 * np.cumsum(np.pi * f) / SR
    x = np.sin(ph) * np.exp(-t * 7.5) + 0.25 * lp(rng.standard_normal(n), 2500) * np.exp(-t * 90)
    return x * vel

def snare(vel=1.0):
    n = int(0.3 * SR); t = t_(n)
    noise = bp(rng.standard_normal(n), 900, 5200) * np.exp(-t * 17)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 28)
    return lp(noise * 0.75 + tone * 0.45, 4200) * vel  # dusty, not bright

def hat(vel=1.0, open_=False):
    n = int((0.22 if open_ else 0.06) * SR); t = t_(n)
    x = hp(rng.standard_normal(n), 7000) * np.exp(-t * (14 if open_ else 70))
    return x * vel

def bass(f, n):
    t = t_(n)
    x = np.sin(2 * np.pi * f * t) + 0.18 * np.sin(4 * np.pi * f * t)
    return np.tanh(1.3 * x) * env(n, 0.01, 0.6, 0.06)

keys = np.zeros((2, N)); pads = np.zeros((2, N)); drums = np.zeros((2, N)); bas = np.zeros((2, N))
for bar in range(NBARS):
    b0 = bar * BAR
    if b0 > DUR: break
    name = chord_of(bar)
    notes, root = CHORDS[name]
    final = bar >= 16
    # Pad under everything.
    add(pads, b0, pad(notes, int(BAR * (2.2 if final else 1.02) * SR)), 0.55)
    # Electric piano comping: beat 1, the "and" of 2, beat 4 (lighter). Strummed a little.
    hits = [(0, 1.0, 1.4), (1.5, 0.7, 1.2), (3, 0.5, 1.0)] if not final else [(0, 1.0, 5.0)]
    if bar < 1: hits = [(0, 0.8, 4.0)]
    for beat, vel, length in hits:
        for j, m in enumerate(notes):
            add(keys, b0 + beat * BEAT + j * 0.011, epiano(midi(m), int(length * BEAT * SR + 0.3 * SR), vel * 0.16), pan=-0.35 + j * 0.17)
    # Bass from the drop on.
    if 3 <= bar < 16:
        add(bas, b0, bass(midi(root), int(1.6 * BEAT * SR)), 0.5)
        add(bas, b0 + 2.5 * BEAT, bass(midi(root + (7 if bar % 2 else 12)), int(1.2 * BEAT * SR)), 0.38)
    if bar == 16:
        add(bas, b0, bass(midi(root), int(3.5 * BAR * SR)), 0.5)
    # Drums.
    if 3 <= bar < 16:
        light = 5 <= bar < 7  # a quieter bar or two while the panel is explained
        add(drums, b0, kick(1.0)); add(drums, b0 + 2.5 * BEAT, kick(0.7))
        if bar % 2: add(drums, b0 + 3.25 * BEAT, kick(0.45))
        add(drums, b0 + BEAT, snare(0.55)); add(drums, b0 + 3 * BEAT, snare(0.6))
        for e in range(8):
            sw = 0.07 * BEAT if e % 2 else 0
            v = (0.22 if e % 2 else 0.32) * (0.6 if light else 1) * rng.uniform(0.8, 1.1)
            add(drums, b0 + e * BEAT / 2 + sw, hat(v, open_=(e == 7 and bar % 4 == 3)), pan=0.25)
    elif bar in (1, 2):
        # Before the drop: just a muffled heartbeat kick on 1 and 3.
        add(drums, b0, lp(kick(0.6), 300)); add(drums, b0 + 2 * BEAT, lp(kick(0.45), 300))

# The hook is muffled (like it's lost in the scroll), then opens up at the drop.
cut = np.full(N, 18000.0)
tt = t_(N)
cut[tt < 8.0] = 900 + 1400 * np.clip((tt[tt < 8.0] - 6.0) / 2.0, 0, 1) ** 2
def sweep_lp(x, cutoff, block=512):
    out = np.zeros_like(x)
    zi = None
    for i in range(0, x.shape[1], block):
        sos = signal.butter(2, min(cutoff[i], 18000), 'low', fs=SR, output='sos')
        if zi is None: zi = np.zeros((2, sos.shape[0], 2))
        for c in range(2):
            out[c, i:i + block], zi[c] = signal.sosfilt(sos, x[c, i:i + block], zi=zi[c])
    return out
keys = sweep_lp(keys, cut)
# Level of each part while the full groove plays, to help when rebalancing the mix below.
for name, stem in (('keys', keys), ('pads', pads), ('bass', bas), ('drums', drums)):
    print(f'{name:6s}{20 * np.log10(np.sqrt((stem[:, int(9 * SR):int(30 * SR)] ** 2).mean()) + 1e-9):6.1f} dBFS')
music = keys * 1.0 + pads * 1.3 + bas * 0.5 + drums * 0.68
music = reverb(music, 1.8, 2.6, 0.22)
# Sidechain-ish duck under the kick for a bit of pump.
duck = np.ones(N)
for bar in range(3, 16):
    for beat in (0, 2.5):
        i = int((bar * BAR + beat * BEAT) * SR); n = int(0.25 * SR)
        if i + n < N: duck[i:i + n] *= 1 - 0.18 * np.exp(-t_(n) * 14)
music[:, :] *= duck
# Tape warmth and a little vinyl crackle.
music = np.tanh(music * 1.6) / 1.6
crackle = np.zeros(N)
for i in rng.integers(0, N, int(DUR * 9)): crackle[i] = rng.uniform(-1, 1)
crackle = bp(crackle, 1500, 6000) * 0.5 + lp(rng.standard_normal(N), 1500) * 0.006
music += np.stack([crackle, np.roll(crackle, 37)]) * 0.35

# ------------------------------------------------------------------ sound effects ------------------------------------------------------------------
fx = np.zeros((2, N))
PENTA = [72, 74, 77, 79, 81, 84]

def blip(f0, f1, dur=0.11, vel=1.0):
    n = int(dur * SR); t = t_(n)
    f = f0 + (f1 - f0) * (1 - np.exp(-t * 40))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 32)
    return x * np.minimum(1, t / 0.002) * vel

def click(vel=1.0, tone=2400):
    n = int(0.04 * SR); t = t_(n)
    x = hp(rng.standard_normal(n), 2000) * np.exp(-t * 300) + 0.6 * np.sin(2 * np.pi * tone * t) * np.exp(-t * 160)
    return x * vel

def keypress(vel=1.0):
    n = int(0.05 * SR); t = t_(n)
    x = bp(rng.standard_normal(n), 1200, 5000) * np.exp(-t * rng.uniform(140, 220))
    x += 0.4 * np.sin(2 * np.pi * rng.uniform(500, 800) * t) * np.exp(-t * 200)
    return x * vel

def bell(m, dur=1.2, vel=1.0):
    n = int(dur * SR); t = t_(n); f = midi(m)
    x = np.sin(2 * np.pi * f * t) * np.exp(-t * 3) + 0.4 * np.sin(2 * np.pi * 2.76 * f * t) * np.exp(-t * 7) + 0.2 * np.sin(2 * np.pi * 5.4 * f * t) * np.exp(-t * 12)
    return x * np.minimum(1, t / 0.002) * vel

def whoosh(dur=0.7, lo=300, hi=4500, vel=1.0):
    n = int(dur * SR); t = t_(n)
    noise = rng.standard_normal(n)
    out = np.zeros(n); zi = None
    shape = np.sin(np.pi * t / dur) ** 1.5
    for i in range(0, n, 256):
        k = i / n
        fc = lo + (hi - lo) * np.sin(np.pi * k)
        sos = signal.butter(2, [fc * 0.6, fc * 1.4], 'band', fs=SR, output='sos')
        if zi is None: zi = np.zeros((sos.shape[0], 2))
        out[i:i + 256], zi = signal.sosfilt(sos, noise[i:i + 256], zi=zi)
    return out * shape * vel * 2.2

for e in ev['events']:
    t, ty = e['t'], e['type']
    if ty == 'pop':
        m = PENTA[e.get('n', 0) % len(PENTA)]
        add(fx, t, blip(midi(m) * 0.75, midi(m), 0.14, 0.32), pan=0.35)
        add(fx, t, bell(m + 12, 0.5, 0.05), pan=0.35)
    elif ty == 'tick':
        add(fx, t, click(0.5, 2600)); add(fx, t + 0.01, blip(midi(79), midi(84), 0.12, 0.22))
    elif ty == 'click':
        add(fx, t, click(0.4, 1800))
    elif ty == 'key':
        add(fx, t, keypress(rng.uniform(0.16, 0.26)), pan=rng.uniform(-0.2, 0.2))
    elif ty == 'send':
        add(fx, t, whoosh(0.3, 800, 5000, 0.06)); add(fx, t, blip(midi(76), midi(83), 0.12, 0.2))
    elif ty == 'share':
        add(fx, t, click(0.4, 1800))
        add(fx, t + 0.05, bell(84, 1.4, 0.16), pan=-0.1); add(fx, t + 0.15, bell(91, 1.4, 0.13), pan=0.1)
        add(fx, t + 0.02, whoosh(0.45, 1200, 6000, 0.05))
    elif ty == 'paste':
        add(fx, t, whoosh(0.22, 2000, 7000, 0.08)); add(fx, t + 0.05, blip(midi(72), midi(79), 0.16, 0.28))
    elif ty == 'alert':
        add(fx, t, bell(81, 0.9, 0.16)); add(fx, t + 0.14, bell(77, 1.0, 0.14))
    elif ty == 'whoosh':
        add(fx, t - 0.15, whoosh(0.75, 250, 3500, 0.07))
    elif ty == 'riser':
        # Fast scrolling: scroll-wheel ticks that speed up and slow down with the scroll.
        k0, k1 = 0.35, 3.6
        pos = 0.0
        while pos < k1 - k0:
            u = pos / (k1 - k0)
            rate = 6 + 34 * np.sin(np.pi * u) ** 1.2
            add(fx, k0 + pos, click(0.14 * (0.4 + np.sin(np.pi * u)), 3200), pan=rng.uniform(-0.3, 0.3))
            pos += 1 / rate
        add(fx, 0.2, whoosh(3.6, 200, 2200, 0.015))
    elif ty == 'lift':
        for i in range(4):
            add(fx, t + i * 0.12, blip(midi(67 + i * 3), midi(74 + i * 3), 0.16, 0.18), pan=-0.4 + i * 0.27)
        # ...and they drift away and blur out.
        n = int(1.3 * SR); tt2 = t_(n)
        f = 900 * np.exp(-tt2 * 1.8)
        add(fx, 6.6, np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt2 * 2.2) * 0.06)
        add(fx, 6.8, whoosh(1.0, 1500, 300, 0.05))
    elif ty == 'end':
        n = int(2.5 * SR); tt2 = t_(n)
        boom = np.sin(2 * np.pi * np.cumsum(55 + 40 * np.exp(-tt2 * 8)) / SR) * np.exp(-tt2 * 2.5)
        add(fx, t, boom * 0.32)
        add(fx, t - 0.35, whoosh(0.5, 400, 5000, 0.08))
        for i, m in enumerate([77, 81, 84, 88]):
            add(fx, t + 0.08 + i * 0.07, bell(m, 2.2, 0.06), pan=-0.3 + i * 0.2)

fx = reverb(fx, 1.0, 5, 0.18, 7000)

# ------------------------------------------------------------------ mix ------------------------------------------------------------------
mix = music * 0.62 + fx * 1.0
# Fade in quickly, fade out over the last second.
fi = int(0.05 * SR); mix[:, :fi] *= np.linspace(0, 1, fi)
fo = int(1.2 * SR); end = int(DUR * SR); mix[:, end - fo:end] *= np.linspace(1, 0, fo); mix[:, end:] = 0
mix = mix[:, :end]
# Gentle limiter, then normalise to -1 dBFS peak.
mix /= np.max(np.abs(mix))
mix = np.tanh(mix * 2.4) / np.tanh(2.4)
mix *= 10 ** (-1 / 20) / np.max(np.abs(mix))
wavfile.write(os.path.join(BUILD, 'audio.wav'), SR, (mix.T * 32767).astype(np.int16))
rms = 20 * np.log10(np.sqrt((mix ** 2).mean()))
print(f'wrote audio.wav  {mix.shape[1] / SR:.2f}s  rms {rms:.1f} dBFS')

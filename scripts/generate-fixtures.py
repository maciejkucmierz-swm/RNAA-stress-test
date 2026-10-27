"""Original deterministic audio fixtures. Requires Python 3 and ffmpeg on the host."""
import json
import hashlib
import math
import pathlib
import random
import struct
import subprocess
import wave

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'assets' / 'audio'
ROOT.mkdir(parents=True, exist_ok=True)
RATE = 48000

def wav(name, channels, seconds, sample):
    with wave.open(str(ROOT / (name + '.wav')), 'wb') as output:
        output.setparams((channels, 2, RATE, 0, 'NONE', 'not compressed'))
        output.writeframes(b''.join(struct.pack('<h', max(-32767, min(32767, round(sample(i, ch) * 32767))))
                                  for i in range(round(RATE * seconds)) for ch in range(channels)))

wav('mono', 1, 3, lambda i, ch: 0.3 * math.sin(2 * math.pi * 440 * i / RATE))
wav('stereo', 2, 3, lambda i, ch: 0.3 * math.sin(2 * math.pi * (440 if ch == 0 else 880) * i / RATE))
wav('silence', 1, 3, lambda i, ch: 0)
notes = [261.63, 329.63, 392, 523.25, 392, 329.63]
wav('melody', 1, 3, lambda i, ch: 0.3 * math.sin(2 * math.pi * notes[min(5, int(i / RATE * 2))] * i / RATE)
    * min(1, (i % (RATE // 2)) / 480) * min(1, ((RATE // 2) - (i % (RATE // 2))) / 480))
rng = random.Random(42)
wav('impulse', 1, 0.25, lambda i, ch: (1 if i == 0 else rng.uniform(-1, 1) * math.exp(-i / RATE * 30)))
encodings = {'mp3': ['-c:a', 'libmp3lame', '-b:a', '128k'], 'flac': ['-c:a', 'flac'],
             'ogg': ['-c:a', 'vorbis', '-strict', '-2'], 'opus': ['-c:a', 'libopus'],
             'aac': ['-c:a', 'aac', '-b:a', '128k'], 'm4a': ['-c:a', 'aac', '-b:a', '128k'],
             'mp4': ['-c:a', 'aac', '-b:a', '128k']}
for extension, options in encodings.items():
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(ROOT / 'stereo.wav'), *options,
                    str(ROOT / ('stereo_' + extension + '.' + extension))], check=True)
manifest = {}
for file in sorted(ROOT.iterdir()):
    if file.suffix == '.json': continue
    probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)]))
    stream = probe['streams'][0]
    # Android resource IDs ignore extensions: packaged filenames need unique stems.
    # Keep the public fixture keys unchanged for settings and historical reports.
    logical_name = 'stereo.' + file.suffix[1:] if file.stem == 'stereo_' + file.suffix[1:] else file.name
    manifest[logical_name] = {'duration': float(probe['format']['duration']), 'sampleRate': int(stream['sample_rate']), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                           'channels': stream['channels'], 'bytes': file.stat().st_size}
(ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Generated {len(manifest)} original fixtures in {ROOT}')

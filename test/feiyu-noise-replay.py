"""Replay the reported local waveform; check lead-in hiss and preservation of speech."""
import sys
from pathlib import Path
import numpy as np
import soundfile as sf
root=Path(__file__).resolve().parents[2]/'feiyu/outputs'
original,sr=sf.read(root/'segmented-gentle-original.wav')
target,rate=sf.read(Path(sys.argv[1]) if len(sys.argv)>1 else root/'segmented-gentle.wav')
assert rate==sr and len(target)==len(original), 'cleanup must retain timing'
def rms_db(y): return float(20*np.log10(np.sqrt(np.mean(y*y))+1e-12))
a,b=int(.2*sr),int(1.4*sr)
noise=rms_db(target[a:b]); before=rms_db(original[a:b])
print(f'lead-in noise: {before:.1f} -> {noise:.1f} dBFS')
assert noise < before-12, 'reported lead-in noise has not been reduced by at least 12 dB'
a,b=int(1.7*sr),int(2.4*sr)
assert abs(rms_db(target[a:b])-rms_db(original[a:b]))<.5, 'voiced section changed too much'
assert np.max(np.abs(target))<=1, 'clipping'
print('PASS: lead-in suppression, speech level and timing preserved')

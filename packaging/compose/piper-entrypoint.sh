#!/bin/sh
# The voice is downloaded once, into the volume, the first time the profile starts.
set -eu
voice="${PIPER_VOICE:-fr_FR-siwis-medium}"
if [ ! -f "/voices/${voice}.onnx" ]; then
  python -m piper.download_voices --download-dir /voices "$voice"
fi
exec python -m piper.http_server --data-dir /voices -m "$voice" --host 0.0.0.0 --port 5000

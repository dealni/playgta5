#!/bin/bash
set -eu
cd "$(dirname "$0")"
exec python3 sandbox_local.py

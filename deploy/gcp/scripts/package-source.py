#!/usr/bin/env python3
"""Bundle tracked and untracked source changes without local secrets/build output."""
from pathlib import Path
import subprocess
import sys
import tarfile


ROOT = Path(__file__).resolve().parents[3]
OUTPUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'tmp/gcp-deploy.tar'
ROOT_FILES = {
    '.dockerignore', 'package.json', 'pnpm-lock.yaml',
    'pnpm-workspace.yaml', 'tsconfig.base.json', 'turbo.json',
}
SOURCE_DIRS = {'apps', 'packages', 'scripts', 'deploy'}
EXCLUDE_PARTS = {'node_modules', 'dist', '.next', '.turbo', '__pycache__'}
SECRET_SUFFIXES = {'.pem', '.key', '.p12', '.pfx'}


def include(name: str) -> bool:
    path = Path(name)
    parts = path.parts
    if not parts or any(part in EXCLUDE_PARTS for part in parts):
        return False
    if path.name in {'.env', '.env.production'} or path.suffix in SECRET_SUFFIXES:
        return False
    return name in ROOT_FILES or parts[0] in SOURCE_DIRS


result = subprocess.run(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    cwd=ROOT, check=True, capture_output=True,
)
names = sorted({name.decode('utf-8') for name in result.stdout.split(b'\0') if name})
files = [name for name in names if include(name) and (ROOT / name).is_file()]
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(OUTPUT, 'w', format=tarfile.PAX_FORMAT) as bundle:
    for name in files:
        bundle.add(ROOT / name, arcname=name, recursive=False)
print(f'{OUTPUT}: {len(files)} files, {OUTPUT.stat().st_size} bytes')

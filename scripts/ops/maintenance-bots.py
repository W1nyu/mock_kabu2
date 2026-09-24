#!/usr/bin/env python3
"""Pause bot order generation for the daily trading maintenance window."""
import argparse
import json
import os
from pathlib import Path
import subprocess


STATE = Path(os.environ.get('MAINTENANCE_STATE', '/var/lib/mock-kabu-maintenance'))
GUARD_LATCH = Path('/var/lib/mock-kabu-storage-guard/bots-paused.json')
PROJECT = os.environ.get('COMPOSE_PROJECT_NAME', 'mock-kabu2-prod')
CONTAINER = f'{PROJECT}-bots-1'


def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True, timeout=45).stdout.strip()


def pause():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker = STATE / 'bots.json'
    if marker.exists():
        print('Maintenance pause marker already exists; preserving original bot state')
        return
    try:
        was_running = docker('inspect', '-f', '{{.State.Running}}', CONTAINER) == 'true'
    except subprocess.CalledProcessError:
        was_running = False
    marker.write_text(json.dumps({'was_running': was_running}), encoding='utf-8')
    if was_running:
        docker('stop', '--time', '20', CONTAINER)
    print(f'Maintenance pause: bots were running={was_running}')


def resume():
    marker = STATE / 'bots.json'
    if not marker.exists():
        print('No maintenance pause marker; leaving bots unchanged')
        return
    was_running = json.loads(marker.read_text(encoding='utf-8'))['was_running']
    if GUARD_LATCH.exists():
        print('Storage guard is latched; bots remain paused')
    elif was_running:
        docker('start', CONTAINER)
        print('Maintenance complete; bots restarted')
    else:
        print('Bots were already stopped; leaving them stopped')
    marker.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['pause', 'resume'])
    action = parser.parse_args().action
    if action == 'pause':
        pause()
    else:
        resume()

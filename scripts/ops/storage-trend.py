#!/usr/bin/env python3
"""Summarize the storage guard's real disk samples without extrapolating tiny intervals."""
import argparse
import datetime
import json
from pathlib import Path

GIB = 1024 ** 3
DAY = 24 * 3600


def summarize(samples):
    samples = sorted((s for s in samples if 'time' in s and 'used_bytes' in s and 'free_bytes' in s),
                     key=lambda s: s['time'])
    if not samples:
        raise ValueError('No disk samples found')
    latest = samples[-1]
    result = {
        'sample_count': len(samples),
        'latest_time_utc': datetime.datetime.fromtimestamp(latest['time'], datetime.timezone.utc).isoformat(),
        'used_gib': round(latest['used_bytes'] / GIB, 2),
        'free_gib': round(latest['free_bytes'] / GIB, 2),
        'disk_percent': latest.get('disk_percent'),
        'windows': {},
    }
    for hours in (1, 6, 24):
        target = latest['time'] - hours * 3600
        earlier = min(samples[:-1], key=lambda s: abs(s['time'] - target), default=None)
        if earlier is None:
            continue
        span = latest['time'] - earlier['time']
        if span < hours * 3600 * 0.8 or span > hours * 3600 * 1.2:
            continue
        delta = latest['used_bytes'] - earlier['used_bytes']
        per_day = delta / GIB * DAY / span
        result['windows'][f'{hours}h'] = {
            'actual_hours': round(span / 3600, 2),
            'net_change_gib': round(delta / GIB, 3),
            'projected_gib_per_day': round(per_day, 3),
        }
        if hours == 24 and per_day > 0:
            headroom = 0.85 * (latest['used_bytes'] + latest['free_bytes']) - latest['used_bytes']
            result['days_to_85_percent_at_24h_rate'] = round(max(0, headroom / GIB / per_day), 1)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('path', nargs='?', default='/var/lib/mock-kabu-storage-guard/samples.json')
    args = parser.parse_args()
    print(json.dumps(summarize(json.loads(Path(args.path).read_text(encoding='utf-8'))),
                     ensure_ascii=False, indent=2))

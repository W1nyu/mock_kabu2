#!/usr/bin/env python3
"""Bounded disk/backup telemetry and a latched bot-only emergency brake."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import time

GIB = 1024 ** 3
ROOT = Path(__file__).resolve().parents[2]
STATE = Path(os.environ.get('STORAGE_GUARD_STATE', '/var/lib/mock-kabu-storage-guard'))
PROJECT = os.environ.get('COMPOSE_PROJECT_NAME', 'mock-kabu2-prod')


def run(args, timeout=25):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Command outputs can contain connection details. Do not put them in alerts.
        raise RuntimeError(f'{args[0]} exited {result.returncode}')
    return result.stdout.strip()


def assess(m):
    warnings, critical = [], []
    if m['disk_percent'] >= 85 or m['free_bytes'] <= 6 * GIB:
        critical.append('disk-critical')
    elif m['disk_percent'] >= 75:
        warnings.append('disk-warning')
    if m['inode_percent'] >= 85:
        critical.append('inodes-critical')
    if m.get('backup_age_seconds', 0) >= 12 * 3600:
        critical.append('backup-stale-critical')
    elif m.get('backup_age_seconds', 0) >= 8 * 3600:
        warnings.append('backup-stale')
    if m.get('wal_pending', 0) and m.get('wal_oldest_seconds', 0) >= 900:
        critical.append('wal-archive-stalled')
    elif m.get('wal_pending', 0) and m.get('wal_oldest_seconds', 0) >= 300:
        warnings.append('wal-archive-delayed')
    if m.get('backup_failed'):
        warnings.append('backup-job-failed')
    if m.get('errors'):
        warnings.append('monitor-probe-failed')
    if m.get('hours_to_full') is not None and m['hours_to_full'] < 12:
        warnings.append('disk-growth-warning')
    return sorted(warnings), sorted(critical)


def forecast(samples, current):
    # Never extrapolate from a seconds-long sample. Include at least 30 minutes.
    candidates = [s for s in samples if 1800 <= current['time'] - s['time'] <= 7200]
    if not candidates:
        return None
    old = candidates[0]
    rate = (current['used_bytes'] - old['used_bytes']) / (current['time'] - old['time'])
    return current['free_bytes'] / rate / 3600 if rate > 0 else None


def collect():
    now = time.time()
    fs = os.statvfs('/')
    used = (fs.f_blocks - fs.f_bfree) * fs.f_frsize
    free = fs.f_bavail * fs.f_frsize
    m = dict(time=now, used_bytes=used, free_bytes=free,
             disk_percent=round(100 * used / (used + free), 2),
             inode_percent=round(100 * (fs.f_files - fs.f_ffree) / fs.f_files, 2), errors=[])
    pg = f'{PROJECT}-postgres-1'
    sql = """SELECT json_build_object(
      'db_bytes', pg_database_size(current_database()),
      'wal_bytes', (SELECT coalesce(sum(size),0) FROM pg_ls_waldir()),
      'wal_pending', (SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'),
      'wal_oldest_seconds', (SELECT coalesce(extract(epoch FROM now()-min(modification)),0)
        FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'),
      'archived_count', archived_count, 'archive_failed_count', failed_count
      ) FROM pg_stat_archiver;"""
    try:
        m.update(json.loads(run(['docker', 'exec', '-u', 'postgres', pg, 'sh', '-c',
            'exec psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
            'guard', sql])))
    except Exception as e:
        m['errors'].append('database-probe: ' + type(e).__name__)
    try:
        info = json.loads(run(['docker', 'exec', '-u', 'postgres', pg,
                              'pgbackrest', '--stanza=mock-kabu', '--output=json', 'info']))
        backups = [b for stanza in info for b in stanza.get('backup', [])]
        last = max((b['timestamp']['stop'] for b in backups), default=0)
        m['last_backup_epoch'] = last
        m['backup_age_seconds'] = now - last
    except Exception as e:
        m['errors'].append('backup-probe: ' + type(e).__name__)
    try:
        m['backup_failed'] = run(['systemctl', 'show', 'mock-kabu-backup.service',
                                 '--property=Result', '--value']) != 'success'
    except Exception as e:
        m['errors'].append('backup-service-probe: ' + type(e).__name__)
    return m


def save(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', help='enable the bot-only safety brake')
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    history_file = STATE / 'samples.json'
    history = json.loads(history_file.read_text()) if history_file.exists() else []
    m = collect()
    m['hours_to_full'] = forecast(history, m)
    m['warnings'], m['critical'] = assess(m)
    latch = STATE / 'bots-paused.json'
    if args.apply and (m['critical'] or latch.exists()):
        try:
            # Reapply while latched: an unrelated deployment must not undo the brake.
            run(['docker', 'stop', '--time', '20', f'{PROJECT}-bots-1'], timeout=30)
            if not latch.exists():
                save(latch, {'time': m['time'], 'reasons': m['critical']})
        except Exception as e:
            m['errors'].append('bot-stop: ' + type(e).__name__)
            m['critical'].append('bot-stop-failed')
    m['bots_paused_by_guard'] = latch.exists()
    if latch.exists() and 'bots-paused' not in m['warnings']:
        m['warnings'].append('bots-paused')
    history = [s for s in history if m['time'] - s['time'] < 48 * 3600]
    history.append(m)
    save(history_file, history[-2880:])
    save(STATE / 'status.json', m)
    # An optional notification adapter receives sanitized operational counters only.
    adapter = ROOT / 'scripts/ops/storage-notify.py'
    if adapter.exists():
        python = '/opt/mock-kabu-notify/bin/python'
        if not Path(python).exists():
            python = 'python3'
        try:
            result = subprocess.run([python, str(adapter), str(STATE / 'status.json')], timeout=30)
            delivery_failed = result.returncode != 0
        except subprocess.TimeoutExpired:
            delivery_failed = True
        if delivery_failed:
            m['errors'].append('notification-delivery-failed')
            save(STATE / 'status.json', m)
    print(json.dumps(m, ensure_ascii=False))
    return 1 if m['critical'] or m['errors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())

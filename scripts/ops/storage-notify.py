#!/usr/bin/env python3
"""OCI instance-principal alerts. Fail closed on limits; never include DB data."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import time

CONFIG = Path('/etc/mock-kabu/notifications.json')
STATE = Path('/var/lib/mock-kabu-storage-guard/notifications.json')


def decision(status, prior, now, test=False):
    fingerprint = json.dumps([sorted(status.get('critical', [])),
                              sorted(status.get('warnings', [])),
                              sorted(status.get('errors', []))])
    active = any(status.get(k) for k in ('critical', 'warnings', 'errors'))
    month = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime('%Y-%m')
    count = prior.get('attempts', 0) if prior.get('month') == month else 0
    if count >= 100:
        return False, fingerprint, month, count
    changed = fingerprint != prior.get('fingerprint')
    needed = test or (active and (changed or now-prior.get('sent_at', 0) >= 21600))
    needed = needed or (not active and prior.get('active', False))
    # Every attempt, including errors and ambiguous timeouts, consumes the cap.
    return needed and now-prior.get('attempt_at', 0) >= 3600, fingerprint, month, count


def save(state):
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state), encoding='utf-8')
    os.chmod(tmp, 0o600)
    tmp.replace(STATE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('status')
    parser.add_argument('--test', action='store_true')
    args = parser.parse_args()
    if not CONFIG.exists():
        print('Notifications not configured')
        return 0
    config = json.loads(CONFIG.read_text())
    if not config.get('enabled'):
        return 0
    status = json.loads(Path(args.status).read_text())
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with STATE.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        prior = json.loads(STATE.read_text()) if STATE.exists() else {}
        now = time.time()
        send, fingerprint, month, count = decision(status, prior, now, args.test)
        if not send:
            return 0
        prior.update(month=month, attempts=count+1, attempt_at=now)
        save(prior)
        try:
            import oci
            signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
            client = oci.ons.NotificationDataPlaneClient(
                {'region': config['region']}, signer=signer,
                service_endpoint=config['endpoint'], timeout=(5, 10),
                retry_strategy=oci.retry.NoneRetryStrategy())
            details = {key: status.get(key) for key in (
                'disk_percent', 'free_bytes', 'backup_age_seconds', 'wal_pending',
                'wal_oldest_seconds', 'bots_paused_by_guard', 'warnings', 'critical', 'errors')}
            active = any(status.get(k) for k in ('critical', 'warnings', 'errors'))
            title = 'jobradar.my ' + ('notification test' if args.test else 'storage alert' if active else 'storage recovered')
            client.publish_message(config['topic_id'], oci.ons.models.MessageDetails(
                title=title, body=json.dumps(details, ensure_ascii=False, indent=2)),
                retry_strategy=oci.retry.NoneRetryStrategy())
            prior.update(fingerprint=fingerprint, active=active, sent_at=now)
            save(prior)
            print('OCI alert published')
            return 0
        except Exception as exc:
            print('OCI notification failed: ' + type(exc).__name__)
            return 1


if __name__ == '__main__':
    raise SystemExit(main())

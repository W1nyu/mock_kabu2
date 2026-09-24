"""Aggregate bounded JSON Caddy access logs without printing addresses or URLs."""
import json
import math
import sys
from collections import Counter

minutes = int(sys.argv[1])
durations, statuses, clients = [], Counter(), set()
size = invalid = 0
for line in sys.stdin:
    try:
        row = json.loads(line)
    except (ValueError, TypeError):
        invalid += 1
        continue
    if not str(row.get('logger', '')).startswith('http.log.access'):
        continue
    durations.append(float(row.get('duration', 0)) * 1000)
    statuses[str(row.get('status'))] += 1
    size += int(row.get('size', 0))
    clients.add(row.get('request', {}).get('remote_ip'))
durations.sort()
def percentile(p):
    return round(durations[max(0, math.ceil(len(durations) * p) - 1)], 2) if durations else None
print(json.dumps({
    'windowMinutes': minutes, 'completedRequests': len(durations),
    'requestsPerSecondOverWindow': round(len(durations) / (minutes * 60), 2),
    'httpResponseBytes': size, 'p50Ms': percentile(.5), 'p95Ms': percentile(.95),
    'statuses': statuses, 'uniqueRemoteIPs': len(clients - {None}), 'unparsedLogLines': invalid,
    'limitations': 'Retained logs only, capped at 100000 lines. IPs are not people. WebSocket frame bytes and active upgrades are excluded; use network/users.'
}, indent=2))

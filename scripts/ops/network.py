import json
import time

def read():
    result = {}
    with open('/proc/net/dev') as stream:
        for line in stream:
            if ':' not in line:
                continue
            interface, raw = line.split(':', 1)
            interface = interface.strip()
            # Physical/cloud NIC only: avoid counting bridges + veth twice.
            if not interface.startswith(('en', 'eth')):
                continue
            values = raw.split()
            result[interface] = (int(values[0]), int(values[8]))
    return result

before, started = read(), time.monotonic()
time.sleep(2)
after, elapsed = read(), time.monotonic() - started
print(json.dumps({name: {'rxBytesTotalSinceBoot': rx, 'txBytesTotalSinceBoot': tx,
    'rxBytesPerSecond': round((rx - before[name][0]) / elapsed),
    'txBytesPerSecond': round((tx - before[name][1]) / elapsed)}
    for name, (rx, tx) in after.items() if name in before}, indent=2))

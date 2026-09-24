"""Read-only deployed header/nonce regression check, standard library only."""
import re
import sys
import urllib.request
import urllib.error
from html.parser import HTMLParser

class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.scripts.append(dict(attrs))

origin = (sys.argv[1] if len(sys.argv) > 1 else 'https://jobradar.my').rstrip('/')
nonces = []
for path in ['/', '/', '/symbol/KABU', '/orders']:
    request = urllib.request.Request(origin + path, headers={'Accept': 'text/html'})
    with urllib.request.urlopen(request, timeout=15) as response:
        headers, html = response.headers, response.read().decode()
    csp = headers.get('Content-Security-Policy', '')
    match = re.search(r"'nonce-([^']+)'", csp)
    assert match, (path, 'missing nonce CSP')
    script_policy = next(part for part in csp.split(';') if part.strip().startswith('script-src '))
    assert 'unsafe-inline' not in script_policy and 'unsafe-eval' not in script_policy
    assert headers.get('Permissions-Policy') and headers.get('Strict-Transport-Security')
    assert headers.get('X-Content-Type-Options') == 'nosniff'
    assert headers.get('X-Frame-Options') == 'DENY'
    assert headers.get('X-Powered-By') is None
    assert 'no-store' in headers.get('Cache-Control', '')
    parser = Scripts()
    parser.feed(html)
    executable = [s for s in parser.scripts if s.get('type', '') not in ('application/json', 'application/ld+json')]
    assert executable and all(s.get('nonce') == match[1] for s in executable), (path, 'script nonce mismatch')
    nonces.append(match[1])
    print(path, 'headers + script nonces OK')
assert len(nonces) == len(set(nonces)), 'nonce reused across responses'
try:
    urllib.request.urlopen(urllib.request.Request(origin + '/internal/operations',
        headers={'X-Forwarded-For': '127.0.0.1'}), timeout=15)
    raise AssertionError('internal endpoint publicly reachable')
except urllib.error.HTTPError as error:
    assert error.code == 404, error.code
print('nonce uniqueness + internal endpoint isolation OK')

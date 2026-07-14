# mock_kabu2 독립 실행 환경

`mock_kabu2`는 상위 `Project/mock_kabu`와 다음 리소스를 절대 공유하지 않도록 고정되어 있다.

| 리소스 | mock_kabu2 값 |
| --- | --- |
| Web | `http://localhost:3100` |
| API / Socket.IO | `http://localhost:4100` |
| PostgreSQL host port | `55432` |
| Redis host port | `56379` |
| PostgreSQL DB / user | `mock_kabu2` / `kabu2` |
| Docker project / network | `mock-kabu2` / `mock-kabu2-network` |
| Docker volumes | `mock-kabu2-pgdata`, `mock-kabu2-redisdata` |
| Redis keys, streams, groups, locks | `mock-kabu2:` prefix |

The browser bundle is pinned to API port `4100`; it does not inherit a parent shell's `NEXT_PUBLIC_API_URL`. API, bots, and matching engine load only this repository's root `.env`, not `Project/.env`.

## First run

```powershell
Copy-Item .env.example .env
Copy-Item packages/db/.env.example packages/db/.env
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open `http://localhost:3100`. The separate database volume starts empty, so it never modifies data belonging to `mock_kabu`.

## Stop and reset only mock_kabu2

```powershell
pnpm infra:stop
pnpm infra:down
docker compose --project-name mock-kabu2 down -v
```

The final command removes only `mock-kabu2-*` containers, network, and volumes.

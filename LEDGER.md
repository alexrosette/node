# Канал ledger (single-panel образ для bm)

Образ `ghcr.io/alexrosette/node:single-<sha>` — это remnanode 3.4.1 с ядром `raaad1on/Xray-core v26.7.28-custom.1` (blackhole с `statusCode`) от коллеги ([raaad1on/node](https://github.com/raaad1on/node), ветка `custom-xray`).

Одна нода — одна панель, поведение как в upstream. Конфиг ядра присылает только панель. Сверху добавлен канал ledger: статус ноды и рестарт ядра.

Без `LEDGER_SECRET_KEY` нода ведёт себя как upstream.

## Подключение

- `LEDGER_SECRET_KEY` в том же формате, что `SECRET_KEY` панели: `base64(JSON{caCertPem, jwtPublicKey, nodeCertPem, nodeKeyPem})`.
- Ledger ходит на тот же `NODE_PORT`. Контекст TLS выбирается по SNI: `deriveSni(caCertPem, jwtPublicKey)` ключа ledger.
- Любое другое имя — это панель. Если включён `SNI_VERIFICATION`, имя панели проверяется как в upstream.
- Авторизация:
  - mTLS: клиентский сертификат подписан CA из `LEDGER_SECRET_KEY`;
  - `Authorization: Bearer <JWT RS256>` с ключом `jwtPublicKey` из `LEDGER_SECRET_KEY`;
  - claims: `aud = "rw-node-ledger"`, `exp − iat ≤ 60 с`, уникальный `jti`. Повтор `jti` в течение 120 с отвергается.
  - Отказ: 401 и закрытие сокета. Каждый вызов попадает в лог ноды (метод, путь, `jti`).
- Разделение маршрутов:
  - по SNI ledger доступен только `/node/ledger/*`, на остальное 404 и закрытие сокета;
  - панели `/node/ledger/*` недоступен (404).

## Ручки

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/node/ledger/status` | статус ноды, формат ниже |
| POST | `/node/ledger/core/restart` | `{reason?}`: рестарт ядра с конфигом от панели и pre-start хуками плагинов |

Ответ всегда `{"response": …}`.

`GET /node/ledger/status`:

```json
{
  "nodeVersion": "3.4.1",
  "xray": { "online": true, "version": "26.7.28", "uptimeSec": 1909, "restarting": false },
  "panel": { "connected": true, "lastStartAt": "…", "lastRequestAt": "…", "users": 1234 },
  "system": { "cpus": 8, "load1": 0.4, "load5": 0.5, "load15": 0.6,
              "memTotal": 16768593920, "memUsed": 1650000000, "uptimeSec": 740000,
              "iface": "ens3", "rxBps": 733093, "txBps": 90654 }
}
```

- `xray.restarting` — идёт старт или рестарт ядра (от панели или ledger).
- `panel.connected` — панель обращалась к ноде за последние 60 с.
- `panel.users` — уникальные юзеры, которых нода сейчас знает.

`POST /node/ledger/core/restart` → `{ isStarted, error, tookMs, version }`:

- рестарт только с конфигом, который прислала панель. Юзеры, добавленные и удалённые через API после её `start`, учитываются;
- панель ещё не запускала ядро → `isStarted: false`, `error: "Xray Core was not started by the panel yet"`, ядро не трогается;
- идёт `start` от панели → `isStarted: false`, `error: "Request already in progress"`;
- не чаще раза в 10 с, иначе 429;
- остановка ядра ждёт его выхода без дедлайна. Нагруженное ядро может выходить дольше 10 с. Если выход занял больше 10 с, в лог пишется WARN «Xray Core took N s to exit.».

Других ручек нет: ни конфига от ledger, ни `core/stop|start`.

## Отличия от upstream

- Канал ledger (выше).
- Юзеры, добавленные или удалённые через API (`add-user(s)`, `remove-user(s)`), записываются и в сохранённый конфиг ядра. Рестарт без нового конфига от панели (ledger, или s6 поднимает упавшее ядро) стартует с актуальными юзерами. В upstream он стартует с юзерами последнего `start` панели.
- `s6-svc -wd` без `-T`: остановка ядра ждёт его выхода сколько нужно.

## Тесты

```bash
docker build -f docker/Dockerfile -t rwnode:single .
nix shell nixpkgs#nodejs_24 -c sh e2e/single/run.sh
```

Два прогона: без `LEDGER_SECRET_KEY` и с ним. Проверяются поведение панели, сохранённый конфиг после API, авторизация ledger и разделение маршрутов, статус, рестарт и лимит 429.

# MediaScout DE

Online-Arbitrage-Tool fuer physische Produkte in diesen Amazon.de-Kategorien:
Brettspiele, CDs, DVD/Blu-ray, Games, Figuren, Puzzles, Schallplatten und
Modellbau. Der Worker zieht Amazon-Daten ueber
Keepa, sucht passende eBay.de-Angebote per GTIN/EAN/UPC und zeigt moegliche
Deals im Dashboard.

Das Projekt ist bewusst ein eigenstaendiger Scanner und veraendert
`coding-horstmann/ebayamz` nicht.

## Produktlogik

- Keepa Product Finder laeuft auf Amazon.de (`domain=3`).
- Pro Kategorie werden standardmaessig die besten `15000` BSR rotiert.
- Gespeichert und auf eBay gesucht werden nur Produkte mit physischem GTIN/EAN/UPC.
- eBay-Ergebnisse werden nur als neu akzeptiert.
- Games werden zusaetzlich gegen offensichtliche Download-Codes, Gutscheine,
  Konsolen und Zubehoer gefiltert.
- eBay-Suche nutzt `gtin=GTIN`, nicht Titel-Fallback. Das ist die Entsprechung zur
  ISBN-Genauigkeit des Buchscanners.

## Railway

Das Projekt ist fuer Railway ausgelegt:

- Web-Service: Next.js Dashboard und manueller Worker-Start.
- Worker-Service: optionaler Cron-Service mit `npm run railway:worker`.
- Datenbank: Railway Postgres ueber `DATABASE_URL`.
- Das Datenbankschema aus `database/schema.sql` wird beim ersten App- oder
  Worker-Zugriff automatisch angewendet.

## Umgebungsvariablen

Railway setzt `DATABASE_URL` automatisch, wenn der App-Service mit dem
Postgres-Service verbunden ist.

Diese Werte musst du selbst setzen:

| Variable | Zweck |
| --- | --- |
| `EBAY_CLIENT_ID` | eBay Browse API Production Client ID |
| `EBAY_CLIENT_SECRET` | eBay Browse API Production Client Secret |
| `EBAY_MARKETPLACE_ID` | Default `EBAY_DE` |
| `KEEPA_API_KEY` | Keepa API-Key |

Sinnvolle Defaults, koennen aber angepasst werden:

| Variable | Default |
| --- | --- |
| `MIN_AMZ_PRICE` | `20.00` |
| `KEEPA_BSR_TARGET_PER_CATEGORY` | `15000` |
| `KEEPA_BSR_WINDOW` | `3000` |
| `EBAY_API_DELAY_MS` | `1100` |
| `EBAY_DAILY_CALL_RESERVE` | `200` |
| `EBAY_SEARCH_RESULT_LIMIT` | `50` |
| `EBAY_FALLBACK_SCAN_LIMIT` | `1000` |
| `EBAY_BACKLOG_FILL` | `true` |

Keepa-Kategorie-IDs sind als ENV ueberschreibbar:

| Variable | Default |
| --- | --- |
| `KEEPA_BOARD_GAME_CATEGORY_ID` | `360472031` |
| `KEEPA_CD_CATEGORY_ID` | `255882` |
| `KEEPA_DVD_CATEGORY_ID` | `284266` |
| `KEEPA_GAME_CATEGORY_ID` | `300992` |
| `KEEPA_FIGURE_CATEGORY_ID` | `27087992031` |
| `KEEPA_PUZZLE_CATEGORY_ID` | `360541031` |
| `KEEPA_VINYL_CATEGORY_ID` | `255882` |
| `KEEPA_MODEL_KIT_CATEGORY_ID` | `360488031` |

Optional:

| Variable | Zweck |
| --- | --- |
| `MEDIASCOUT_PASSWORD` | Passwortschutz fuer Dashboard und API |

## Commands

```bash
npm install
npm run build
npm run worker
```

Railway Worker:

```bash
npm run railway:worker
```

## Struktur

```text
src/worker/
  categories.ts  # Kategorie-Konfiguration
  keepa.ts       # Keepa Finder + Produktdetails
  ebay.ts        # eBay OAuth, Browse Search, Rate Limits
  sync.ts        # Postgres-Upserts, Backlog, Worker-Runs
  index.ts       # Worker-Orchestrierung
src/app/
  page.tsx       # Dashboard
  admin/         # Worker-Steuerung
  api/           # Produkte und Worker-Status
database/
  schema.sql     # Railway-Postgres-Schema
lib/
  db.ts          # Postgres Pool
  migrate.ts     # Auto-Schema-Anwendung
```

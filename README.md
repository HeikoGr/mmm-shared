# mmm-shared

Gemeinsame JavaScript-Helfer fuer meine MagicMirror-Module.

Wird in jedes Modul als Submodul unter `lib/mmm-shared/` eingebunden und dort
sowohl im Backend (`require`) als auch im Frontend (`getScripts()` →
`globalThis.MMModuleShared`) geladen.

```bash
node --run test
node --run lint   # Biome, dieselbe Konfiguration wie in den Modulen
```

## `createLifecycle({ module, … })`

Der Frontend-Lebenszyklus fuer ein Modul. Er nimmt dem Modul alles ab, was der
MagicMirror-Core **nicht** garantiert:

- `suspend()`/`resume()` sind Callbacks ohne Zustandspruefung und feuern beliebig
  oft — unter `MMM-Carousel` alle paar Sekunden.
- Sie sind nicht paarig: `resume()` ohne vorheriges `suspend()` ist normal.
- `show()` kann bei aktiven `lockStrings` stillschweigend scheitern. Deshalb ist
  `module.hidden` die einzige verlaessliche Wahrheit, nicht ein selbst
  gepflegtes Flag.
- `updateDom()` baut den kompletten DOM auch dann auf, wenn das Modul versteckt
  ist.

### Verantwortung

| # | Punkt | Wirkung |
|---|---|---|
| 1 | `isSuspended()` | `paused \|\| module.hidden \|\| module.data.hidden` |
| 2 | Freshness-Guard | `resume()` holt nur bei `dataAge >= updateInterval` |
| 3 | Idempotenz | Mehrfaches `suspend()`/`resume()` bleibt folgenlos |
| 4 | Guard im Timer-Callback | nicht nur beim Aufsetzen des Timers |
| 5 | Deferred Init | Modul startet versteckt → Retry mit Limit |
| 6 | Tageswechsel | wird ueber einen Suspend hinweg erkannt |
| 7 | Visuelle Arbeit getrennt | `onVisible`/`onVisibleTick` erzeugen nie Traffic |
| 8 | Jitter + `quietHours` | gestaffelte Timer, nachts kein Polling |
| 9 | Rate-Limit + Backoff | ein kaputtes Backend wird nicht pro Zyklus angefragt |

### Der visuelle Tick

`onVisibleTick` laeuft **nur waehrend das Modul sichtbar ist**, aber gegen einen
eigenen Faelligkeitszeitpunkt statt gegen einen bei jedem `resume()` neu
gestarteten Countdown. Das ist bei `MMM-Carousel` zwingend: dessen
`moduleTransition()` versteckt bei jedem Wechsel *alle* Module und zeigt danach
die des naechsten Slides wieder an — auch das Modul, das sichtbar bleibt,
bekommt also pro Zyklus ein `suspend()`/`resume()`-Paar. Ein neu gestarteter
Countdown wuerde bei `transitionInterval: 10000` und einem 30-s-Tick nie
ablaufen. Ist der Tick waehrend des Versteckens faellig geworden, feuert er
beim `resume()` sofort.

### Hintergrund-Refresh

Standardmaessig (`backgroundRefresh: true`) laeuft der Fetch-Timer **unabhaengig
von der Sichtbarkeit** weiter. Damit haengt die Zahl der Requests nur noch am
`updateInterval` — Ein- und Ausblenden durch Carousel kann den Traffic
strukturell nicht mehr verstaerken, und beim Einblenden liegen die Daten bereits
vor. Mit `backgroundRefresh: false` stoppt der Timer beim Verstecken; er wird
beim `resume()` mit der **verbleibenden** Restzeit neu gesetzt, damit ein
Hide/Show-Zyklus das Intervall nicht zurueckdrehen kann.

### Verwendung

```js
start() {
  this.shared = globalThis.MMModuleShared;
  // … transport/logger aufsetzen …

  this.lifecycle = this.shared.createLifecycle({
    module: this,
    logger: this.logger,
    updateInterval: this.config.updateInterval,
    minUpdateInterval: 60 * 1000,
    anchorHour: 7,                 // optional: Raster an eine Uhrzeit binden
    backgroundRefresh: true,
    quietHours: { from: '23:00', to: '06:00' },
    onFetch: ({ reason }) => this.requestUpdate(reason),
  });
  this.lifecycle.start();
},

suspend() { this.lifecycle.suspend(); },
resume()  { this.lifecycle.resume(); },

socketNotificationReceived(notification, payload) {
  // … Daten uebernehmen …
  this.lifecycle.markDataReceived();
  this.lifecycle.render(this.config.animationSpeed);  // statt updateDom()
}
```

### API

| Methode | Zweck |
|---|---|
| `start(reason?)` | Einmal aus `start()` des Moduls |
| `suspend(reason?)` / `resume(reason?)` | Direkt aus den Core-Callbacks |
| `markDataReceived(ts?)` | Frische Daten angekommen — setzt den Freshness-Guard |
| `markFetchFailed()` | Fehlgeschlagener Fetch — erhoeht den Backoff |
| `requestFetch(reason, { force })` | Fetch ausserhalb des Timers (z. B. Nutzeraktion) |
| `render(speed?)` | `updateDom()` mit Aussetzer, solange versteckt; wird beim `resume()` nachgeholt |
| `isSuspended()` / `isVisible()` / `getDataAge()` | Abfragen |
| `stop()` | Alle Timer abraeumen (Tests, eigenes Teardown) |
| `getState()` | Diagnose-Snapshot |

### Optionen

`module` (Pflicht), `logger` (Objekt mit `debug/info/warn/error`) **oder** `log`
(Funktion `(level, message)`), `updateInterval` / `getUpdateInterval`,
`minUpdateInterval`, `jitterRatio`, `backgroundRefresh`, `quietHours`,
`anchorHour`, `startDelay`, `retryInterval`, `maxRetryInterval`, `onFetch`,
`onVisible`, `onHidden`, `onVisibleTick` + `visibleTickInterval`, `onDayChange`,
`onSessionState`, `deferredInit`, `getDayKey`, sowie `now`, `timers` und
`random` zur Injektion in Tests.

### Retry nach Fehlschlag (ab 0.3.0)

`markFetchFailed()` erhoeht nicht nur den Backoff, sondern plant auch den naechsten
Versuch (`onFetch` mit Grund `retry`) fuer den Zeitpunkt, an dem der Backoff
ablaeuft: 1, 2, 4 … bis `maxRetryInterval` (Default 30 min). Frische Daten
(`markDataReceived()`) und `stop()` raeumen ihn ab; `getState().retryTimerArmed`
zeigt ihn an. Ohne diesen Timer wartete ein Modul mit langem `updateInterval`
nach einem Fehlstart bis zum naechsten regulaeren Termin.

## `stableStringify(value)`

JSON mit sortierten Objektschluesseln — fuer den Vergleich von Configs, die sich
nur in der Schluesselreihenfolge unterscheiden.

## `backend-session.js` (nur Node)

Die Backend-Haelfte des Musters „Config einmal, Backend besitzt die Kadenz"
(`require('./lib/mmm-shared/backend-session')` im `node_helper`):

| Funktion | Zweck |
|---|---|
| `createClientRegistry({ io, namespace, keyOf, onConnect, onMessage, onGone, graceMs })` | ordnet Browser-Sockets den Modulinstanzen zu; Instanz ohne Socket wird nach `graceMs` (10 min) freigegeben; Pause-Zustand pro Socket (`setPaused`, `isPaused`) |
| `createInstanceHub({ moduleName, sendSocketNotification, fetch, lifecycleOptions, criticalKeys, prepareConfig, isFailure, onConfigured })` | ein `createLifecycle()` pro Instanz im Backend |
| `formatLogEntry(entry)` | macht aus einem strukturierten `createLogger`-Eintrag eine Zeile `[identifier] message {context}`; für eine Log-Senke im `node_helper`, die MagicMirrors `Log` aufruft |

Protokoll: Frontend sendet `CONFIGURE` (einmal, `data.config`) und
`SESSION_STATE` (`active`/`paused`); der Hub schickt `DATA`, `FETCH_FAILED`,
`CONFIG_INVALID`, `CONFIG_REJECTED` (nur an den abweichenden Socket) und
`INIT_REQUIRED` (bei jeder neuen Verbindung und bei unbekannter Instanz) als
`<Modul>_EVENT`. `hub.route(action, handler)` bedient modulspezifische Requests
(z. B. Schreibzugriffe) mit Instanz-Config, `RESPONSE`/`ERROR` und
`CONFIG_MISSING`. Ein Fetch pro Instanz; Wuensche waehrend eines laufenden
Fetches laufen danach als Follow-up.

## Verwandte Repositories

- [MMM-CalDAV-Tasks](https://github.com/HeikoGr/MMM-CalDAV-Tasks)
- [MMM-HomeConnect2](https://github.com/HeikoGr/MMM-HomeConnect2)
- [MMM-LibraryMonitor](https://github.com/HeikoGr/MMM-LibraryMonitor)
- [MMM-Photoprism](https://github.com/HeikoGr/MMM-Photoprism)
- [MMM-Webuntis](https://github.com/HeikoGr/MMM-Webuntis)
- [MMM-DevContainer](https://github.com/HeikoGr/MMM-DevContainer)

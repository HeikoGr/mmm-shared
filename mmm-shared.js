(function initMMModuleShared(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.MMModuleShared = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMMModuleShared() {
  const LEVELS = {
    none: -1,
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };

  function normalizeLevel(level, fallback = "info") {
    return Object.hasOwn(LEVELS, level) ? level : fallback;
  }

  function sanitizeForLogging(value, redactedKeys) {
    if (!value || typeof value !== "object") {
      return value;
    }

    const seen = new WeakSet();

    function cloneAndRedact(input) {
      if (!input || typeof input !== "object") {
        return input;
      }

      if (seen.has(input)) {
        return "[Circular]";
      }
      seen.add(input);

      if (Array.isArray(input)) {
        return input.map((item) => cloneAndRedact(item));
      }

      const output = {};
      for (const [key, nested] of Object.entries(input)) {
        const lowered = String(key).toLowerCase();
        if (redactedKeys.some((token) => lowered.includes(token))) {
          output[key] = "***redacted***";
          continue;
        }
        output[key] = cloneAndRedact(nested);
      }

      return output;
    }

    return cloneAndRedact(value);
  }

  /**
   * MagicMirror's Log: window.Log in the browser, require("logger") in a
   * node_helper. It carries the global config.logLevel. Outside MagicMirror
   * (tests, scripts) there is none, and console takes its place.
   */
  function resolveMagicMirrorLog() {
    const candidates = [globalThis.Log];
    if (typeof module === "object" && typeof require === "function") {
      try {
        candidates.push(require("logger"));
      } catch {
        // Not running inside MagicMirror.
      }
    }
    return (
      candidates.find((log) => log && ["debug", "info", "warn", "error"].every((m) => typeof log[m] === "function")) ||
      console
    );
  }

  /**
   * Logger on top of MagicMirror's Log, so the global config.logLevel decides
   * what is written. getLevel() is the module's own logLevel: unset means "the
   * global level alone"; a level narrows it further ("none" silences the module).
   * It cannot widen it - what the global level switches off stays off.
   *
   * @param {object} [options]
   * @param {object} [options.consoleRef] - Output sink; defaults to MagicMirror's Log
   */
  function createLogger({
    moduleName,
    identifier,
    getLevel = () => undefined,
    structured = true,
    redact = true,
    redactedKeys = ["password", "token", "apikey", "secret", "qrcode", "refreshtoken"],
    consoleRef,
  } = {}) {
    let sink = consoleRef;

    function write(level, message, context) {
      const own = String((typeof getLevel === "function" ? getLevel() : getLevel) || "").toLowerCase();
      const current = normalizeLevel(level, "info");
      if (Object.hasOwn(LEVELS, own) && LEVELS[current] > LEVELS[own]) {
        return;
      }

      // Resolved on first use: MagicMirror sets up Log before any module logs.
      sink ??= resolveMagicMirrorLog();
      const method = current;
      const outputContext = redact ? sanitizeForLogging(context, redactedKeys) : context;

      if (structured) {
        sink[method]({
          ts: Date.now(),
          level: current,
          module: moduleName,
          identifier: identifier || null,
          message,
          context: outputContext || {},
        });
        return;
      }

      const prefix = `[${moduleName}${identifier ? `:${identifier}` : ""}]`;
      if (outputContext === undefined) {
        sink[method](prefix, message);
        return;
      }
      sink[method](prefix, message, outputContext);
    }

    return {
      debug: (message, context) => write("debug", message, context),
      info: (message, context) => write("info", message, context),
      warn: (message, context) => write("warn", message, context),
      error: (message, context) => write("error", message, context),
      child(extraIdentifier) {
        return createLogger({
          moduleName,
          identifier: extraIdentifier || identifier,
          getLevel,
          structured,
          redact,
          redactedKeys,
          consoleRef: sink,
        });
      },
    };
  }

  function buildNotifications(moduleName) {
    return {
      REQUEST: `${moduleName}_REQUEST`,
      CONFIG: `${moduleName}_CONFIG`,
      LIFECYCLE: `${moduleName}_LIFECYCLE`,
      RESPONSE: `${moduleName}_RESPONSE`,
      EVENT: `${moduleName}_EVENT`,
      ERROR: `${moduleName}_ERROR`,
    };
  }

  function generateRequestId() {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function createEnvelope(input) {
    return {
      identifier: input.identifier || "default",
      instanceId: input.instanceId || input.identifier || "default",
      requestId: input.requestId || generateRequestId(),
      ts: input.ts || Date.now(),
      action: input.action,
      ok: Boolean(input.ok),
      data: input.data === undefined ? null : input.data,
      error: input.error || null,
      meta: input.meta || {},
    };
  }

  function createTransport({ moduleName, identifier, instanceId, sendSocketNotification }) {
    const notifications = buildNotifications(moduleName);

    return {
      notifications,
      sendRequest(action, data, meta = {}) {
        const payload = createEnvelope({
          identifier,
          instanceId: instanceId || identifier,
          action,
          ok: true,
          data,
          meta,
        });
        sendSocketNotification(notifications.REQUEST, payload);
        return payload.requestId;
      },
      sendConfig(config) {
        sendSocketNotification(
          notifications.CONFIG,
          createEnvelope({
            identifier,
            instanceId: instanceId || identifier,
            action: "CONFIG",
            ok: true,
            data: config,
          }),
        );
      },
      sendLifecycle(state) {
        sendSocketNotification(
          notifications.LIFECYCLE,
          createEnvelope({
            identifier,
            instanceId: instanceId || identifier,
            action: state,
            ok: true,
            data: null,
          }),
        );
      },
    };
  }

  function createNodeTransport({ moduleName, sendSocketNotification }) {
    const notifications = buildNotifications(moduleName);

    return {
      notifications,
      sendSuccess(requestEnvelope, data, meta = {}) {
        sendSocketNotification(
          notifications.RESPONSE,
          createEnvelope({
            identifier: requestEnvelope.identifier,
            instanceId: requestEnvelope.instanceId,
            requestId: requestEnvelope.requestId,
            action: requestEnvelope.action,
            ok: true,
            data,
            meta,
          }),
        );
      },
      sendError(requestEnvelope, error, meta = {}) {
        sendSocketNotification(
          notifications.ERROR,
          createEnvelope({
            identifier: requestEnvelope.identifier,
            instanceId: requestEnvelope.instanceId,
            requestId: requestEnvelope.requestId,
            action: requestEnvelope.action,
            ok: false,
            data: null,
            error,
            meta,
          }),
        );
      },
    };
  }

  function createErrorFactory() {
    return {
      createError(code, message, details = {}, retryable = false, severity = "error") {
        return { code, message, details, retryable, severity };
      },
      fromException(error, context = {}) {
        const message = error instanceof Error ? error.message : String(error);
        const code = context.code || "UNKNOWN_ERROR";
        return {
          code,
          message,
          details: {
            ...(context.details || {}),
            originalName: error instanceof Error ? error.name : typeof error,
          },
          retryable: context.retryable === true,
          severity: context.severity || "error",
        };
      },
    };
  }

  const LIFECYCLE_DEFAULTS = {
    minUpdateInterval: 5000,
    jitterRatio: 0.1,
    deferredInitIntervalMs: 5000,
    deferredInitMaxAttempts: 12,
    retryInterval: 60000,
    maxRetryInterval: 30 * 60000,
  };

  /**
   * Parse a clock value into minutes since midnight.
   * Accepts "HH:MM" strings and plain numbers (interpreted as hours).
   *
   * @param {string|number} value - Clock value
   * @returns {number|null} Minutes since midnight, or null when unparsable
   */
  function parseClockToMinutes(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const minutes = Math.round(value * 60);
      return ((minutes % 1440) + 1440) % 1440;
    }

    if (typeof value !== "string") {
      return null;
    }

    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) {
      return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) {
      return null;
    }

    return hours * 60 + minutes;
  }

  function normalizeQuietHours(quietHours) {
    if (!quietHours || typeof quietHours !== "object") {
      return null;
    }

    const from = parseClockToMinutes(quietHours.from);
    const to = parseClockToMinutes(quietHours.to);
    if (from === null || to === null || from === to) {
      return null;
    }

    return { from, to };
  }

  function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  /**
   * Check whether a point in time falls inside a quiet-hours window.
   * Windows that wrap around midnight (e.g. 23:00 → 06:00) are supported.
   *
   * @param {Date} date - Point in time to test
   * @param {{from: number, to: number}|null} range - Normalized quiet hours
   * @returns {boolean} True when inside the window
   */
  function isWithinQuietHours(date, range) {
    if (!range) {
      return false;
    }

    const current = minutesOfDay(date);
    return range.from < range.to
      ? current >= range.from && current < range.to
      : current >= range.from || current < range.to;
  }

  function msUntilQuietHoursEnd(date, range) {
    if (!isWithinQuietHours(date, range)) {
      return 0;
    }

    const current = minutesOfDay(date);
    const deltaMinutes = range.to > current ? range.to - current : 1440 - current + range.to;
    return deltaMinutes * 60000 - date.getSeconds() * 1000 - date.getMilliseconds();
  }

  /**
   * Milliseconds until the next slot of an interval grid anchored to a time of day.
   * With interval 6 h and anchorHour 7 the slots are 07:00, 13:00, 19:00, 01:00.
   * Intervals that do not divide 24 h evenly drift across days by design.
   *
   * @param {number} nowMs - Current epoch milliseconds
   * @param {number} intervalMs - Interval length
   * @param {number} anchorHour - Hour of day the grid is anchored to (may be fractional)
   * @returns {number} Milliseconds until the next slot
   */
  function msUntilAnchoredSlot(nowMs, intervalMs, anchorHour) {
    const anchor = new Date(nowMs);
    const wholeHours = Math.floor(anchorHour);
    anchor.setHours(wholeHours, Math.round((anchorHour - wholeHours) * 60), 0, 0);

    let anchorMs = anchor.getTime();
    if (anchorMs > nowMs) {
      anchorMs -= 86400000;
    }

    const remainder = (nowMs - anchorMs) % intervalMs;
    return remainder === 0 ? 0 : intervalMs - remainder;
  }

  function formatDayKey(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  /**
   * JSON with object keys in sorted order, so two configs that differ only in
   * key order compare equal (comparing configs across clients, MODULE-PLAN S3).
   *
   * @param {*} value - Any JSON-serialisable value
   * @returns {string} Deterministic JSON
   */
  function stableStringify(value) {
    return JSON.stringify(value, (_key, current) => {
      if (current && typeof current === "object" && !Array.isArray(current)) {
        return Object.keys(current)
          .sort()
          .reduce((sorted, key) => {
            sorted[key] = current[key];
            return sorted;
          }, {});
      }
      return current;
    });
  }

  /**
   * Create the shared frontend lifecycle for a MagicMirror module.
   *
   * The helper owns everything the MagicMirror core does *not* guarantee:
   * suspend()/resume() are unpaired, fire repeatedly, and show() can fail
   * silently — so `module.hidden` is the only reliable source of truth.
   *
   * Responsibilities:
   *   1. Visibility truth      — isSuspended() honours hidden/data.hidden
   *   2. Freshness guard       — resume() only fetches when data is actually stale
   *   3. Idempotency           — repeated suspend()/resume() (and resume without
   *                              suspend) stay side-effect free
   *   4. Guarded timer callback— the guard sits inside the tick, not only when arming
   *   5. Deferred init         — a module that starts hidden retries with a limit
   *   6. Day-change hook       — detected across a suspend
   *   7. Visual work separated — onVisible/onVisibleTick never cause traffic
   *   8. Jitter + quiet hours  — staggered timers, no polling at night
   *   9. Rate limit + backoff  — a broken backend is not hammered once per cycle
   *
   * @param {object} options - Lifecycle options
   * @param {object} options.module - The MagicMirror module instance (`this`)
   * @param {object} [options.logger] - Shared logger ({debug,info,warn,error}) for diagnostics
   * @param {Function} [options.log] - Alternative to `logger`: a `(level, message)` function
   * @param {number|Function} [options.updateInterval] - Fetch interval in ms (0 disables the timer)
   * @param {Function} [options.getUpdateInterval] - Late-bound alternative to updateInterval
   * @param {number} [options.minUpdateInterval] - Lower clamp for the interval
   * @param {number} [options.jitterRatio] - Relative jitter applied to the periodic timer
   * @param {boolean} [options.backgroundRefresh] - Keep fetching while hidden (default true)
   * @param {{from: string|number, to: string|number}} [options.quietHours] - Window without polling
   * @param {number} [options.anchorHour] - Anchor the interval grid to a time of day
   * @param {number} [options.retryInterval] - Base backoff after a failed fetch (default 60 s)
   * @param {number} [options.maxRetryInterval] - Upper bound of the backoff (default 30 min)
   * @param {Function} [options.onFetch] - Called when data should be fetched
   * @param {Function} [options.onVisible] - Called when the module becomes visible
   * @param {Function} [options.onHidden] - Called when the module becomes hidden
   * @param {Function} [options.onVisibleTick] - Purely visual tick, runs only while visible
   * @param {number} [options.visibleTickInterval] - Interval for onVisibleTick
   * @param {Function} [options.onDayChange] - Called when the local date rolled over
   * @param {Function} [options.onSessionState] - Called with ('active'|'paused', reason)
   * @param {{run: Function, isPending?: Function, intervalMs?: number, maxAttempts?: number}} [options.deferredInit]
   *        Initialization handshake that replaces the first fetch when present
   * @param {Function} [options.getDayKey] - Custom day key provider
   * @param {Function} [options.now] - Clock injection for tests
   * @param {object} [options.timers] - { setTimeout, clearTimeout } injection for tests
   * @param {Function} [options.random] - RNG injection for tests
   * @returns {object} Lifecycle API
   */
  function createLifecycle(options = {}) {
    const host = options.module;
    if (!host) {
      throw new Error("createLifecycle requires a `module` reference");
    }

    const logger = options.logger || null;
    const logFn = typeof options.log === "function" ? options.log : null;
    const timers = options.timers || {};
    const setTimer = typeof timers.setTimeout === "function" ? timers.setTimeout : setTimeout;
    const clearTimer = typeof timers.clearTimeout === "function" ? timers.clearTimeout : clearTimeout;
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const random = typeof options.random === "function" ? options.random : Math.random;

    const backgroundRefresh = options.backgroundRefresh !== false;
    const minUpdateInterval = Number.isFinite(options.minUpdateInterval)
      ? Math.max(0, options.minUpdateInterval)
      : LIFECYCLE_DEFAULTS.minUpdateInterval;
    const jitterRatio = Number.isFinite(options.jitterRatio)
      ? Math.max(0, Math.min(0.5, options.jitterRatio))
      : LIFECYCLE_DEFAULTS.jitterRatio;
    const quietHours = normalizeQuietHours(options.quietHours);
    const anchorHour = Number.isFinite(options.anchorHour) ? options.anchorHour : null;
    const retryInterval = Number.isFinite(options.retryInterval)
      ? Math.max(1000, options.retryInterval)
      : LIFECYCLE_DEFAULTS.retryInterval;
    const maxRetryInterval = Number.isFinite(options.maxRetryInterval)
      ? Math.max(retryInterval, options.maxRetryInterval)
      : Math.max(retryInterval, LIFECYCLE_DEFAULTS.maxRetryInterval);

    let started = false;
    let paused = false;
    let visualActive = false;
    let fetchTimer = null;
    let visibleTimer = null;
    let visibleTickDueAt = null;
    let deferredInitTimer = null;
    let deferredInitAttempts = 0;
    let lastDataReceivedAt = null;
    let lastFetchStartedAt = null;
    let awaitingResponse = false;
    let consecutiveFailures = 0;
    let retryNotBefore = 0;
    let retryTimer = null;
    let lastSessionState = null;
    let currentDayKey = null;
    let pendingRender = null;

    function log(level, message, context) {
      if (logFn) {
        if (context === undefined) {
          logFn(level, message);
        } else {
          logFn(level, message, context);
        }
        return;
      }

      if (logger && typeof logger[level] === "function") {
        logger[level](message, context);
      }
    }

    function safeCall(name, fn, arg) {
      if (typeof fn !== "function") {
        return undefined;
      }

      try {
        return fn(arg);
      } catch (error) {
        log("error", `[lifecycle] callback "${name}" failed`, {
          message: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }

    function resolveUpdateInterval() {
      const raw =
        typeof options.getUpdateInterval === "function"
          ? options.getUpdateInterval()
          : typeof options.updateInterval === "function"
            ? options.updateInterval()
            : options.updateInterval;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        return 0;
      }

      return Math.max(minUpdateInterval, Math.floor(value));
    }

    function applyJitter(value) {
      if (!Number.isFinite(value) || value <= 0 || jitterRatio <= 0) {
        return value;
      }

      return Math.max(0, Math.round(value * (1 + (random() * 2 - 1) * jitterRatio)));
    }

    /** @returns {boolean} True when the core hid the module (the only reliable truth) */
    function isHiddenByCore() {
      return host.hidden === true || host.data?.hidden === true;
    }

    function isSuspended() {
      return paused === true || isHiddenByCore();
    }

    function getDataAge() {
      return lastDataReceivedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now() - lastDataReceivedAt);
    }

    function notifySessionState(state, reason) {
      if (state === lastSessionState) {
        return;
      }

      lastSessionState = state;
      safeCall("onSessionState", options.onSessionState, { state, reason });
    }

    function currentDayKeyValue() {
      if (typeof options.getDayKey === "function") {
        return safeCall("getDayKey", options.getDayKey) ?? null;
      }

      return formatDayKey(new Date(now()));
    }

    function checkDayChange(reason) {
      const key = currentDayKeyValue();
      if (key === null || key === undefined) {
        return false;
      }

      if (currentDayKey === null) {
        currentDayKey = key;
        return false;
      }

      if (key === currentDayKey) {
        return false;
      }

      const previous = currentDayKey;
      currentDayKey = key;
      log("debug", `[lifecycle] day changed ${previous} -> ${key} (${reason})`);
      safeCall("onDayChange", options.onDayChange, { previous, current: key, reason });
      return true;
    }

    function isQuietNow() {
      return quietHours !== null && isWithinQuietHours(new Date(now()), quietHours);
    }

    /** Register a failed (or unanswered) attempt and grow the retry backoff. */
    function registerFailure() {
      consecutiveFailures += 1;
      awaitingResponse = false;
      const backoff = Math.min(maxRetryInterval, retryInterval * 2 ** (consecutiveFailures - 1));
      retryNotBefore = now() + backoff;
      return backoff;
    }

    /**
     * Decide whether a fetch may run.
     * Quiet hours and hidden state never block a module that has never received
     * data — but the rate limit and the error backoff always apply, otherwise a
     * broken backend would turn every Carousel resume into a new request.
     */
    function canFetch(reason, force) {
      if (typeof options.onFetch !== "function") {
        return false;
      }

      if (force) {
        return true;
      }

      if (lastFetchStartedAt !== null) {
        const interval = resolveUpdateInterval();
        const spacing = Math.min(interval > 0 ? interval / 2 : retryInterval, retryInterval);
        if (now() - lastFetchStartedAt < spacing) {
          log("debug", `[lifecycle] fetch skipped, minimum spacing not reached (${reason})`);
          return false;
        }
      }

      if (retryNotBefore > now()) {
        log("debug", `[lifecycle] fetch skipped, retry backoff active (${reason})`);
        return false;
      }

      if (lastDataReceivedAt === null) {
        return true;
      }

      if (!backgroundRefresh && isSuspended()) {
        log("debug", `[lifecycle] fetch skipped while suspended (${reason})`);
        return false;
      }

      if (isQuietNow()) {
        log("debug", `[lifecycle] fetch skipped during quiet hours (${reason})`);
        return false;
      }

      return true;
    }

    function runFetch(reason, force = false) {
      if (!canFetch(reason, force)) {
        return false;
      }

      if (awaitingResponse) {
        const backoff = registerFailure();
        log("debug", `[lifecycle] previous fetch stayed unanswered, backing off ${Math.round(backoff / 1000)}s`);
      }

      awaitingResponse = true;
      lastFetchStartedAt = now();

      safeCall("onFetch", options.onFetch, {
        reason,
        visible: !isSuspended(),
        dataAge: getDataAge(),
        lastDataReceivedAt,
      });
      return true;
    }

    function deferredInitPending() {
      const config = options.deferredInit;
      if (!config || typeof config.run !== "function") {
        return false;
      }

      return typeof config.isPending === "function" ? config.isPending() === true : true;
    }

    /**
     * Trigger the module's initial work: the init handshake when one is
     * configured, the first fetch otherwise.
     */
    function runInitialWork(reason) {
      const config = options.deferredInit;
      if (config && typeof config.run === "function") {
        if (!deferredInitPending()) {
          return false;
        }

        safeCall("deferredInit.run", config.run, reason);
        return true;
      }

      return runFetch(reason);
    }

    function stopDeferredInitTimer() {
      if (deferredInitTimer !== null) {
        clearTimer(deferredInitTimer);
        deferredInitTimer = null;
      }
    }

    /**
     * Retry the initial work while the module starts hidden (§3.4 start order).
     * Bounded so a permanently hidden module stops polling its own visibility.
     */
    function scheduleDeferredInit(reason) {
      if (!deferredInitPending() || deferredInitTimer !== null) {
        return;
      }

      const config = options.deferredInit || {};
      const intervalMs = Number.isFinite(config.intervalMs)
        ? Math.max(1000, config.intervalMs)
        : LIFECYCLE_DEFAULTS.deferredInitIntervalMs;
      const maxAttempts = Number.isFinite(config.maxAttempts)
        ? Math.max(1, config.maxAttempts)
        : LIFECYCLE_DEFAULTS.deferredInitMaxAttempts;

      const tick = () => {
        deferredInitTimer = null;
        if (!deferredInitPending()) {
          return;
        }

        deferredInitAttempts += 1;

        // The core is the truth here on purpose: a module can become visible
        // without ever receiving a resume() callback (§3.4 start order).
        if (!isHiddenByCore()) {
          if (paused) {
            paused = false;
            notifySessionState("active", `${reason}-visible`);
            markVisible(reason);
            scheduleFetchTimer();
          }

          log("info", `[lifecycle] deferred init runs after ${deferredInitAttempts} attempt(s)`);
          runInitialWork(`${reason}-retry-${deferredInitAttempts}`);
          return;
        }

        if (deferredInitAttempts >= maxAttempts) {
          log("warn", `[lifecycle] deferred init gave up after ${maxAttempts} attempts, waiting for resume()`);
          return;
        }

        deferredInitTimer = setTimer(tick, intervalMs);
      };

      deferredInitTimer = setTimer(tick, intervalMs);
    }

    function stopRetryTimer() {
      if (retryTimer !== null) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
    }

    /**
     * After a failed fetch, try again once the backoff has passed. The backoff
     * alone only blocks attempts; without this timer the next one would wait for
     * the periodic timer - hours for a module with a long updateInterval.
     */
    function scheduleRetry() {
      if (!started || typeof options.onFetch !== "function" || retryTimer !== null) {
        return;
      }

      retryTimer = setTimer(
        () => {
          retryTimer = null;
          runFetch("retry");
        },
        Math.max(1000, retryNotBefore - now()),
      );
    }

    function stopFetchTimer() {
      if (fetchTimer !== null) {
        clearTimer(fetchTimer);
        fetchTimer = null;
      }
    }

    function nextFetchDelay(interval) {
      if (anchorHour === null) {
        return applyJitter(interval);
      }

      let base = msUntilAnchoredSlot(now(), interval, anchorHour);
      if (base < interval / 2) {
        base += interval;
      }

      return applyJitter(base);
    }

    function scheduleFetchTimer(explicitDelay) {
      stopFetchTimer();

      const interval = resolveUpdateInterval();
      if (!interval) {
        return;
      }

      if (!backgroundRefresh && isSuspended()) {
        return;
      }

      const delay = Number.isFinite(explicitDelay) ? explicitDelay : nextFetchDelay(interval);
      fetchTimer = setTimer(onFetchTick, Math.max(0, Math.round(delay)));
    }

    function onFetchTick() {
      fetchTimer = null;

      const interval = resolveUpdateInterval();
      if (!interval) {
        return;
      }

      // The guard lives inside the callback, not only where the timer is armed:
      // suspend() may have fired between arming and running.
      if (!backgroundRefresh && isSuspended()) {
        return;
      }

      checkDayChange("timer");

      if (isQuietNow() && lastDataReceivedAt !== null) {
        const wakeIn = msUntilQuietHoursEnd(new Date(now()), quietHours);
        log("debug", "[lifecycle] periodic fetch suppressed by quiet hours");
        scheduleFetchTimer(Math.min(interval, Math.max(1000, wakeIn) + 1000));
        return;
      }

      runFetch("periodic");
      scheduleFetchTimer();
    }

    function stopVisibleTimer() {
      if (visibleTimer !== null) {
        clearTimer(visibleTimer);
        visibleTimer = null;
      }
    }

    /**
     * Arm the visual tick against its own due date rather than restarting the
     * countdown. A Carousel transition hides and re-shows the current module
     * once per cycle; restarting on every resume would mean a tick slower than
     * the transition interval never fires at all.
     */
    function startVisibleTimer() {
      const interval = Number(options.visibleTickInterval);
      if (
        typeof options.onVisibleTick !== "function" ||
        !Number.isFinite(interval) ||
        interval <= 0 ||
        visibleTimer !== null
      ) {
        return;
      }

      if (visibleTickDueAt === null) {
        visibleTickDueAt = now() + interval;
      }

      const tick = () => {
        visibleTimer = null;
        if (isSuspended()) {
          return;
        }

        visibleTickDueAt = now() + interval;
        safeCall("onVisibleTick", options.onVisibleTick);
        visibleTimer = setTimer(tick, interval);
      };

      visibleTimer = setTimer(tick, Math.max(0, visibleTickDueAt - now()));
    }

    function flushPendingRender() {
      if (pendingRender === null) {
        return;
      }

      const speed = pendingRender.speed;
      pendingRender = null;
      if (typeof host.updateDom === "function") {
        host.updateDom(speed);
      }
    }

    function markVisible(reason) {
      if (!visualActive) {
        visualActive = true;
        safeCall("onVisible", options.onVisible, { reason });
      }

      startVisibleTimer();
      flushPendingRender();
    }

    function markHidden(reason) {
      stopVisibleTimer();
      if (visualActive) {
        visualActive = false;
        safeCall("onHidden", options.onHidden, { reason });
      }
    }

    const api = {
      /**
       * Start the lifecycle. Safe to call once from the module's start().
       *
       * @param {string} [reason] - Diagnostic reason
       * @returns {object} The lifecycle API
       */
      start(reason = "start") {
        if (started) {
          return api;
        }

        started = true;
        paused = isHiddenByCore();
        currentDayKey = currentDayKeyValue();
        notifySessionState(paused ? "paused" : "active", reason);

        if (!paused) {
          markVisible(reason);
        }

        scheduleFetchTimer();

        if (backgroundRefresh || !paused) {
          runInitialWork(reason);
        } else {
          log("debug", "[lifecycle] module starts hidden, deferring initial work");
          scheduleDeferredInit(`${reason}-hidden`);
        }

        return api;
      },

      /**
       * Tear everything down. Not called by the MagicMirror core — used by tests
       * and by modules that manage their own teardown.
       *
       * @returns {object} The lifecycle API
       */
      stop() {
        stopFetchTimer();
        stopRetryTimer();
        stopVisibleTimer();
        stopDeferredInitTimer();
        markHidden("stop");
        started = false;
        paused = true;
        pendingRender = null;
        visibleTickDueAt = null;
        return api;
      },

      /**
       * Handle the core's suspend() callback. Idempotent by contract: the core
       * fires it on every hide(), regardless of the previous state.
       *
       * @param {string} [reason] - Diagnostic reason
       * @returns {object} The lifecycle API
       */
      suspend(reason = "suspend") {
        if (!paused) {
          log("debug", `[lifecycle] suspended (${reason})`);
        }

        paused = true;
        markHidden(reason);

        if (!backgroundRefresh) {
          stopFetchTimer();
        }

        notifySessionState("paused", reason);
        return api;
      },

      /**
       * Handle the core's resume() callback. Fetches only when data is stale —
       * this is what keeps a Carousel rotation from turning into a fetch storm.
       *
       * @param {string} [reason] - Diagnostic reason
       * @returns {object} The lifecycle API
       */
      resume(reason = "resume") {
        if (!started) {
          return api.start(reason);
        }

        // show() can fail silently while lock strings are held, and Carousel
        // pre-renders hidden modules — trust module.hidden, not the callback.
        if (isHiddenByCore()) {
          log("debug", `[lifecycle] ${reason} ignored, core still reports the module as hidden`);
          paused = true;
          markHidden(`${reason}-while-hidden`);
          notifySessionState("paused", `${reason}-while-hidden`);
          return api;
        }

        if (paused) {
          log("debug", `[lifecycle] resumed (${reason})`);
        }

        paused = false;
        notifySessionState("active", reason);
        markVisible(reason);
        checkDayChange(reason);

        if (deferredInitPending()) {
          stopDeferredInitTimer();
          scheduleFetchTimer();
          runInitialWork(`${reason}-init`);
          return api;
        }

        const interval = resolveUpdateInterval();
        const dataAge = getDataAge();

        if (lastDataReceivedAt === null) {
          runFetch(`${reason}-no-data`);
        } else if (interval > 0 && dataAge >= interval) {
          runFetch(`${reason}-stale-data`);
        } else {
          log("debug", `[lifecycle] data is fresh (age=${Math.round(dataAge / 1000)}s), skipping duplicate fetch`);
        }

        // Re-arm with the *remaining* interval so a hide/show cycle can never
        // restart the countdown (the reason updateInterval was dead under Carousel).
        if (fetchTimer === null) {
          const remaining = Number.isFinite(dataAge) ? Math.max(0, interval - dataAge) : 0;
          scheduleFetchTimer(remaining > 0 ? remaining : undefined);
        }

        return api;
      },

      /**
       * Report the current active/paused state again, even without a change -
       * e.g. after the backend lost it (server restart, INIT_REQUIRED).
       *
       * @param {string} [reason] - Diagnostic reason
       * @returns {object} The lifecycle API
       */
      reportSessionState(reason = "report") {
        if (!started) {
          return api;
        }
        const state = isSuspended() ? "paused" : "active";
        lastSessionState = state;
        safeCall("onSessionState", options.onSessionState, { state, reason });
        return api;
      },

      /**
       * Record that fresh data arrived. Feeds the freshness guard.
       *
       * @param {number} [timestamp] - Epoch ms, defaults to now
       * @returns {object} The lifecycle API
       */
      markDataReceived(timestamp) {
        lastDataReceivedAt = Number.isFinite(timestamp) ? timestamp : now();
        awaitingResponse = false;
        consecutiveFailures = 0;
        retryNotBefore = 0;
        stopRetryTimer();
        return api;
      },

      /**
       * Record a failed fetch. Grows an exponential backoff so a broken backend
       * cannot be hammered once per Carousel cycle, and schedules the retry for
       * when that backoff has passed.
       *
       * @returns {object} The lifecycle API
       */
      markFetchFailed() {
        const backoff = registerFailure();
        log(
          "debug",
          `[lifecycle] fetch failed (${consecutiveFailures}x), next attempt in ${Math.round(backoff / 1000)}s`,
        );
        scheduleRetry();
        return api;
      },

      /**
       * Trigger a fetch outside the timer (user interaction, config change).
       *
       * @param {string} [reason] - Diagnostic reason
       * @param {{force?: boolean}} [opts] - force bypasses quiet hours and the hidden guard
       * @returns {boolean} True when onFetch ran
       */
      requestFetch(reason = "manual", opts = {}) {
        return runFetch(reason, opts.force === true);
      },

      /**
       * Render through the lifecycle instead of calling updateDom() directly.
       * A hidden module skips the render (the core would still build the whole
       * DOM) and replays it on the next resume().
       *
       * @param {number} [animationSpeed] - Passed through to updateDom()
       * @returns {boolean} True when the render happened immediately
       */
      render(animationSpeed) {
        if (isSuspended()) {
          pendingRender = { speed: animationSpeed };
          return false;
        }

        pendingRender = null;
        if (typeof host.updateDom === "function") {
          host.updateDom(animationSpeed);
        }

        return true;
      },

      isSuspended,
      isVisible() {
        return !isSuspended();
      },
      getDataAge,

      /** @returns {object} Diagnostic snapshot */
      getState() {
        return {
          started,
          paused,
          suspended: isSuspended(),
          visualActive,
          backgroundRefresh,
          updateInterval: resolveUpdateInterval(),
          lastDataReceivedAt,
          dataAge: getDataAge(),
          lastFetchStartedAt,
          awaitingResponse,
          consecutiveFailures,
          retryNotBefore,
          retryTimerArmed: retryTimer !== null,
          fetchTimerArmed: fetchTimer !== null,
          visibleTimerArmed: visibleTimer !== null,
          deferredInitArmed: deferredInitTimer !== null,
          deferredInitAttempts,
          quietHoursActive: isQuietNow(),
          pendingRender: pendingRender !== null,
          dayKey: currentDayKey,
        };
      },
    };

    return api;
  }

  return {
    LEVELS,
    normalizeLevel,
    buildNotifications,
    createTransport,
    createNodeTransport,
    createLogger,
    createErrorFactory,
    createEnvelope,
    sanitizeForLogging,
    createLifecycle,
    stableStringify,
    parseClockToMinutes,
    isWithinQuietHours,
    msUntilQuietHoursEnd,
    msUntilAnchoredSlot,
  };
});

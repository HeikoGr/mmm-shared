const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../mmm-shared');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Deterministic clock + timer queue. `advance()` runs every timer whose due
 * time falls inside the advanced window, in chronological order.
 */
function createHarness(startTime = new Date(2026, 0, 15, 12, 0, 0).getTime()) {
  let currentTime = startTime;
  let sequence = 1;
  const scheduled = new Map();

  return {
    now: () => currentTime,
    timers: {
      setTimeout(fn, delay) {
        const id = sequence;
        sequence += 1;
        scheduled.set(id, { fn, at: currentTime + Math.max(0, Number(delay) || 0) });
        return id;
      },
      clearTimeout(id) {
        scheduled.delete(id);
      },
    },
    advance(ms) {
      const target = currentTime + ms;
      for (;;) {
        let dueId = null;
        let dueEntry = null;
        for (const [id, entry] of scheduled.entries()) {
          if (entry.at <= target && (dueEntry === null || entry.at < dueEntry.at)) {
            dueId = id;
            dueEntry = entry;
          }
        }

        if (dueEntry === null) {
          break;
        }

        scheduled.delete(dueId);
        currentTime = dueEntry.at;
        dueEntry.fn();
      }

      currentTime = target;
    },
    pendingTimers: () => scheduled.size,
  };
}

function createModuleStub() {
  return {
    hidden: false,
    data: { hidden: false },
    renders: [],
    updateDom(speed) {
      this.renders.push(speed);
    },
  };
}

/**
 * Build a lifecycle with a recording onFetch that immediately acknowledges the
 * data, the way a module does when the backend answers.
 */
function createSubject(overrides = {}) {
  const harness = createHarness(overrides.startTime);
  const host = createModuleStub();
  const fetches = [];
  const events = [];

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 15 * MINUTE,
    jitterRatio: 0,
    now: harness.now,
    timers: harness.timers,
    random: () => 0.5,
    onFetch: (context) => {
      fetches.push(context.reason);
      if (overrides.answerFetch !== false) {
        lifecycle.markDataReceived();
      }
    },
    onVisible: () => events.push('visible'),
    onHidden: () => events.push('hidden'),
    onSessionState: ({ state }) => events.push(`session:${state}`),
    ...overrides.lifecycle,
  });

  return { harness, host, lifecycle, fetches, events };
}

/** Simulate MMM-Carousel: `visibleMs` shown out of every `cycleMs`. */
function runCarousel({ harness, host, lifecycle }, { cycleMs, visibleMs, durationMs }) {
  const hiddenMs = cycleMs - visibleMs;
  const cycles = Math.floor(durationMs / cycleMs);

  for (let i = 0; i < cycles; i += 1) {
    harness.advance(visibleMs);
    host.hidden = true;
    host.data.hidden = true;
    lifecycle.suspend();
    harness.advance(hiddenMs);
    host.hidden = false;
    host.data.hidden = false;
    lifecycle.resume();
  }
}

test('clock helpers parse and compare quiet hour windows', () => {
  assert.equal(shared.parseClockToMinutes('07:30'), 450);
  assert.equal(shared.parseClockToMinutes(7.5), 450);
  assert.equal(shared.parseClockToMinutes('24:00'), null);
  assert.equal(shared.parseClockToMinutes('nonsense'), null);

  const window = { from: 23 * 60, to: 6 * 60 };
  assert.equal(shared.isWithinQuietHours(new Date(2026, 0, 15, 23, 30), window), true);
  assert.equal(shared.isWithinQuietHours(new Date(2026, 0, 15, 3, 0), window), true);
  assert.equal(shared.isWithinQuietHours(new Date(2026, 0, 15, 12, 0), window), false);

  const daytime = { from: 9 * 60, to: 17 * 60 };
  assert.equal(shared.isWithinQuietHours(new Date(2026, 0, 15, 12, 0), daytime), true);
  assert.equal(shared.isWithinQuietHours(new Date(2026, 0, 15, 20, 0), daytime), false);
});

test('msUntilAnchoredSlot lands on the interval grid of the anchor hour', () => {
  const at = (hour, minute = 0) => new Date(2026, 0, 15, hour, minute, 0).getTime();

  // 6 h grid anchored at 07:00 -> 07:00, 13:00, 19:00, 01:00
  assert.equal(shared.msUntilAnchoredSlot(at(8), 6 * HOUR, 7), 5 * HOUR);
  assert.equal(shared.msUntilAnchoredSlot(at(13), 6 * HOUR, 7), 0);
  assert.equal(shared.msUntilAnchoredSlot(at(23), 6 * HOUR, 7), 2 * HOUR);
  assert.equal(shared.msUntilAnchoredSlot(at(3), 6 * HOUR, 7), 4 * HOUR);
});

test('createLifecycle requires a module reference', () => {
  assert.throws(() => shared.createLifecycle({}), /requires a `module` reference/);
});

test('a Carousel rotation no longer drives the fetch rate', () => {
  const subject = createSubject({ lifecycle: { backgroundRefresh: false } });
  subject.lifecycle.start();

  runCarousel(subject, { cycleMs: 50 * 1000, visibleMs: 10 * 1000, durationMs: HOUR });

  // 15 min interval over one hour: the initial fetch plus four refreshes.
  // Before the shared lifecycle this was one fetch per 50 s cycle (72/hour).
  assert.equal(subject.fetches.length, 5);
  assert.equal(subject.fetches[0], 'start');
  assert.ok(subject.fetches.slice(1).every((reason) => reason.includes('stale-data')));
});

test('doubling the Carousel transition interval does not change the fetch count', () => {
  const fast = createSubject({ lifecycle: { backgroundRefresh: false } });
  fast.lifecycle.start();
  runCarousel(fast, { cycleMs: 50 * 1000, visibleMs: 10 * 1000, durationMs: 4 * HOUR });

  const slow = createSubject({ lifecycle: { backgroundRefresh: false } });
  slow.lifecycle.start();
  runCarousel(slow, { cycleMs: 100 * 1000, visibleMs: 20 * 1000, durationMs: 4 * HOUR });

  assert.equal(fast.fetches.length, slow.fetches.length);
});

test('background refresh keeps the cadence while the module stays hidden', () => {
  const subject = createSubject();
  subject.lifecycle.start();
  subject.host.hidden = true;
  subject.lifecycle.suspend();

  subject.harness.advance(HOUR);

  // start + 4 background refreshes
  assert.equal(subject.fetches.length, 5);
  assert.equal(subject.fetches.filter((reason) => reason === 'periodic').length, 4);
  assert.equal(subject.lifecycle.isSuspended(), true);
});

test('background refresh keeps data warm so resume renders without a fetch', () => {
  const subject = createSubject();
  subject.lifecycle.start();
  subject.host.hidden = true;
  subject.lifecycle.suspend();
  subject.harness.advance(HOUR);

  const before = subject.fetches.length;
  subject.host.hidden = false;
  subject.lifecycle.resume();

  assert.equal(subject.fetches.length, before, 'resume must not fetch when data is fresh');
});

test('resume fetches when data is missing or stale, and skips when fresh', () => {
  const subject = createSubject({ lifecycle: { backgroundRefresh: false } });
  subject.lifecycle.start();
  assert.deepEqual(subject.fetches, ['start']);

  subject.host.hidden = true;
  subject.lifecycle.suspend();
  subject.harness.advance(MINUTE);
  subject.host.hidden = false;
  subject.lifecycle.resume();
  assert.equal(subject.fetches.length, 1, 'fresh data must not trigger a fetch');

  subject.host.hidden = true;
  subject.lifecycle.suspend();
  subject.harness.advance(20 * MINUTE);
  subject.host.hidden = false;
  subject.lifecycle.resume();
  assert.equal(subject.fetches.length, 2);
  assert.equal(subject.fetches[1], 'resume-stale-data');
});

test('a module that never received data retries on resume, but rate limited', () => {
  const subject = createSubject({
    answerFetch: false,
    lifecycle: { backgroundRefresh: false, retryInterval: 60 * 1000 },
  });
  subject.lifecycle.start();

  const hideShow = () => {
    subject.host.hidden = true;
    subject.lifecycle.suspend();
    subject.host.hidden = false;
    subject.lifecycle.resume();
  };

  hideShow();
  assert.deepEqual(subject.fetches, ['start'], 'no retry inside the minimum spacing');

  subject.harness.advance(90 * 1000);
  hideShow();
  assert.deepEqual(subject.fetches, ['start', 'resume-no-data']);
});

test('a failing backend backs off exponentially instead of retrying per cycle', () => {
  const subject = createSubject({
    answerFetch: false,
    lifecycle: { backgroundRefresh: false, retryInterval: 60 * 1000 },
  });
  subject.lifecycle.start();
  subject.lifecycle.markFetchFailed();

  runCarousel(subject, { cycleMs: 50 * 1000, visibleMs: 10 * 1000, durationMs: HOUR });

  // Without the backoff this would be one request per 50 s cycle (72/hour).
  assert.ok(subject.fetches.length <= 8, `expected a handful of retries, got ${subject.fetches.length}`);
  assert.ok(subject.fetches.length >= 4, `expected retries to keep happening, got ${subject.fetches.length}`);
});

test('successful data resets the backoff', () => {
  const subject = createSubject({ answerFetch: false });
  subject.lifecycle.start();
  subject.lifecycle.markFetchFailed();
  subject.lifecycle.markFetchFailed();
  assert.ok(subject.lifecycle.getState().retryNotBefore > subject.harness.now());

  subject.lifecycle.markDataReceived();
  const state = subject.lifecycle.getState();
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.retryNotBefore, 0);
});

test('repeated suspend and resume calls stay side-effect free', () => {
  const subject = createSubject();
  subject.lifecycle.start();

  subject.host.hidden = true;
  subject.lifecycle.suspend();
  subject.lifecycle.suspend();
  subject.lifecycle.suspend();
  subject.host.hidden = false;
  subject.lifecycle.resume();
  subject.lifecycle.resume();

  assert.deepEqual(subject.events, [
    'session:active',
    'visible',
    'hidden',
    'session:paused',
    'session:active',
    'visible',
  ]);
});

test('resume while the core still reports hidden keeps the module paused', () => {
  const subject = createSubject();
  subject.lifecycle.start();
  subject.host.hidden = true;
  subject.lifecycle.suspend();

  // lockStrings made show() fail silently: hidden is still true
  subject.lifecycle.resume();

  assert.equal(subject.lifecycle.isSuspended(), true);
  assert.equal(subject.lifecycle.getState().paused, true);
});

test('data.hidden alone is enough to count as suspended', () => {
  const subject = createSubject();
  subject.lifecycle.start();
  subject.host.data.hidden = true;

  assert.equal(subject.lifecycle.isSuspended(), true);
});

test('a suspend between arming and firing cancels the timer fetch', () => {
  const subject = createSubject({ lifecycle: { backgroundRefresh: false } });
  subject.lifecycle.start();

  // Hide without notifying the lifecycle: the guard inside the callback must catch it.
  subject.host.hidden = true;
  subject.harness.advance(20 * MINUTE);

  assert.deepEqual(subject.fetches, ['start']);
});

test('deferred init retries while hidden and gives up after the limit', () => {
  const harness = createHarness();
  const host = createModuleStub();
  host.hidden = true;
  const runs = [];

  let initialized = false;
  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 15 * MINUTE,
    backgroundRefresh: false,
    jitterRatio: 0,
    now: harness.now,
    timers: harness.timers,
    onFetch: () => {},
    deferredInit: {
      run: (reason) => {
        runs.push(reason);
        initialized = true;
      },
      isPending: () => !initialized,
      intervalMs: 1000,
      maxAttempts: 3,
    },
  });

  lifecycle.start();
  assert.deepEqual(runs, [], 'must not initialize while hidden');

  harness.advance(10 * 1000);
  assert.deepEqual(runs, [], 'retries must stop after maxAttempts');
  assert.equal(lifecycle.getState().deferredInitAttempts, 3);

  host.hidden = false;
  lifecycle.resume();
  assert.equal(runs.length, 1);
  assert.equal(runs[0], 'resume-init');
});

test('deferred init runs from the retry timer as soon as the module becomes visible', () => {
  const harness = createHarness();
  const host = createModuleStub();
  host.hidden = true;
  const runs = [];

  let initialized = false;
  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 15 * MINUTE,
    backgroundRefresh: false,
    jitterRatio: 0,
    now: harness.now,
    timers: harness.timers,
    onFetch: () => {},
    deferredInit: {
      run: () => {
        initialized = true;
        runs.push('run');
      },
      isPending: () => !initialized,
      intervalMs: 1000,
      maxAttempts: 10,
    },
  });

  lifecycle.start();
  harness.advance(2500);
  host.hidden = false;
  harness.advance(1000);

  assert.equal(runs.length, 1);
});

test('the day change hook fires across a suspend', () => {
  const harness = createHarness(new Date(2026, 0, 15, 23, 30, 0).getTime());
  const host = createModuleStub();
  const dayChanges = [];

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 0,
    now: harness.now,
    timers: harness.timers,
    onFetch: () => {},
    onDayChange: (change) => dayChanges.push(change),
  });

  lifecycle.start();
  host.hidden = true;
  lifecycle.suspend();
  harness.advance(HOUR);
  host.hidden = false;
  lifecycle.resume();

  assert.equal(dayChanges.length, 1);
  assert.equal(dayChanges[0].previous, '2026-01-15');
  assert.equal(dayChanges[0].current, '2026-01-16');
});

test('quiet hours suppress periodic fetches and resume right afterwards', () => {
  const harness = createHarness(new Date(2026, 0, 15, 22, 0, 0).getTime());
  const host = createModuleStub();
  const fetches = [];

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 30 * MINUTE,
    jitterRatio: 0,
    quietHours: { from: '23:00', to: '06:00' },
    now: harness.now,
    timers: harness.timers,
    onFetch: (context) => {
      fetches.push({ reason: context.reason, at: new Date(harness.now()).getHours() });
      lifecycle.markDataReceived();
    },
  });

  lifecycle.start();
  harness.advance(10 * HOUR);

  const nightFetches = fetches.filter(({ at }) => at >= 23 || at < 6);
  assert.equal(nightFetches.length, 0, 'no polling during quiet hours');
  assert.ok(
    fetches.some(({ at }) => at === 6),
    'the first fetch after quiet hours must happen promptly'
  );
});

test('quiet hours never block the very first fetch', () => {
  const harness = createHarness(new Date(2026, 0, 15, 2, 0, 0).getTime());
  const host = createModuleStub();
  const fetches = [];

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 30 * MINUTE,
    quietHours: { from: '23:00', to: '06:00' },
    now: harness.now,
    timers: harness.timers,
    onFetch: (context) => fetches.push(context.reason),
  });

  lifecycle.start();
  assert.deepEqual(fetches, ['start']);
});

test('jitter spreads the periodic timer around the configured interval', () => {
  const delays = [];
  const harness = createHarness();
  const host = createModuleStub();
  const wrappedTimers = {
    setTimeout(fn, delay) {
      delays.push(delay);
      return harness.timers.setTimeout(fn, delay);
    },
    clearTimeout: harness.timers.clearTimeout,
  };

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 10 * MINUTE,
    jitterRatio: 0.1,
    random: () => 0,
    now: harness.now,
    timers: wrappedTimers,
    onFetch: () => lifecycle.markDataReceived(),
  });

  lifecycle.start();
  assert.equal(delays[0], 9 * MINUTE, 'random()=0 means the lower jitter bound');
});

test('render() defers work while hidden and replays it on resume', () => {
  const subject = createSubject();
  subject.lifecycle.start();

  subject.lifecycle.render(500);
  assert.deepEqual(subject.host.renders, [500]);

  subject.host.hidden = true;
  subject.lifecycle.suspend();
  assert.equal(subject.lifecycle.render(1000), false);
  assert.deepEqual(subject.host.renders, [500], 'no DOM build while hidden');

  subject.host.hidden = false;
  subject.lifecycle.resume();
  assert.deepEqual(subject.host.renders, [500, 1000]);
});

test('the visual tick runs only while the module is visible', () => {
  const harness = createHarness();
  const host = createModuleStub();
  let ticks = 0;

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 0,
    visibleTickInterval: 30 * 1000,
    onVisibleTick: () => {
      ticks += 1;
    },
    now: harness.now,
    timers: harness.timers,
    onFetch: () => {},
  });

  lifecycle.start();
  harness.advance(2 * MINUTE);
  assert.equal(ticks, 4);

  host.hidden = true;
  lifecycle.suspend();
  harness.advance(10 * MINUTE);
  assert.equal(ticks, 4, 'no visual work while hidden');

  host.hidden = false;
  lifecycle.resume();
  harness.advance(MINUTE);
  // 4 before hiding, one catch-up tick right on resume because the tick came due
  // while hidden, then two more inside the minute.
  assert.equal(ticks, 7);
});

test('the visual tick survives a Carousel cycle shorter than its own interval', () => {
  const harness = createHarness();
  const host = createModuleStub();
  let ticks = 0;

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 0,
    visibleTickInterval: 30 * 1000,
    onVisibleTick: () => {
      ticks += 1;
    },
    now: harness.now,
    timers: harness.timers,
    onFetch: () => {},
  });

  lifecycle.start();

  // MMM-Carousel hides every module for slideFadeOutSpeed on each transition and
  // then shows the current one again — so even the module that stays on screen
  // gets a suspend/resume pair every 10 s.
  for (let i = 0; i < 12; i += 1) {
    harness.advance(9 * 1000);
    host.hidden = true;
    lifecycle.suspend();
    harness.advance(1000);
    host.hidden = false;
    lifecycle.resume();
  }

  harness.advance(0);

  // 120 s of wall clock at a 30 s tick: restarting the countdown on every resume
  // would have produced zero ticks.
  assert.equal(ticks, 4);
});

test('a visual tick that came due while hidden fires immediately on resume', () => {
  const harness = createHarness();
  const host = createModuleStub();
  let ticks = 0;

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 0,
    visibleTickInterval: 30 * 1000,
    onVisibleTick: () => {
      ticks += 1;
    },
    now: harness.now,
    timers: harness.timers,
    onFetch: () => {},
  });

  lifecycle.start();
  host.hidden = true;
  lifecycle.suspend();
  harness.advance(5 * MINUTE);
  assert.equal(ticks, 0, 'no visual work while hidden');

  host.hidden = false;
  lifecycle.resume();
  harness.advance(0);
  assert.equal(ticks, 1);
});

test('stop() clears every timer it owns', () => {
  const subject = createSubject({
    lifecycle: { visibleTickInterval: 1000, onVisibleTick: () => {} },
  });
  subject.lifecycle.start();
  assert.ok(subject.harness.pendingTimers() > 0);

  subject.lifecycle.stop();
  assert.equal(subject.harness.pendingTimers(), 0);
});

test('the update interval is clamped to minUpdateInterval', () => {
  const subject = createSubject({
    lifecycle: { updateInterval: 10, minUpdateInterval: 30 * 1000 },
  });

  assert.equal(subject.lifecycle.getState().updateInterval, 30 * 1000);
});

test('requestFetch(force) bypasses quiet hours and the hidden guard', () => {
  const harness = createHarness(new Date(2026, 0, 15, 2, 0, 0).getTime());
  const host = createModuleStub();
  const fetches = [];

  const lifecycle = shared.createLifecycle({
    module: host,
    updateInterval: 30 * MINUTE,
    backgroundRefresh: false,
    quietHours: { from: '23:00', to: '06:00' },
    now: harness.now,
    timers: harness.timers,
    onFetch: (context) => {
      fetches.push(context.reason);
      lifecycle.markDataReceived();
    },
  });

  lifecycle.start();
  host.hidden = true;
  lifecycle.suspend();

  assert.equal(lifecycle.requestFetch('user-action'), false);
  assert.equal(lifecycle.requestFetch('user-action', { force: true }), true);
  assert.deepEqual(fetches, ['start', 'user-action']);
});

test('a throwing callback does not break the lifecycle', () => {
  const subject = createSubject({
    lifecycle: {
      onFetch: () => {
        throw new Error('boom');
      },
    },
  });

  assert.doesNotThrow(() => subject.lifecycle.start());
  assert.equal(subject.lifecycle.getState().started, true);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLogger } = require("../mmm-shared");

function recordingSink() {
  const calls = [];
  const sink = {};
  for (const method of ["debug", "info", "warn", "error"]) {
    sink[method] = (...args) => calls.push({ method, args });
  }
  return { sink, calls };
}

test("without an own logLevel every message goes to the sink, which applies the global level", () => {
  const { sink, calls } = recordingSink();
  const logger = createLogger({ moduleName: "MMM-Test", consoleRef: sink, structured: false });
  logger.debug("d");
  logger.info("i");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["debug", "info"],
  );
});

test("an own logLevel narrows, 'none' silences, unknown values do not filter", () => {
  let level = "warn";
  const { sink, calls } = recordingSink();
  const logger = createLogger({ moduleName: "MMM-Test", consoleRef: sink, getLevel: () => level });
  logger.info("hidden");
  logger.warn("shown");
  level = "NONE";
  logger.error("hidden too");
  level = "verbose";
  logger.debug("unknown level, no own filter");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["warn", "debug"],
  );
});

test("defaults to MagicMirror's Log when it is there", () => {
  const { sink, calls } = recordingSink();
  const original = globalThis.Log;
  globalThis.Log = sink;
  try {
    createLogger({ moduleName: "MMM-Test" }).info("via Log", { apiKey: "k" });
  } finally {
    globalThis.Log = original;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].message, "via Log");
  assert.deepEqual(calls[0].args[0].context, { apiKey: "***redacted***" });
});

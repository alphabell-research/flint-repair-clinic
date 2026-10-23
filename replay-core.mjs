/* alphaBell-authored illustrative replay experiment, not a Flint-generated case.
 * Inspired by https://discuss.huggingface.co/t/190935/4
 * All clocks, spawn intervals, random values and inputs are simulated locally.
 */
export const WORLD = Object.freeze({ width: 600, height: 360, playerRadius: 12, asteroidRadius: 10, playerY: 330 });
export const DEFAULT_INPUTS = Object.freeze([
  { timeMs: 0, direction: 0 }, { timeMs: 500, direction: -1 },
  { timeMs: 1800, direction: 1 }, { timeMs: 3400, direction: -1 },
  { timeMs: 5000, direction: 1 }, { timeMs: 7000, direction: -1 },
  { timeMs: 8500, direction: 0 },
].map(Object.freeze));

function require(condition, message) { if (!condition) throw new Error(message); }
const clone = value => JSON.parse(JSON.stringify(value));

export class SeededRandom {
  constructor(seed) {
    require(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'Seed must be an unsigned 32-bit integer.');
    this.state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }
  nextUint32() {
    let value = this.state;
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }
  next() { return this.nextUint32() / 0x100000000; }
}

export class VirtualClock {
  constructor() { this.nowMs = 0; this.nextId = 1; this.intervals = new Map(); }
  setInterval(callback, periodMs) {
    require(typeof callback === 'function' && Number.isInteger(periodMs) && periodMs > 0, 'Virtual intervals need a callback and a positive integer period.');
    const id = this.nextId++;
    this.intervals.set(id, { id, callback, periodMs, dueMs: this.nowMs + periodMs });
    return id;
  }
  clearInterval(id) { this.intervals.delete(id); }
  get activeCount() { return this.intervals.size; }
  advanceBy(deltaMs) {
    require(Number.isInteger(deltaMs) && deltaMs >= 0, 'Virtual time advances must use nonnegative integer milliseconds.');
    const target = this.nowMs + deltaMs;
    let firings = 0;
    while (true) {
      const next = [...this.intervals.values()].filter(timer => timer.dueMs <= target)
        .sort((a, b) => a.dueMs - b.dueMs || a.id - b.id)[0];
      if (!next) break;
      require(++firings <= 10000, 'Virtual interval budget exceeded.');
      this.nowMs = next.dueMs;
      next.dueMs += next.periodMs;
      next.callback(next.id);
    }
    this.nowMs = target;
  }
}

function checkedOptions(options = {}) {
  const config = { seed: 1337, fixedReset: false, durationMs: 10000, stepMs: 50, spawnEveryMs: 1000, warmupMs: 2000, ...options };
  require(Number.isInteger(config.seed) && config.seed >= 0 && config.seed <= 0xffffffff, 'Seed must be an unsigned 32-bit integer.');
  require(typeof config.fixedReset === 'boolean', 'fixedReset must be true or false.');
  for (const key of ['durationMs', 'stepMs', 'spawnEveryMs', 'warmupMs']) require(Number.isInteger(config[key]) && config[key] > 0, `${key} must be a positive integer.`);
  require(config.stepMs >= 10 && config.stepMs <= 1000, 'This experiment supports fixed steps from 10 to 1000 ms.');
  require(config.durationMs <= 30000 && config.warmupMs <= 30000, 'This bounded experiment supports runs and warmups up to 30 seconds.');
  require(config.spawnEveryMs >= 100 && config.spawnEveryMs % config.stepMs === 0, 'Spawn intervals must be at least 100 ms and align with fixed steps.');
  require(config.durationMs % config.stepMs === 0 && config.warmupMs % config.stepMs === 0, 'Run and warmup durations must align with fixed steps.');
  const inputs = config.inputSchedule ?? DEFAULT_INPUTS.filter(input => input.timeMs <= config.durationMs);
  require(Array.isArray(inputs) && inputs.length > 0, 'An input schedule must contain at least one event.');
  let previous = -1;
  for (const event of inputs) {
    require(event && Number.isInteger(event.timeMs) && event.timeMs >= 0 && event.timeMs <= config.durationMs && event.timeMs % config.stepMs === 0, 'Input timestamps must be inside the run and align with fixed steps.');
    require(event.timeMs > previous, 'Input events must have unique increasing timestamps.');
    require([-1, 0, 1].includes(event.direction), 'Input direction must be -1, 0 or 1.');
    previous = event.timeMs;
  }
  config.inputSchedule = inputs.map(event => ({ timeMs: event.timeMs, direction: event.direction }));
  return config;
}

export class DodgerSimulation {
  constructor(options = {}) {
    this.config = checkedOptions(options);
    this.clock = new VirtualClock();
    this.timerIds = new Set();
    this.startRun(true);
  }
  startRun(clearOldTimers = this.config.fixedReset) {
    if (clearOldTimers) {
      for (const id of this.timerIds) this.clock.clearInterval(id);
      this.timerIds.clear();
    }
    this.hostStartMs = this.clock.nowMs;
    this.random = new SeededRandom(this.config.seed);
    this.player = { x: WORLD.width / 2, y: WORLD.playerY };
    this.asteroids = []; this.spawnCount = 0; this.hits = 0; this.score = 0; this.events = [];
    const timerId = this.clock.setInterval(id => this.spawn(id), this.config.spawnEveryMs);
    this.timerIds.add(timerId);
    return this.snapshot();
  }
  get timeMs() { return this.clock.nowMs - this.hostStartMs; }
  spawn(timerId) {
    const id = ++this.spawnCount;
    const x = WORLD.asteroidRadius + this.random.next() * (WORLD.width - 2 * WORLD.asteroidRadius);
    const velocity = 90 + this.random.next() * 70;
    this.asteroids.push({ id, x, y: -WORLD.asteroidRadius, radius: WORLD.asteroidRadius, velocity });
    this.events.push({ timeMs: this.timeMs, type: 'spawn', timerId, asteroidId: id });
  }
  step(direction = 0) {
    require([-1, 0, 1].includes(direction), 'Input direction must be -1, 0 or 1.');
    const seconds = this.config.stepMs / 1000;
    this.player.x = Math.max(WORLD.playerRadius, Math.min(WORLD.width - WORLD.playerRadius, this.player.x + direction * 150 * seconds));
    for (const asteroid of this.asteroids) asteroid.y += asteroid.velocity * seconds;
    this.asteroids = this.asteroids.filter(asteroid => {
      const touches = Math.hypot(asteroid.x - this.player.x, asteroid.y - this.player.y) < asteroid.radius + WORLD.playerRadius;
      if (touches) this.hits++;
      return !touches && asteroid.y <= WORLD.height + asteroid.radius;
    });
    // Timers fire at the end of a fixed step, after moving existing objects.
    // A newly spawned asteroid has not yet travelled at its birth timestamp.
    this.clock.advanceBy(this.config.stepMs);
    this.score = Math.floor(this.timeMs / 100);
    return this.snapshot();
  }
  snapshot() {
    return { timeMs: this.timeMs, player: { ...this.player }, score: this.score,
      spawnCount: this.spawnCount, hits: this.hits, rngState: this.random.state,
      asteroids: this.asteroids.map(({ id, x, y, radius, velocity }) => ({ id, x, y, radius, velocity })) };
  }
}

function directionAt(schedule, timeMs) {
  let direction = 0;
  for (const event of schedule) { if (event.timeMs > timeMs) break; direction = event.direction; }
  return direction;
}

export function captureRun(simulation, { durationMs = simulation.config.durationMs, inputSchedule = simulation.config.inputSchedule, label = 'run' } = {}) {
  require(Number.isInteger(durationMs) && durationMs > 0 && durationMs % simulation.config.stepMs === 0 && durationMs <= 30000, 'Capture duration must align with fixed steps and stay inside the 30-second budget.');
  const samples = [simulation.snapshot()];
  const activeTimersAtStart = simulation.clock.activeCount;
  for (let time = 0; time < durationMs; time += simulation.config.stepMs) samples.push(simulation.step(directionAt(inputSchedule, time)));
  const perSecond = samples.filter(sample => sample.timeMs % 1000 === 0)
    .map(({ timeMs, spawnCount, asteroids, score, hits }) => ({ timeMs, spawnCount, activeAsteroids: asteroids.length, score, hits }));
  return { label, samples, perSecond, events: clone(simulation.events), diagnostics: { activeTimersAtStart, activeTimersAtEnd: simulation.clock.activeCount, hostStartMs: simulation.hostStartMs } };
}

function differences(left, right, path = '') {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const result = left.length === right.length ? [] : [{ path: `${path}.length`, left: left.length, right: right.length }];
    for (let i = 0; i < Math.min(left.length, right.length); i++) result.push(...differences(left[i], right[i], `${path}[${i}]`));
    return result;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => differences(left[key], right[key], path ? `${path}.${key}` : key));
  }
  return [{ path, left, right }];
}

export function compareRuns(left, right) {
  const length = Math.min(left.samples.length, right.samples.length);
  for (let step = 0; step < length; step++) {
    const fields = differences(left.samples[step], right.samples[step]);
    if (fields.length) return { equal: false, comparedSamples: step + 1, firstDivergence: { timeMs: left.samples[step].timeMs, step, fields, left: clone(left.samples[step]), right: clone(right.samples[step]) } };
  }
  if (left.samples.length !== right.samples.length) return { equal: false, comparedSamples: length, firstDivergence: { timeMs: null, step: length, fields: [{ path: 'samples.length', left: left.samples.length, right: right.samples.length }], left: null, right: null } };
  return { equal: true, comparedSamples: length, firstDivergence: null };
}

export function checkBounds(run) {
  const failures = [];
  for (const sample of run.samples) {
    const numbers = [sample.timeMs, sample.player.x, sample.player.y, sample.score, sample.spawnCount, sample.hits, sample.rngState, ...sample.asteroids.flatMap(a => [a.id, a.x, a.y, a.radius, a.velocity])];
    if (!numbers.every(Number.isFinite)) failures.push({ timeMs: sample.timeMs, reason: 'non-finite value' });
    if (sample.player.x < WORLD.playerRadius || sample.player.x > WORLD.width - WORLD.playerRadius || sample.player.y !== WORLD.playerY) failures.push({ timeMs: sample.timeMs, reason: 'player outside bounds' });
    if (sample.asteroids.some(a => a.x < a.radius || a.x > WORLD.width - a.radius || a.y < -a.radius || a.y > WORLD.height + a.radius)) failures.push({ timeMs: sample.timeMs, reason: 'asteroid outside bounded travel area' });
  }
  return { pass: failures.length === 0, samplesChecked: run.samples.length, failures };
}

export function runExperiment(options = {}) {
  const config = checkedOptions(options);
  const freshA = captureRun(new DodgerSimulation(config), { label: 'Fresh A' });
  const freshB = captureRun(new DodgerSimulation(config), { label: 'Fresh B' });
  const reused = new DodgerSimulation(config);
  captureRun(reused, { durationMs: config.warmupMs, inputSchedule: [{ timeMs: 0, direction: 0 }], label: 'Warmup' });
  reused.startRun(config.fixedReset);
  const restarted = captureRun(reused, { label: 'Restarted' });
  const comparisons = { fresh: compareRuns(freshA, freshB), restart: compareRuns(freshA, restarted) };
  const inputRandom = new SeededRandom((config.seed ^ 0xa5a5a5a5) >>> 0);
  const soakInputs = [];
  for (let timeMs = 0; timeMs < 30000; timeMs += config.stepMs * 5) soakInputs.push({ timeMs, direction: Math.floor(inputRandom.next() * 3) - 1 });
  const soak = captureRun(new DodgerSimulation(config), { durationMs: 30000, inputSchedule: soakInputs, label: 'Bounded soak' });
  const soakBounds = checkBounds(soak);
  const finiteBounds = [freshA, freshB, restarted].map(checkBounds);
  const start = restarted.samples[0];
  const resetBasics = start.score === 0 && start.spawnCount === 0 && start.hits === 0 && start.asteroids.length === 0 && start.player.x === WORLD.width / 2 && start.player.y === WORLD.playerY;
  return { schemaVersion: 1, provenance: { author: 'alphaBell', kind: 'Illustrative synthetic experiment', inspiration: 'https://discuss.huggingface.co/t/190935/4', flintGenerated: false }, world: WORLD, config,
    runs: { freshA, freshB, restarted }, comparisons, firstDivergence: comparisons.restart.firstDivergence,
    spawnCounts: freshA.perSecond.map((sample, index) => ({ timeMs: sample.timeMs, freshA: sample.spawnCount, freshB: freshB.perSecond[index].spawnCount, restarted: restarted.perSecond[index].spawnCount, extra: restarted.perSecond[index].spawnCount - sample.spawnCount })),
    checks: {
      freshReplay: { pass: comparisons.fresh.equal, detail: `${comparisons.fresh.comparedSamples} fixed-step samples compared across two fresh simulations.` },
      restartReplay: { pass: comparisons.restart.equal, detail: comparisons.restart.equal ? 'Restarted gameplay state matches the fresh run at every fixed step.' : `First gameplay-state divergence at ${comparisons.restart.firstDivergence.timeMs} ms.` },
      resetBasics: { pass: resetBasics, detail: 'Player position, score, hit count and asteroid count reset before replay.' },
      finiteBounds: { pass: finiteBounds.every(result => result.pass), detail: `${finiteBounds.reduce((sum, result) => sum + result.samplesChecked, 0)} snapshots checked for finite values and travel bounds.` },
      boundedSoak: { pass: soakBounds.pass, detail: `${soakBounds.samplesChecked} snapshots in a separate 30-second seeded input soak; checks finite values and bounds.`, samplesChecked: soakBounds.samplesChecked, failures: soakBounds.failures },
    },
  };
}

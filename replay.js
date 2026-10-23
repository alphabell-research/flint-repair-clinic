import { runExperiment, WORLD } from './replay-core.mjs';

const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
let experiment;
let fixedReset = false;
let currentTime = 1000;
let playing = false;
let animationId = null;
let animationStart = null;
let replayStart = 0;

function announce(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function svgElement(tag, attributes = {}, text) {
  const element = document.createElementNS(svgNS, tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderWorld(id, sample, label) {
  const world = $(id);
  world.setAttribute('aria-label', `${label} at ${(sample.timeMs / 1000).toFixed(2)} seconds. ${sample.spawnCount} cumulative spawns, score ${sample.score}, ${sample.hits} hits.`);
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 35; i++) {
    fragment.append(svgElement('circle', { cx: (i * 163 + 53) % WORLD.width, cy: (i * 83 + 29) % WORLD.height, r: i % 4 === 0 ? 1.3 : .7, class: 'space-star' }));
  }
  for (const y of [90, 180, 270]) fragment.append(svgElement('line', { x1: 0, x2: WORLD.width, y1: y, y2: y, class: 'space-grid' }));
  fragment.append(svgElement('text', { x: 16, y: 25, class: 'world-note' }, 'SAVED FIXED-STEP STATE'));
  for (const asteroid of sample.asteroids) {
    if (asteroid.y < 0) {
      fragment.append(svgElement('path', { d: `M${asteroid.x - 6},3 L${asteroid.x + 6},3 L${asteroid.x},12 Z`, class: 'asteroid', 'data-spawn-marker': asteroid.id }));
    } else {
      fragment.append(svgElement('circle', { cx: asteroid.x, cy: asteroid.y, r: asteroid.radius, class: 'asteroid', 'data-asteroid-id': asteroid.id }));
      fragment.append(svgElement('text', { x: asteroid.x, y: asteroid.y, class: 'asteroid-label' }, asteroid.id));
    }
  }
  fragment.append(svgElement('path', { d: `M${sample.player.x - 5},${sample.player.y + 11} L${sample.player.x},${sample.player.y + 20} L${sample.player.x + 5},${sample.player.y + 11} Z`, class: 'ship-flame' }));
  fragment.append(svgElement('path', { d: `M${sample.player.x},${sample.player.y - 14} L${sample.player.x + 11},${sample.player.y + 11} L${sample.player.x},${sample.player.y + 6} L${sample.player.x - 11},${sample.player.y + 11} Z`, class: 'ship', 'data-player-x': sample.player.x }));
  world.replaceChildren(fragment);
}

function currentSample(run) {
  return run.samples[Math.min(run.samples.length - 1, Math.round(currentTime / experiment.config.stepMs))];
}

function renderFrame() {
  const fresh = currentSample(experiment.runs.freshA), restart = currentSample(experiment.runs.restarted);
  renderWorld('fresh-world', fresh, 'Fresh run'); renderWorld('restart-world', restart, 'Restarted run');
  for (const [name, sample] of [['fresh', fresh], ['restart', restart]]) {
    $(name + '-spawns').textContent = sample.spawnCount;
    $(name + '-score').textContent = sample.score;
    $(name + '-hits').textContent = sample.hits;
  }
  $('timeline').value = currentTime;
  $('clock').textContent = `T + ${(currentTime / 1000).toFixed(2)} s`;
  $('timeline').setAttribute('aria-valuetext', `${(currentTime / 1000).toFixed(2)} seconds. Fresh ${fresh.spawnCount} spawns, restarted ${restart.spawnCount} spawns.`);
  for (const row of $('spawn-rows').querySelectorAll('tr')) row.classList.toggle('active', Number(row.dataset.time) === Math.floor(currentTime / 1000) * 1000);
}

function renderSummary() {
  const split = experiment.firstDivergence;
  const matched = experiment.comparisons.restart.equal;
  $('mode-leaked').setAttribute('aria-pressed', String(!fixedReset));
  $('mode-fixed').setAttribute('aria-pressed', String(fixedReset));
  $('timer-answer').textContent = fixedReset ? 'Yes.' : 'No.';
  $('timer-answer').classList.toggle('bug-color', !fixedReset);
  $('verdict').classList.toggle('fixed', matched);
  $('verdict-label').textContent = matched ? 'RESTART REPLAY MATCHES' : 'FIRST GAMEPLAY-STATE DIVERGENCE';
  $('verdict-title').textContent = matched ? 'One timer. The same replay.' : 'The second timer gives itself away.';
  $('verdict-detail').textContent = matched ? `${experiment.comparisons.restart.comparedSamples} saved gameplay states match the fresh run, including positions, spawns, score and random state.` : `At ${(split.timeMs / 1000).toFixed(2)} s: ${split.left.spawnCount} fresh spawn, ${split.right.spawnCount} restarted spawns. Basic reset checks still pass.`;
  $('divergence-time').replaceChildren();
  if (matched) $('divergence-time').textContent = 'MATCH';
  else {
    $('divergence-time').append(document.createTextNode((split.timeMs / 1000).toFixed(2)));
    const unit = document.createElement('span'); unit.textContent = 's'; $('divergence-time').append(unit);
  }
  $('divergence-caption').textContent = matched ? 'all 201 saved states' : 'after the restart';
  $('jump').disabled = matched;
  $('fresh-timers').textContent = `${experiment.runs.freshA.diagnostics.activeTimersAtStart} virtual timer`;
  $('restart-timers').textContent = `${experiment.runs.restarted.diagnostics.activeTimersAtStart} virtual timer${experiment.runs.restarted.diagnostics.activeTimersAtStart === 1 ? '' : 's'}`;
  const labels = { freshReplay: 'Fresh A equals fresh B', restartReplay: 'Restart equals a fresh run', resetBasics: 'Position and score reset', finiteBounds: 'Finite values and travel bounds', boundedSoak: 'Bounded 30-second soak' };
  const checks = document.createDocumentFragment();
  for (const [key, check] of Object.entries(experiment.checks)) {
    const row = document.createElement('div'); row.className = 'check-row'; row.dataset.check = key; row.dataset.pass = String(check.pass);
    const result = document.createElement('span'); result.className = `check-result${check.pass ? '' : ' fail'}`; result.textContent = check.pass ? '✓' : '×'; result.setAttribute('aria-label', check.pass ? 'Pass' : 'Fail');
    const text = document.createElement('div'); const title = document.createElement('strong'); title.textContent = labels[key];
    const detail = document.createElement('p'); detail.textContent = check.detail; text.append(title, detail); row.append(result, text); checks.append(row);
  }
  $('checks').replaceChildren(checks);
  const rows = document.createDocumentFragment();
  for (const sample of experiment.spawnCounts) {
    const row = document.createElement('tr'); row.dataset.time = sample.timeMs;
    for (const [index, value] of [sample.timeMs / 1000 + ' s', sample.freshA, sample.freshB, sample.restarted, sample.extra ? `+${sample.extra}` : '0'].entries()) {
      const cell = document.createElement('td'); cell.textContent = value;
      if (index === 4 && sample.extra) cell.className = 'extra'; row.append(cell);
    }
    rows.append(row);
  }
  $('spawn-rows').replaceChildren(rows);
  $('difference-fields').textContent = split ? JSON.stringify({ timeMs: split.timeMs, fields: split.fields }, null, 2) : 'No gameplay-state differences across the complete replay.';
  $('configuration').textContent = JSON.stringify({ provenance: experiment.provenance, config: experiment.config }, null, 2);
}

function pause() {
  playing = false; animationStart = null;
  if (animationId !== null) cancelAnimationFrame(animationId);
  animationId = null; $('play').textContent = '▶ Play replay';
}

function playFrame(now) {
  if (!playing) return;
  if (animationStart === null) animationStart = now;
  const elapsed = now - animationStart;
  currentTime = Math.min(experiment.config.durationMs, Math.floor((replayStart + elapsed) / experiment.config.stepMs) * experiment.config.stepMs);
  renderFrame();
  if (currentTime >= experiment.config.durationMs) {
    pause(); announce('Replay complete. Saved simulation states were displayed without changing the experiment.');
  } else animationId = requestAnimationFrame(playFrame);
}

function run() {
  pause();
  try {
    const raw = $('seed').value;
    if (!raw.trim()) throw new Error('Enter a seed from 0 to 4294967295.');
    const seed = Number(raw);
    const next = runExperiment({ seed, fixedReset });
    experiment = next;
    currentTime = experiment.firstDivergence?.timeMs ?? 1000;
    renderSummary(); renderFrame();
    announce(fixedReset ? 'Timer reset fixed. Fresh and restarted replays match all saved gameplay states.' : 'Leaked timer reproduced. First gameplay-state divergence is 1000 ms after restart.');
  } catch (error) { announce(error.message, true); }
}

$('mode-leaked').addEventListener('click', () => { fixedReset = false; run(); });
$('mode-fixed').addEventListener('click', () => { fixedReset = true; run(); });
$('run-experiment').addEventListener('click', run);
$('seed').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); run(); } });
$('timeline').addEventListener('input', () => { pause(); currentTime = Number($('timeline').value); renderFrame(); });
$('jump').addEventListener('click', () => { if (experiment.firstDivergence) { pause(); currentTime = experiment.firstDivergence.timeMs; renderFrame(); announce('Showing the first gameplay-state divergence. Spawn arrows mark asteroids born just above the board.'); } });
$('play').addEventListener('click', () => {
  if (playing) { pause(); announce('Replay paused.'); return; }
  if (currentTime >= experiment.config.durationMs) currentTime = 0;
  replayStart = currentTime; animationStart = null; playing = true;
  $('play').textContent = 'Ⅱ Pause replay'; animationId = requestAnimationFrame(playFrame);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
$('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(experiment, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `alphabell-illustrative-replay-${experiment.config.seed}-${experiment.config.fixedReset ? 'fixed' : 'leaked'}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce('Experiment downloaded with the complete saved states, input schedule and community provenance.');
});

run();

import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD, SeededRandom, VirtualClock, DodgerSimulation, captureRun, compareRuns, checkBounds, runExperiment } from './replay-core.mjs';

test('xorshift32 has a known vector and seed zero maps to a repeatable nonzero state', () => {
  const random = new SeededRandom(1);
  assert.deepEqual(Array.from({ length:5 }, () => random.nextUint32()), [270369,67634689,2647435461,307599695,2398689233]);
  const a = new SeededRandom(0), b = new SeededRandom(0);
  assert.notEqual(a.state,0); assert.equal(a.next(),b.next());
});

test('virtual intervals fire at exact boundaries and clearing prevents later callbacks', () => {
  const clock = new VirtualClock(), events = [];
  const first = clock.setInterval(id => events.push([clock.nowMs,id]),1000);
  const second = clock.setInterval(id => events.push([clock.nowMs,id]),1000);
  clock.advanceBy(999); assert.deepEqual(events,[]);
  clock.advanceBy(1); assert.deepEqual(events,[[1000,first],[1000,second]]);
  clock.clearInterval(first); clock.advanceBy(2000);
  assert.deepEqual(events.slice(2),[[2000,second],[3000,second]]); assert.equal(clock.activeCount,1);
});

test('two fresh runs reproduce every gameplay-state field and input boundary', () => {
  const report = runExperiment({seed:98765});
  assert.equal(report.runs.freshA.samples.length,201); assert.equal(report.comparisons.fresh.equal,true);
  assert.deepEqual(report.runs.freshA.samples,report.runs.freshB.samples);
  const at = time => report.runs.freshA.samples.find(s=>s.timeMs===time);
  assert.equal(at(500).player.x,300); assert.equal(at(550).player.x,292.5);
  assert.equal(at(1800).player.x,105); assert.equal(at(1850).player.x,112.5);
});

test('a leaked interval passes reset basics but first splits gameplay at the doubled spawn', () => {
  const report = runExperiment({fixedReset:false});
  assert.equal(report.checks.resetBasics.pass,true); assert.equal(report.comparisons.restart.equal,false);
  assert.equal(report.firstDivergence.timeMs,1000); assert.equal(report.firstDivergence.step,20);
  assert.ok(report.firstDivergence.fields.some(x=>x.path==='spawnCount'&&x.left===1&&x.right===2));
  assert.equal(report.runs.restarted.diagnostics.activeTimersAtStart,2);
  assert.equal(report.runs.freshA.diagnostics.activeTimersAtStart,1);
  assert.deepEqual(report.runs.freshA.samples.slice(0,20),report.runs.restarted.samples.slice(0,20));
  for(const row of report.spawnCounts){
    const predicted = Math.floor(row.timeMs/1000);
    assert.equal(row.freshA,predicted); assert.equal(row.freshB,predicted); assert.equal(row.restarted,2*predicted);
  }
});

test('clearing old intervals restores the complete trajectory with a different host-clock origin', () => {
  const report = runExperiment({fixedReset:true});
  assert.equal(report.runs.restarted.diagnostics.hostStartMs,2000);
  assert.equal(report.runs.freshA.diagnostics.hostStartMs,0);
  assert.equal(report.runs.restarted.diagnostics.activeTimersAtStart,1);
  assert.equal(report.comparisons.restart.equal,true); assert.equal(report.firstDivergence,null);
  assert.deepEqual(report.runs.freshA.samples,report.runs.restarted.samples);
  for(const row of report.spawnCounts) assert.equal(row.extra,0);
});

test('reset cleanup survives repeated restarts while the injected leak accumulates intervals', () => {
  const fixed = new DodgerSimulation({fixedReset:true});
  const baseline = captureRun(new DodgerSimulation({fixedReset:true}),{durationMs:1000});
  for(let i=0;i<5;i++){
    fixed.startRun(true); const run = captureRun(fixed,{durationMs:1000});
    assert.equal(fixed.clock.activeCount,1); assert.deepEqual(run.samples,baseline.samples);
  }
  const broken = new DodgerSimulation();
  for(let timers=2;timers<=4;timers++){
    broken.startRun(false); const run=captureRun(broken,{durationMs:1000});
    assert.equal(run.samples.at(-1).spawnCount,timers); assert.equal(broken.clock.activeCount,timers);
  }
});

test('first spawn coordinates and birth time match an independent analytic control', () => {
  const sim = new DodgerSimulation({seed:1});
  const run=captureRun(sim,{durationMs:1050,inputSchedule:[{timeMs:0,direction:0}]});
  const born=run.samples.find(s=>s.timeMs===1000).asteroids[0];
  assert.equal(born.x,10+(270369/4294967296)*580);
  assert.equal(born.velocity,90+(67634689/4294967296)*70);
  assert.equal(born.y,-10);
  assert.equal(run.samples.at(-1).asteroids[0].y,-10+born.velocity*.05);
});

test('bounds guards reject injected nonfinite and runaway state and the seeded soak stays bounded', () => {
  const report=runExperiment();
  assert.equal(report.checks.finiteBounds.pass,true); assert.equal(report.checks.boundedSoak.pass,true);
  assert.equal(report.checks.boundedSoak.samplesChecked,601);
  const nonfinite=structuredClone(report.runs.freshA); nonfinite.samples[10].player.x=NaN;
  assert.equal(checkBounds(nonfinite).pass,false);
  const runaway=structuredClone(report.runs.freshA); runaway.samples[10].player.x=WORLD.width+100;
  assert.equal(checkBounds(runaway).pass,false);
});

test('comparison reports the earliest actual field change and never compares virtual timer IDs', () => {
  const run=captureRun(new DodgerSimulation(),{durationMs:1000}); const altered=structuredClone(run);
  altered.samples[3].player.x+=1; altered.samples[10].score+=100;
  const result=compareRuns(run,altered);
  assert.equal(result.firstDivergence.timeMs,150); assert.deepEqual(result.firstDivergence.fields,[{path:'player.x',left:300,right:301}]);
  const diagnosticsOnly=structuredClone(run); diagnosticsOnly.diagnostics.activeTimersAtStart=99;
  assert.equal(compareRuns(run,diagnosticsOnly).equal,true);
});

test('snapshots and returned runs do not alias mutable simulation state', () => {
  const sim=new DodgerSimulation();const initial=sim.snapshot();sim.step(-1);
  assert.equal(initial.timeMs,0); assert.equal(initial.player.x,300); assert.deepEqual(initial.asteroids,[]);
  const report=runExperiment();report.runs.freshA.samples[0].player.x=123;
  assert.equal(report.runs.freshB.samples[0].player.x,300);
});

test('simulation outcomes do not depend on wall-clock time or ambient randomness', () => {
  const before=runExperiment({seed:42,fixedReset:true});
  const random=Math.random,now=Date.now,interval=globalThis.setInterval;
  let after;
  try{
    Math.random=()=>{throw new Error('Ambient randomness used');};Date.now=()=>{throw new Error('Wall clock used');};
    globalThis.setInterval=()=>{throw new Error('Real timer used');};
    after=runExperiment({seed:42,fixedReset:true});
  }finally{Math.random=random;Date.now=now;globalThis.setInterval=interval;}
  assert.deepEqual(after,before);
});

test('local simulation limits and malformed input schedules fail explicitly', () => {
  for(const options of[{seed:-1},{seed:NaN},{seed:4294967296},{stepMs:0},{stepMs:7},{durationMs:10001},{spawnEveryMs:101},{fixedReset:'false'},{inputSchedule:[]},{inputSchedule:[{timeMs:25,direction:0}]},{inputSchedule:[{timeMs:0,direction:2}]}])assert.throws(()=>runExperiment(options));
});

test('provenance stays explicitly alphaBell-authored and outside historical Flint cases', () => {
  const {provenance}=runExperiment();
  assert.equal(provenance.author,'alphaBell'); assert.equal(provenance.flintGenerated,false);
  assert.equal(provenance.inspiration,'https://discuss.huggingface.co/t/190935/4');
});

'use strict';
const $ = id => document.getElementById(id);
let data, current, runningSource = '', sequence = 0, errors = [], bootTimer, probeTimer, toastTimer;
const frame = $('game');
const scope = "Quick checks cover startup, synthetic keyboard movement and restart. Play to test objectives and native touch.";

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
}
function state(label, kind = '') {
  $('status').textContent = label;
  $('status').dataset.kind = kind;
}
function result(text, kind = '') {
  $('result').textContent = text;
  $('result').className = 'result ' + kind;
}
function selectCase(id, updateHash = true) {
  current = data.cases.find(c => c.id === id) || data.cases[0];
  if (updateHash) {
    const url = new URL(location.href);
    url.searchParams.delete('case');
    url.hash = current.id;
    history.replaceState(null, '', url);
  }
  document.querySelectorAll('.case-button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.case === current.id)));
  $('case-label').textContent = current.label;
  $('case-title').textContent = current.title;
  $('hint-text').textContent = current.lesson;
  $('hint-text').hidden = true;
  $('hint').setAttribute('aria-expanded', 'false');
  $('editor').value = current.before;
  $('diff').textContent = current.diff;
  $('case-note').textContent = current.note;
  $('original-error').textContent = current.errors.join('\n');
  const historical = current.historical_checks.checks || [];
  $('recorded-checks').textContent = `${historical.length} viewport checks recorded. This exact repaired candidate was selected for the release gallery. ${current.deep_review.scope ? 'Additional review: ' + current.deep_review.scope + '.' : ''}`;
  $('hashes').textContent = `Failed record: ${current.before_record}\nSHA-256: ${current.before_sha256}\nRepaired record: ${current.after_record}\nSHA-256: ${current.after_sha256}\nDataset revision: ${data.source_revision}`;
  $('hashes').style.whiteSpace = 'pre-wrap';
  $('source-dataset').href = 'https://huggingface.co/datasets/' + data.source_dataset + '/tree/' + data.source_revision;
  updateEditor();
  run(current.before);
  requestAnimationFrame(jumpToFault);
}
function updateEditor() {
  const text = $('editor').value;
  $('source-state').textContent = text === current.before ? 'Original failure' : text === current.after ? 'Recorded repair' : 'Your edit';
  $('editor-caption').textContent = `${text.split('\n').length} lines · complete game HTML · changes stay in this tab`;
}
function jumpToFault() {
  const editor = $('editor');
  const lines = editor.value.split('\n');
  const line = Math.min(current.line - 1, lines.length - 1);
  const start = lines.slice(0, line).reduce((n, text) => n + text.length + 1, 0);
  editor.focus({preventScroll: true});
  editor.setSelectionRange(start, start + lines[line].length);
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight);
  editor.scrollTop = Math.max(0, (line - 3) * lineHeight);
}

// The child has an opaque origin, no network or storage access, and no parent DOM access.
// It may report display-only diagnostics. Its messages never modify source or evidence.
function instrument(source, runId) {
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; font-src \'none\'; media-src \'none\'; object-src \'none\'; frame-src \'none\'; worker-src \'none\'; base-uri \'none\'; form-action \'none\'">';
  const bridge = `<script>(()=>{
    const runId=${runId};
    const send=(type,body={})=>parent.postMessage({clinic:true,runId,type,...body},'*');
    let faults=0,busy=false;
    const clean=s=>String(s).slice(0,700);
    addEventListener('error',e=>{faults++;send('error',{message:clean(e.message),line:e.lineno});});
    addEventListener('unhandledrejection',e=>{faults++;send('error',{message:clean(e.reason)});});
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const snap=()=>{
      if(!window.arcade||typeof arcade.snapshot!=='function'||typeof arcade.restart!=='function')throw Error('The required restart/snapshot game interface is missing.');
      const s=arcade.snapshot();
      if(!s||typeof s.phase!=='string'||!s.player||!Number.isFinite(s.player.x)||!Number.isFinite(s.player.y))throw Error('The player snapshot must have finite x/y coordinates and a phase.');
      return JSON.parse(JSON.stringify(s));
    };
    const key=(type,key)=>dispatchEvent(new KeyboardEvent(type,{key,bubbles:true,cancelable:true}));
    const begin=()=>{
      const b=document.getElementById('startBtn')||document.getElementById('start');
      if(b){b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse'}));b.click();}
      key('keydown',' ');key('keyup',' ');
    };
    const fresh=async()=>{arcade.restart();await wait(80);const initial=snap();begin();await wait(70);return initial;};
    const moved=(a,b,axis)=>Math.abs(a.player[axis]-b.player[axis])>0.5;
    addEventListener('message',async e=>{
      if(e.source!==parent||!e.data||e.data.runId!==runId||busy)return;
      if(e.data.command==='restart'){
        try{arcade.restart();send('restarted');}catch(err){send('probe-error',{message:clean(err.message)});}return;
      }
      if(e.data.command!=='probe')return;
      busy=true;
      try{
        snap();const baseline=await fresh();const start=snap();
        key('keydown','ArrowRight');await wait(280);key('keyup','ArrowRight');const right=snap();
        await fresh();const verticalStart=snap();
        key('keydown','ArrowDown');await wait(280);key('keyup','ArrowDown');const down=snap();
        arcade.restart();await wait(100);const reset=snap();
        const checks={horizontal:moved(start,right,'x'),vertical:moved(verticalStart,down,'y'),restart:reset.phase===baseline.phase&&Math.abs(reset.player.x-baseline.player.x)<.1&&Math.abs(reset.player.y-baseline.player.y)<.1,startup:faults===0};
        send('checks',{checks});
      }catch(err){send('probe-error',{message:clean(err.message)});}
      finally{key('keyup','ArrowRight');key('keyup','ArrowDown');busy=false;}
    });
    addEventListener('DOMContentLoaded',()=>setTimeout(()=>{
      try{snap();send('ready',{faults});}catch(err){send('probe-error',{message:clean(err.message)});}
    },220));
  })();<\/script>`;
  // Install restrictions before any untrusted markup, including comments with fake head tags.
  // HTML's parser handles the saved document's nested html/head/body tags inside this wrapper.
  return '<!doctype html><html><head>' + csp + bridge + '</head><body>' + source + '</body></html>';
}
function run(source) {
  clearTimeout(bootTimer); clearTimeout(probeTimer);
  sequence++;
  errors = [];
  runningSource = source;
  $('check').disabled = true;
  $('restart').disabled = true;
  state('Starting');
  result('Executing this candidate in the game preview.');
  frame.srcdoc = instrument(source, sequence);
  bootTimer = setTimeout(() => {
    if (!errors.length) {
      state('No startup signal', 'error');
      result('The game did not report a usable interface. Inspect its source or reset to the recorded candidate.', 'error');
    }
  }, 7000);
}
function command(name) { frame.contentWindow.postMessage({command:name,runId:sequence}, '*'); }
addEventListener('message', e => {
  const d=e.data;
  if (e.source !== frame.contentWindow || !d || d.clinic !== true || d.runId !== sequence) return;
  if (d.type==='error') {
    clearTimeout(bootTimer);
    const message = typeof d.message === 'string' ? d.message.slice(0,700) : 'Game execution error';
    if (!errors.includes(message) && errors.length < 5) errors.push(message);
    state('Broken', 'error');
    result(errors.join('\n'), 'error');
  } else if (d.type==='ready') {
    clearTimeout(bootTimer);
    $('check').disabled = false;
    $('restart').disabled = false;
    if (errors.length || d.faults) return;
    state('Running', 'ok');
    result('Startup succeeded. Try the game, or check both movement axes and restart.', 'ok');
  } else if(d.type==='checks') {
    clearTimeout(probeTimer);
    $('check').disabled = false;
    const checks = d.checks;
    if(!checks || ['horizontal','vertical','restart','startup'].some(k=>typeof checks[k]!=='boolean'))return;
    const ok = Object.values(checks).every(Boolean) && !errors.length;
    state(ok ? 'Quick checks passed' : 'Check failed', ok ? 'ok' : 'error');
    result(['startup','horizontal','vertical','restart'].map(k=>(checks[k] ? 'PASS' : 'FAIL')+' '+({horizontal:'keyboard horizontal',vertical:'keyboard vertical',startup:'no startup error',restart:'restart to initial state'}[k])).join('\n')+'\n\n'+scope, ok?'ok':'error');
  } else if(d.type==='probe-error') {
    clearTimeout(probeTimer);clearTimeout(bootTimer);
    $('check').disabled = false;
    state(errors.length ? 'Broken' : 'Check failed', 'error');
    result(errors.length ? errors.join('\n') : String(d.message).slice(0,700), 'error');
  } else if(d.type==='restarted') { toast('Game restarted'); }
});
$('run').addEventListener('click',()=>run($('editor').value));
$('repair').addEventListener('click',()=>{
  $('editor').value=current.after;updateEditor();run(current.after);
  $('evidence').open=true;
  jumpToFault();
});
$('reset').addEventListener('click',()=>{$('editor').value=current.before;updateEditor();run(current.before);jumpToFault();});
$('editor').addEventListener('input',updateEditor);
$('fault').addEventListener('click',jumpToFault);
$('hint').addEventListener('click',()=>{
  const open=$('hint-text').hidden;
  $('hint-text').hidden=!open;
  $('hint').setAttribute('aria-expanded',String(open));
});
$('check').addEventListener('click',()=>{
  $('check').disabled=true;state('Checking');result('Checking startup, horizontal and vertical movement, then restart.');command('probe');
  probeTimer=setTimeout(()=>{$('check').disabled=false;state('Check timed out','error');result('The controls check did not finish. Run the code again to reset the preview.','error');},7000);
});
$('restart').addEventListener('click',()=>command('restart'));
$('share').addEventListener('click',async()=>{
  // Canonical links open the selected case inside the Hugging Face Space.
  const url='https://alphabell-flint-repair-clinic.static.hf.space/?case='+encodeURIComponent(current.id);
  try{await navigator.clipboard.writeText(url);toast('Case link copied');}
  catch {toast('Copy this link: '+url);}
});
$('download').addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify({...data,cases:[current]},null,2)+'\n'],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='flint-'+current.id+'-repair.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
addEventListener('hashchange',()=>{if(data)selectCase(location.hash.slice(1),false);});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){clearTimeout(bootTimer);clearTimeout(probeTimer);frame.srcdoc='';state('Paused');$('check').disabled=true;$('restart').disabled=true;}
  else if(current && runningSource) run(runningSource);
});
fetch('cases.json').then(r=>{if(!r.ok)throw Error('Case download failed');return r.json();}).then(d=>{
  data=d;
  for(const [index,c] of d.cases.entries()){
    const b=document.createElement('button');b.type='button';b.className='case-button';b.dataset.case=c.id;
    const number=document.createElement('span');number.className='case-num';number.textContent='0'+(index+1);
    const label=document.createElement('span'),title=document.createElement('strong'),small=document.createElement('small');
    title.textContent=c.title;small.textContent=c.label;label.append(title,small);b.append(number,label);b.addEventListener('click',()=>selectCase(c.id));$('case-list').append(b);
  }
  const query=new URLSearchParams(location.search).get('case');
  selectCase(query || location.hash.slice(1) || d.cases[0].id);
}).catch(()=>{state('Unavailable','error');$('case-title').textContent='Cases could not load';result('Refresh this page to download the public repair cases.','error');});

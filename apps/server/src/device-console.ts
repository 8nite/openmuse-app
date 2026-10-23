/** The console renders only a screenshot; remote screen content never runs code here. */
export function deviceConsole(previewUrl: string) {
  const preview = JSON.stringify(previewUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenMuse phone</title><style>
*{box-sizing:border-box}body{margin:0;background:#fcfcfc;color:#172125;font:14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:flex;justify-content:center}
#wrap{width:100%;max-width:480px}header{padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px}#status{color:#697176;font-size:12px}#status.live{color:#248258}
button,input{font:inherit;border:1px solid #e9edef;border-radius:24px;padding:10px 14px;background:white;color:inherit;min-height:42px}
button{cursor:pointer}button:hover{background:#edf7fd}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #1473c8;outline-offset:2px}
form{padding:0 12px 10px;display:flex;gap:8px}input{flex:1;min-width:0;background:#f1f3f4;border-color:transparent}#type{background:#c8e7ff}
nav{display:flex;gap:6px;padding:0 12px 12px;flex-wrap:wrap}nav button{font-size:12px;min-height:36px;padding:7px 12px}
#stage{overflow:hidden;background:#101418;border-radius:18px;min-height:320px;margin:0 8px;display:flex;justify-content:center}img{display:block;max-width:100%;height:auto;max-height:70vh;cursor:crosshair;touch-action:none}img.stale{opacity:.45;pointer-events:none}
#error{margin:0 12px 12px;color:#984a41;background:#fbefed;padding:12px;border-radius:14px}#error:empty{display:none}footer{padding:12px;color:#697176;font-size:12px;line-height:1.5}
</style><div id="wrap"><header><strong>Phone</strong><span id="status" role="status">Connecting…</span><button id="refresh" aria-label="Refresh phone preview">↻</button></header>
<form><input id="text" aria-label="Text to type on phone" placeholder="Type on the phone" autocomplete="off"><button id="type" type="submit">Send text</button></form>
<nav aria-label="Phone keys"><button data-key="back">Back ◁</button><button data-key="home">Home ○</button><button data-key="recents">Recents □</button><button data-key="play_pause">Play/Pause ⏯</button></nav>
<div id="error" role="alert"></div><div id="stage"><img id="screen" class="stale" alt="Live phone screen, tap or swipe to interact" draggable="false"></div>
<footer>Tap to select, drag to swipe. You’re controlling the paired phone worker.</footer></div><script>
const image=document.querySelector('#screen'),error=document.querySelector('#error'),status=document.querySelector('#status'),field=document.querySelector('#text');
let refreshing=false,sending=false,imageUrl,live=false,previewFailed=false,dragStart=null;
function controls(){document.querySelectorAll('nav button,#type').forEach(button=>button.disabled=sending||!live);image.classList.toggle('stale',!live||sending);}
async function refresh(){if(refreshing||sending||document.hidden)return;refreshing=true;try{
const r=await fetch(${preview},{cache:'no-store',signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error(r.status===401?'Session access expired. Close this view and open the phone again.':'Phone disconnected. Reconnect from OpenMuse.');
const blob=await r.blob();const next=URL.createObjectURL(blob);await new Promise((resolve,reject)=>{const probe=new Image();probe.onload=resolve;probe.onerror=()=>{URL.revokeObjectURL(next);reject(new Error('The phone preview could not be displayed.'));};probe.src=next;});
if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=next;image.src=next;live=true;status.textContent='Live';status.className='live';if(previewFailed){error.textContent='';previewFailed=false;}
}catch(e){live=false;previewError=true;status.textContent='Disconnected';status.className='';error.textContent=e.message;}finally{refreshing=false;controls();}}
async function input(body){if(sending||!live)return false;sending=true;controls();error.textContent='';status.textContent='Updating…';let ok=false;try{
const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
if(!r.ok){const data=await r.json();throw new Error(typeof data.error==='string'?data.error:'Phone action failed. Your text is still here.');}ok=true;
}catch(e){error.textContent=e.message;}finally{sending=false;controls();await refresh();}return ok;}
function point(e){const r=image.getBoundingClientRect();return{x:Math.min(2000,Math.max(0,Math.floor((e.clientX-r.left)*image.naturalWidth/r.width))),y:Math.min(4000,Math.max(0,Math.floor((e.clientY-r.top)*image.naturalHeight/r.height)))};}
image.addEventListener('pointerdown',e=>{if(!live||sending)return;dragStart={...point(e),t:Date.now()};image.setPointerCapture(e.pointerId);});
image.addEventListener('pointerup',e=>{if(!live||sending||!dragStart)return;const end=point(e);const dx=end.x-dragStart.x,dy=end.y-dragStart.y;const dist=Math.hypot(dx,dy);const d=dragStart;dragStart=null;if(dist>15){input({type:'swipe',x1:d.x,y1:d.y,x2:end.x,y2:end.y,durationMs:250});}else{input({type:'tap',x:end.x,y:end.y});}});
image.addEventListener('pointercancel',()=>{dragStart=null;});
image.onclick=e=>{e.preventDefault();};
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const text=field.value;if(text&&await input({type:'text',text})&&field.value===text)field.value='';};
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>input({type:'key',key:b.dataset.key}));
document.querySelector('#refresh').onclick=()=>{error.textContent='';refresh();};document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
controls();refresh();const timer=setInterval(refresh,2000);window.addEventListener('pagehide',()=>{clearInterval(timer);if(imageUrl)URL.revokeObjectURL(imageUrl);});
</script></html>`;
}

/** The console renders a live MJPEG screencast; remote page code never runs in this document. */
export function browserConsole(streamUrl: string) {
  const stream = JSON.stringify(streamUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenMuse browser</title><style>
*{box-sizing:border-box}body{margin:0;background:#fcfcfc;color:#172125;font:14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
button{font:inherit;border:1px solid #e9edef;border-radius:24px;padding:10px 14px;background:white;color:inherit;min-height:42px}
button{cursor:pointer}button:hover{background:#edf7fd}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:2px solid #1473c8;outline-offset:2px}
nav{display:flex;gap:6px;padding:12px 12px 12px;flex-wrap:wrap}nav button{font-size:12px;min-height:36px;padding:7px 12px}
#stage{overflow:hidden;background:#eef1f3;border-radius:18px;min-height:160px;margin:0 8px}img{display:block;width:100%;height:auto;cursor:crosshair;touch-action:none}img.stale{opacity:.45;pointer-events:none}
#error{margin:0 12px 12px;color:#984a41;background:#fbefed;padding:12px;border-radius:14px}#error:empty{display:none}
</style>
<nav aria-label="Browser keyboard"><button data-key="Enter">Enter ↵</button><button data-key="Tab">Tab ⇥</button><button data-key="Backspace">Delete ⌫</button><button id="up">Scroll ↑</button><button id="down">Scroll ↓</button></nav>
<div id="error" role="alert"></div><div id="stage"><img id="screen" class="stale" alt="Live browser session, click to interact" draggable="false"></div>
<script>
const image=document.querySelector('#screen'),error=document.querySelector('#error');
let live=false,sending=false,stopping=false,expired=false,failures=0,imageUrl=null;
function controls(){document.querySelectorAll('nav button').forEach(button=>button.disabled=sending||!live);image.classList.toggle('stale',!live||sending);}
function showFrame(bytes){
  const next=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));
  const probe=new Image();
  probe.onload=()=>{if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=next;image.src=next;if(!live){live=true;controls();}failures=0;};
  probe.onerror=()=>URL.revokeObjectURL(next);
  probe.src=next;
}
function findSeq(haystack,needle,from){outer:for(let i=from;i<=haystack.length-needle.length;i++){for(let j=0;j<needle.length;j++)if(haystack[i+j]!==needle[j])continue outer;return i;}return -1;}
async function readMultipart(reader){
  const boundary=new TextEncoder().encode('--openmuse-frame'),crlf=new TextEncoder().encode('\\r\\n\\r\\n');
  let buf=new Uint8Array(0);
  for(;;){
    const {done,value}=await reader.read();
    if(done)throw new Error('The browser stream ended unexpectedly.');
    const next=new Uint8Array(buf.length+value.length);next.set(buf);next.set(value,buf.length);buf=next;
    for(;;){
      const start=findSeq(buf,boundary,0);
      if(start<0){if(buf.length>boundary.length)buf=buf.slice(buf.length-boundary.length);break;}
      const headerEnd=findSeq(buf,crlf,start);
      if(headerEnd<0)break;
      const header=new TextDecoder().decode(buf.slice(start,headerEnd));
      const match=/content-length:\\s*(\\d+)/i.exec(header);
      if(!match)throw new Error('The browser stream sent a bad frame.');
      const length=parseInt(match[1],10),bodyStart=headerEnd+4;
      if(!Number.isFinite(length)||length<=0||length>8*1024*1024)throw new Error('The browser stream sent a bad frame.');
      if(buf.length<bodyStart+length)break;
      showFrame(buf.slice(bodyStart,bodyStart+length));
      buf=buf.slice(bodyStart+length);
    }
  }
}
async function watch(){
  while(!stopping&&!expired){
    try{
      const r=await fetch(${stream},{cache:'no-store'});
      if(!r.ok){
        if(r.status===401){expired=true;live=false;controls();error.textContent='Session access expired. Close this view and open the browser again.';return;}
        throw new Error(r.status===404?'Browser session not found. Reopen it from OpenMuse.':'Browser disconnected. Reopen the session from OpenMuse.');
      }
      if(!r.body)throw new Error('This browser cannot stream the session.');
      failures=0;error.textContent='';
      await readMultipart(r.body.getReader());
      throw new Error('The browser stream ended unexpectedly.');
    }catch(e){
      if(stopping||expired)return;
      live=false;controls();
      error.textContent=e instanceof Error?e.message:String(e);
      failures++;
      await new Promise(resolve=>setTimeout(resolve,Math.min(1000*failures,5000)));
    }
  }
}
async function input(body){if(sending||!live)return false;sending=true;controls();error.textContent='';let ok=false;try{
const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
if(!r.ok){const data=await r.json().catch(()=>null);throw new Error(data&&typeof data.error==='string'?data.error:'Browser action failed.');}ok=true;
}catch(e){if(!expired)error.textContent=e instanceof Error?e.message:String(e);}finally{sending=false;controls();}return ok;}
let held=false,lastMove=0,lastHover=0;
function point(e){const r=image.getBoundingClientRect();return{x:Math.min(1279,Math.max(0,Math.floor((e.clientX-r.left)*1280/r.width))),y:Math.min(799,Math.max(0,Math.floor((e.clientY-r.top)*800/r.height)))};}
image.onpointerdown=e=>{if(!live||sending||held||expired)return;e.preventDefault();held=true;try{image.setPointerCapture(e.pointerId);}catch(_){}const p=point(e);void input({type:'down',x:p.x,y:p.y});};
image.onpointermove=e=>{
  if(!live||sending||expired)return;
  const p=point(e);
  if(!held){
    // Hover: fire-and-forget on the fast path so the remote cursor follows live.
    if(e.buttons)return;
    const now=Date.now();if(now-lastHover<66)return;lastHover=now;
    fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'move',x:p.x,y:p.y}),signal:AbortSignal.timeout(10000)}).catch(()=>{});
    return;
  }
  const now=Date.now();if(now-lastMove<120)return;lastMove=now;
  void input({type:'move',held:true,x:p.x,y:p.y});
};
async function release(){if(!held)return;held=false;await input({type:'up'});}
window.addEventListener('pointerup',release);window.addEventListener('pointercancel',release);
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>input({type:'key',key:b.dataset.key}));
document.querySelector('#up').onclick=()=>input({type:'scroll',deltaY:-600});document.querySelector('#down').onclick=()=>input({type:'scroll',deltaY:600});
controls();watch();window.addEventListener('pagehide',()=>{stopping=true;if(imageUrl)URL.revokeObjectURL(imageUrl);});
</script></html>`;
}

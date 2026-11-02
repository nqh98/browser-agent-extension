const http = require('http');
const PAGE = `<!doctype html><html><head><title>Test Shop</title>
<style>body{font-family:sans-serif;margin:0;padding:8px} #pad{width:300px;height:120px;background:#ddd} #drag{width:200px;height:60px;background:#cde} .spacer{height:2200px}</style></head>
<body>
<h1>Test Shop Home</h1>
<p>Welcome to the test shop. Price of Widget is 42 dollars.</p>
<form id="search" onsubmit="event.preventDefault(); window.searched = this.q.value;">
  <input name="q" aria-label="Search query"> <button>Search</button>
</form>
<label>Full name <input id="name"></label>
<label>Password <input id="pw" type="password"></label>
<label>Country <select id="country"><option value="vn">Vietnam</option><option value="jp">Japan</option></select></label>
<label><input id="remember" type="checkbox"> Remember me</label>
<label>Keys <input id="keys"></label>
<div id="editor" contenteditable="true" aria-label="Notes editor">old</div>
<button id="del" onclick="window.deleted=true">Delete account</button>
<button id="hello" onclick="window.helloClicks=(window.helloClicks||0)+1">Say hello</button>
<a href="/page2">Go to page two</a>
<a href="/page3" target="_blank">Open page three in new tab</a>
<div id="pad">pad</div>
<div id="drag">drag zone</div>
<div id="host"></div>
<iframe srcdoc="<button>Frame button</button>" width="200" height="50"></iframe>
<div class="spacer"></div>
<button id="bottom" onclick="window.bottomClicked=true">Footer anchor</button>
<script>
window.log=[];
const pad=document.getElementById('pad');
for (const t of ['click','dblclick','contextmenu','auxclick','mousedown','mouseup','mouseover']) pad.addEventListener(t,e=>log.push(t+':'+e.button+':'+e.detail+(e.ctrlKey?':ctrl':'')+(e.shiftKey?':shift':'')));
pad.addEventListener('contextmenu',e=>e.preventDefault());
window.wheel=0; addEventListener('wheel',e=>{window.wheel+=e.deltaY},{passive:true});
const d=document.getElementById('drag'); window.drag={};
d.addEventListener('mousedown',e=>{drag.down=[e.clientX,e.clientY]});
addEventListener('mouseup',e=>{if(drag.down && !drag.up) drag.up=[e.clientX,e.clientY]});
window.keylog=[]; addEventListener('keydown',e=>keylog.push('down:'+e.key+':'+e.timeStamp.toFixed(0))); addEventListener('keyup',e=>keylog.push('up:'+e.key+':'+e.timeStamp.toFixed(0)));
const sr=document.getElementById('host').attachShadow({mode:'open'}); sr.innerHTML='<button onclick="window.shadowClicked=true">Shadow button</button>'; sr.querySelector('button').onclick=()=>{window.shadowClicked=true};
window.changes=[]; document.getElementById('name').addEventListener('change',()=>changes.push('name'));
</script></body></html>`;
function start(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/page2') return res.end('<!doctype html><title>Page Two</title><h1>Page Two</h1><a href="/">Home</a>');
      if (req.url === '/page3') return res.end('<!doctype html><title>Page Three</title><h1>Page Three</h1>');
      if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', `http://localhost:${port}/page2`); return res.end(); }
      if (req.url === '/slow') return setTimeout(() => res.end('<title>Slow</title>slow'), 40000);
      res.end(PAGE);
    });
    server.listen(port, () => resolve(server));
  });
}
module.exports = { start };

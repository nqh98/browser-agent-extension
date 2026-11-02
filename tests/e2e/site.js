const http = require('http');
const page = (PORT) => `<!doctype html><html><head><title>Test Shop</title>
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
<iframe id="same" title="Same frame" srcdoc="<button onclick='parent.frameClicked=(parent.frameClicked||0)+1'>Frame button</button> <input aria-label='Frame input' onchange='parent.frameInput=this.value'>" width="300" height="60"></iframe>
<iframe id="cross" title="Partner widget" src="http://localhost:${PORT}/framepage" width="420" height="160" style="border:7px solid #888;padding:5px"></iframe>
<label>Upload <input id="upload" type="file" aria-label="Upload document" multiple onchange="window.uploaded=[...this.files].map(f=>f.name+':'+f.size)"></label>
<a id="dl" href="/download">Download report</a>
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
      if (req.url === '/framepage') return res.end('<!doctype html><title>Partner</title><h2>Cross frame</h2><p>Partner secret text</p><button onclick="window.crossClicked=(window.crossClicked||0)+1">Cross button</button><br><iframe title="Nested" srcdoc="<button onclick=&quot;parent.nestedClicked=(parent.nestedClicked||0)+1&quot;>Nested button</button>" width="220" height="50"></iframe>');
      if (req.url.startsWith('/api')) { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}'); }
      if (req.url === '/download') { res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename="report.csv"'); return res.end('a,b\n1,2\n'); }
      if (req.url === '/slow') return setTimeout(() => res.end('<title>Slow</title>slow'), 40000);
      res.end(page(port));
    });
    server.listen(port, () => resolve(server));
  });
}
module.exports = { start };

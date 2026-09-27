// Diagnostic 2: séquence EXACTE du test (T2+T3 avec saut), et pour chaque tir T5:
// position joueur, look, sonde raycast _debug.fire(eye), dernier damage event.
import WebSocket from 'ws';
const list = await (await fetch('http://localhost:9224/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); r({ timeout: 1 }); } }, 20000); });
const ev = (x) => send('Runtime.evaluate', { expression: x, returnByValue: true }).then((r) => { const R = r?.result; if (R?.exceptionDetails) throw new Error('EVAL_ERR ' + (R.exceptionDetails.exception?.description || R.exceptionDetails.text)); return R?.value ?? R?.result?.value; });
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:4173/' });
let ready = false;
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 400)); try { ready = await ev('typeof window.GameLoom'); if (ready === 'object') break; } catch { } }
if (ready !== 'object') { console.log('BOOT KO'); process.exit(1); }
await ev('GameLoom.pause()');
await ev('GameLoom.step(90)');
// T2 du test
const tA = await ev('GameLoom.snapshot().tick');
await new Promise((r) => setTimeout(r, 700));
await ev('GameLoom.step(1)');
await ev('GameLoom.step(10)');
// T3 du test (mouvement + saut)
await ev('GameLoom._debug.input({ move: [1, 0] })');
await ev('GameLoom.step(30)');
await ev('GameLoom._debug.input({ move: [0, 0] })');
await ev('GameLoom._debug.input({ jump: true })');
await ev('GameLoom.step(10)');
await ev('GameLoom._debug.input({ jump: false })');
await ev('GameLoom.step(45)');
const p3 = await ev('GameLoom.snapshot().player');
console.log('après T3:', JSON.stringify(p3));
// T4 du test
const tars = await ev('GameLoom.entities({tag:"target"})');
console.log('cibles:', JSON.stringify(tars.map((t) => [t.id, t.pos])));
await ev(`GameLoom._debug.aimAt(${tars[0].pos[0]}, ${tars[0].pos[1] + 0.5}, ${tars[0].pos[2]})`);
await ev('GameLoom._debug.gameFire()');
await ev('GameLoom.step(6)');
// T5 du test
const bars = await ev('GameLoom.entities({tag:"barrel"})');
const b = bars[0];
console.log('baril T5:', JSON.stringify({ id: b.id, pos: b.pos }));
await ev(`GameLoom._debug.aimAt(${b.pos[0]}, ${b.pos[1] + 0.45}, ${b.pos[2]})`);
const look = await ev('GameLoom._debug.look()');
const eye = await ev('(() => { const p = GameLoom.snapshot().player.pos; return [p[0], p[1] + 1.55, p[2]]; })()');
console.log('look:', JSON.stringify(look), 'eye:', JSON.stringify(eye));
for (let i = 1; i <= 3; i++) {
  const probe = await ev('GameLoom._debug.fire(' + JSON.stringify(eye) + ')');
  await ev('GameLoom._debug.gameFire()');
  await ev('GameLoom.step(12)');
  const lastDmg = (await ev('GameLoom.events(60)')).filter((e) => e.event === 'damage').slice(-2);
  const bh = await ev(`GameLoom.inspect("${b.id}")`);
  console.log(`tir ${i}: sonde=${JSON.stringify(probe)} | health=${JSON.stringify(bh.health)} | derniers dmg=${JSON.stringify(lastDmg)}`);
}
ws.close();

// Diagnostic 3: géométrie T6 à 9.5m — à chaque tir: sonde raycast + position A + health A
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
// T3 (mouvement + saut) pour reproduire la position joueur du test
await ev('GameLoom._debug.input({ move: [1, 0] })');
await ev('GameLoom.step(30)');
await ev('GameLoom._debug.input({ move: [0, 0] })');
await ev('GameLoom._debug.input({ jump: true })');
await ev('GameLoom.step(10)');
await ev('GameLoom._debug.input({ jump: false })');
await ev('GameLoom.step(45)');
// T4 (tire une cible pour consommer le cooldown comme le test)
const tars = await ev('GameLoom.entities({tag:"target"})');
await ev(`GameLoom._debug.aimAt(${tars[0].pos[0]}, ${tars[0].pos[1] + 0.5}, ${tars[0].pos[2]})`);
await ev('GameLoom._debug.gameFire()');
await ev('GameLoom.step(6)');
// T5 (3 tirs sur un baril)
const bars = await ev('GameLoom.entities({tag:"barrel"})');
await ev(`GameLoom._debug.aimAt(${bars[0].pos[0]}, ${bars[0].pos[1] + 0.45}, ${bars[0].pos[2]})`);
for (let i = 0; i < 3; i++) { await ev('GameLoom._debug.gameFire()'); await ev('GameLoom.step(12)'); }
// T6 — géométrie du test
await ev('GameLoom._debug.clearTag("barrel")');
await ev('GameLoom._debug.clearTag("target")');
const p6 = await ev('GameLoom.snapshot().player.pos');
const clamp = (v) => Math.max(-10.5, Math.min(10.5, v));
const bx = clamp(p6[0] + 5.7), bz = clamp(p6[2] - 7.6);
const A = await ev(`GameLoom._debug.spawn("assets/barrel.glb", ${bx}, 0, ${bz})`);
const C = await ev(`GameLoom._debug.spawn("assets/barrel.glb", ${(bx + 1.5).toFixed(2)}, 0, ${(bz - 2).toFixed(2)})`);
await ev('GameLoom.step(3)');
const aIns = await ev(`GameLoom.inspect("${A}")`);
const cIns = await ev(`GameLoom.inspect("${C}")`);
const eye = await ev('(() => { const p = GameLoom.snapshot().player.pos; return [p[0], p[1] + 1.55, p[2]]; })()');
console.log('player:', JSON.stringify(p6), 'eye:', JSON.stringify(eye));
console.log('A spawn:', bx, bz, '→ pos réelle:', JSON.stringify(aIns.position), 'C pos:', JSON.stringify(cIns.position));
await ev(`GameLoom._debug.aimAt(${aIns.position[0]}, ${aIns.position[1] + 0.45}, ${aIns.position[2]})`);
const look = await ev('GameLoom._debug.look()');
console.log('look:', JSON.stringify(look));
for (let i = 1; i <= 4; i++) {
  const probe = await ev('GameLoom._debug.fire(' + JSON.stringify(eye) + ')');
  await ev('GameLoom._debug.gameFire()');
  await ev('GameLoom.step(12)');
  const bh = await ev(`GameLoom.inspect("${A}")`);
  console.log(`tir ${i}: sonde=${JSON.stringify(probe)} | A.health=${JSON.stringify(bh.health)} | A.exists=${bh.error === undefined}`);
}
ws.close();

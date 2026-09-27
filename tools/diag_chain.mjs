// Diagnostic: rejoue la séquence exacte du test (T3→T4→T5→T6) sur le build prod
// et dump TOUS les events des barils de chaîne (A et C) + console + doctor.
import WebSocket from 'ws';

const list = await (await fetch('http://localhost:9224/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = []; const errs = []; const warns = [];
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); r({ timeout: 1 }); } }, 20000); });
const ev = (x) => send('Runtime.evaluate', { expression: x, returnByValue: true }).then((r) => { const R = r?.result; if (R?.exceptionDetails) throw new Error('EVAL_ERR ' + (R.exceptionDetails.exception?.description || R.exceptionDetails.text)); return R?.value ?? R?.result?.value; });
ws.on('message', (raw) => { const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') { const t = m.params.args.map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' '); if (m.params.type === 'warn') warns.push(t); if (m.params.type === 'error') errs.push(t); }
  else if (m.method === 'Runtime.exceptionThrown') { errs.push(m.params.exceptionDetails.exception?.description ?? 'exc'); } });
await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:4173/' });
let ready = false;
for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 400)); try { ready = await ev('typeof window.GameLoom'); if (ready === 'object') break; } catch { } }
if (ready !== 'object') { console.log('BOOT KO', errs.slice(-3)); process.exit(1); }

await ev('GameLoom.pause()');
await ev('GameLoom.step(90)');
// T3: le joueur avance (comme le test)
await ev('GameLoom._debug.input({ move: [1, 0] })');
await ev('GameLoom.step(30)');
await ev('GameLoom._debug.input({ move: [0, 0] })');
// T4: tir sur une cible
const tars = await ev('GameLoom.entities({tag:"target"})');
await ev(`GameLoom._debug.aimAt(${tars[0].pos[0]}, ${tars[0].pos[1] + 0.5}, ${tars[0].pos[2]})`);
await ev('GameLoom._debug.gameFire()');
await ev('GameLoom.step(6)');
// T5: tir sur un baril
const bars = await ev('GameLoom.entities({tag:"barrel"})');
await ev(`GameLoom._debug.aimAt(${bars[0].pos[0]}, ${bars[0].pos[1] + 0.45}, ${bars[0].pos[2]})`);
for (let i = 0; i < 3; i++) { await ev('GameLoom._debug.gameFire()'); await ev('GameLoom.step(12)'); }
// T6: chaîne
await ev('GameLoom._debug.clearTag("barrel")');
await ev('GameLoom._debug.clearTag("target")');
const p6 = await ev('GameLoom.snapshot().player.pos');
const bx = +(p6[0] + 3).toFixed(2), bz = +(p6[2] - 4).toFixed(2);
const A = await ev(`GameLoom._debug.spawn("assets/barrel.glb", ${bx}, 0, ${bz})`);
const C = await ev(`GameLoom._debug.spawn("assets/barrel.glb", ${(bx + 1.5).toFixed(2)}, 0, ${(bz - 2).toFixed(2)})`);
await ev('GameLoom.step(3)');
const aIns = await ev(`GameLoom.inspect("${A}")`);
await ev(`GameLoom._debug.aimAt(${aIns.position[0]}, ${aIns.position[1] + 0.45}, ${aIns.position[2]})`);
for (let i = 0; i < 4; i++) { await ev('GameLoom._debug.gameFire()'); await ev('GameLoom.step(12)'); }
await ev('GameLoom.step(12)');

const allEv = await ev('GameLoom.events(500)');
console.log('=== TOUS LES EVENTS DE A (' + A + ') ===');
allEv.filter((e) => e.entity === A).forEach((e) => console.log(`  tick=${e.tick} ${e.event} other=${e.other} amount=${e.amount}`));
console.log('=== TOUS LES EVENTS DE C (' + C + ') ===');
allEv.filter((e) => e.entity === C).forEach((e) => console.log(`  tick=${e.tick} ${e.event} other=${e.other} amount=${e.amount}`));
console.log('=== EVENTS health.zero/destroy globaux ===');
allEv.filter((e) => e.event === 'health.zero' || e.event === 'destroy').forEach((e) => console.log(`  tick=${e.tick} ${e.event} ${e.entity}`));
console.log('=== FINAL A ===', JSON.stringify(await ev(`GameLoom.inspect("${A}")`)));
console.log('=== FINAL C ===', JSON.stringify(await ev(`GameLoom.inspect("${C}")`)));
console.log('=== DOCTOR ===', JSON.stringify(await ev('GameLoom.doctor()')));
console.log('=== ENTITES RESTANTES ===', JSON.stringify(await ev('GameLoom.entities()')));
console.log('=== WARNINGS ===', JSON.stringify(warns));
console.log('=== ERRORS ===', JSON.stringify(errs));
ws.close();

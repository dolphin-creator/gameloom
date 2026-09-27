// GameLoom v0.1 — lecture des GLB + métadonnées GameLoom (namespace com.gameloom.v0)
// Le GLB stocke son JSON glTF dans le chunk 0 ; on le lit directement pour
// récupérer l'extension com.gameloom.v0 (GLTFLoader l'ignore).

import type { GlbMeta } from './types';

export const NS = 'com.gameloom.v0';

export function readGlbJson(buffer: ArrayBuffer): any | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return null;
  const dv = new DataView(buffer);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) return null; // "glTF"
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) { // JSON
      try {
        return JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + len)));
      } catch {
        return null;
      }
    }
    offset += 8 + len;
    if (len <= 0) break; // garde anti-boucle
  }
  return null;
}

/** Métadonnées GameLoom d'un GLB (extension de scène). */
export function readGlbMeta(buffer: ArrayBuffer): GlbMeta | null {
  const json = readGlbJson(buffer);
  if (!json) return null;
  const scene = json.scenes?.[0];
  const ext = scene?.extensions?.[NS];
  if (!ext) return null;
  return ext as GlbMeta;
}

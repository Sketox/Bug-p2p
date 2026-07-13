// Construye la lista de servidores ICE (STUN + TURN) para la malla WebRTC.
//
// STUN descubre tu IP pública (gratis, resuelve ~70-80% de los casos). TURN es el relay de
// respaldo para redes restrictivas (NAT simétrico, corporativas, datos móviles) — imprescindible
// para que funcione entre casas/redes distintas. Se configura por variables de entorno:
//
//   NEXT_PUBLIC_TURN_URL         p.ej. "turn:tu-servidor:3478" (o "turns:...:5349" con TLS)
//   NEXT_PUBLIC_TURN_USERNAME
//   NEXT_PUBLIC_TURN_CREDENTIAL
//
// O bien un endpoint que devuelve la lista lista (formato de Metered/Cloudflare):
//   NEXT_PUBLIC_ICE_URL          devuelve JSON: RTCIceServer[]  (o { iceServers: [...] })

const STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function turnFromEnv(): RTCIceServer[] {
  const url = process.env.NEXT_PUBLIC_TURN_URL;
  const username = process.env.NEXT_PUBLIC_TURN_USERNAME;
  const credential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
  if (!url) return [];
  return [{ urls: url, ...(username ? { username } : {}), ...(credential ? { credential } : {}) }];
}

/** Carga los servidores ICE. Si hay endpoint remoto lo consulta; si falla, cae a STUN + TURN de env. */
export async function loadIceServers(): Promise<RTCIceServer[]> {
  const iceUrl = process.env.NEXT_PUBLIC_ICE_URL;
  if (iceUrl) {
    try {
      const res = await fetch(iceUrl);
      const data = await res.json();
      const list: RTCIceServer[] = Array.isArray(data) ? data : data.iceServers;
      if (Array.isArray(list) && list.length > 0) return [...STUN, ...list];
    } catch {
      /* si el endpoint falla, seguimos con STUN + TURN de env */
    }
  }
  return [...STUN, ...turnFromEnv()];
}

// Apoyo común de las pruebas de extremo a extremo.

import './comandos';

// La app no debe tirar excepciones no capturadas. Pero WebRTC sí produce algunas al cerrar
// contextos a media negociación (canales que se cierran mientras hay una oferta en vuelo), y eso
// es ruido de desmontaje, no un fallo del producto. Se ignoran SOLO esas, por su texto: una
// excepción de verdad tiene que seguir tumbando la prueba.
const RUIDO_DE_CIERRE = [
  'InvalidStateError',
  'The RTCPeerConnection',
  'peerconnection is closed',
  'ResizeObserver loop',
];

Cypress.on('uncaught:exception', (err) => {
  if (RUIDO_DE_CIERRE.some((t) => err.message.includes(t))) return false;
  return true;
});

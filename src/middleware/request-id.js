import { randomUUID } from 'node:crypto';

/**
 * Le asigna un id a cada petición para poder cruzar el error que ve el usuario
 * con la línea del log. Si el front ya manda X-Request-Id, se respeta.
 */
export function requestId(req, res, next) {
  const recibido = req.get('x-request-id');
  req.id = typeof recibido === 'string' && recibido.trim() !== ''
    ? recibido.trim().slice(0, 64)
    : randomUUID();

  res.setHeader('X-Request-Id', req.id);
  next();
}

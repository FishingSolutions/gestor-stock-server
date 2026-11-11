// Envuelve controladores async: si lanzan, el error llega al manejador central
// en vez de quedar como "unhandled rejection" y colgar la petición.
export function asyncHandler(controlador) {
  return function manejado(req, res, next) {
    Promise.resolve(controlador(req, res, next)).catch(next);
  };
}

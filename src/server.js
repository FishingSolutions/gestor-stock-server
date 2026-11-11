import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { manejadorDeErrores, rutaNoEncontrada } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import rutasImportacion from './modules/productos/importacion/rutas.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(requestId);

// Endpoint de prueba técnica
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Servidor operativo' });
});

// Importar productos desde Excel (ver docs/importar-productos/README.md)
app.use('/api/productos/importar', rutasImportacion);

// 404 y manejo central de errores (siempre al final)
app.use(rutaNoEncontrada);
app.use(manejadorDeErrores);

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

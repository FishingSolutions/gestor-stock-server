import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { pool } from './db.js'
import { errorHandler } from './errors.js'
import categoriasRouter from './routes/categorias.js'
import productosRouter from './routes/productos.js'
import movimientosRouter from './routes/movimientos.js'

const app = express()
const PORT = process.env.PORT || 4000

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: (origin, callback) => {
      // Sin origin = curl, Postman o health checks.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true)
      }

      return callback(null, false)
    },
  }),
)
app.use(express.json({ limit: '1mb' }))

// Endpoint de prueba técnica
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Servidor operativo' })
})

// Verifica la conexión real con PostgreSQL.
app.get('/api/health/db', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now')
    res.status(200).json({ status: 'ok', database: 'up', now: rows[0].now })
  } catch (error) {
    console.error('Health check de PostgreSQL falló:', error.message)
    res.status(503).json({ status: 'error', database: 'down' })
  }
})

app.use('/api/categorias', categoriasRouter)
app.use('/api/productos', productosRouter)
app.use('/api/movimientos', movimientosRouter)

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' })
})

app.use(errorHandler)

const server = app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`)
})

// Aviso temprano si la base no responde; el server queda operativo igual.
pool
  .query('SELECT 1')
  .then(() => console.log('PostgreSQL conectado'))
  .catch((error) => {
    console.error('No se pudo conectar a PostgreSQL:', error.message)
  })

async function shutdown(signal) {
  console.log(`${signal} recibido, cerrando servidor...`)

  server.close(async () => {
    await pool.end()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

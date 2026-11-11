# Gestor de Stock - Backend API

Servidor REST API desarrollado en Node.js y Express para el control de inventario.

## Tecnologías
- Node.js
- Express
- PostgreSQL

IMPORTANTE!  NO HACER COMMITS DIRECTOS AL MAIN 

## Base de datos (Supabase)

La base de datos vive en Supabase y se maneja con migraciones en la carpeta `supabase/`.
Cómo instalar la CLI, el esquema, los roles y permisos, cómo probar cambios en local y los problemas conocidos están en **[supabase/README.md](supabase/README.md)**.

## Importar productos desde Excel

Un **ADMINISTRADOR** carga una planilla `.xlsx` o `.xls`: se lee la hoja principal, se valida cada fila,
las válidas se insertan en una sola transacción y se devuelve un resumen con el detalle de los errores.

Corre en **Supabase**, sin servidor aparte: es la Edge Function `importar-productos` más la función
SQL `importar_productos`.
- Uso desde el front, formato del Excel y errores: **[supabase/README.md](supabase/README.md)**, sección "9. Importar productos desde Excel".
- Diseño completo (modelo de datos, casos de uso, diagramas, interfaz, paso a paso): **[docs/importar-productos/README.md](docs/importar-productos/README.md)**.
- Pantalla de ejemplo para el front: `docs/importar-productos/ImportarProductos.jsx`.
- Planillas de ejemplo: `docs/importar-productos/ejemplos/` (se regeneran con `npm run generar-ejemplos`).
- Pruebas: `bash supabase/pruebas/prueba_importacion.sh` (base local).

## Instalación local

1. Clonar el repositorio:
   ```bash
   git clone [https://github.com/FishingSolutions/gestor-stock-server.git](https://github.com/FishingSolutions/gestor-stock-server.git)
   cd gestor-stock-server

instalar dependencias 
bash 
npm install


Configurar variables de entorno:
Copiar el archivo base de variables de entorno:
cp .env.example .env
Completar los valores dentro de .env (puerto, credenciales de PostgreSQL, etc.).

iniciar el sv modo desarrollo
npm run dev

modo produccion 
npm start

Crear una rama para cada tarea asignada:
git checkout -b feature/nombre-de-la-tarea

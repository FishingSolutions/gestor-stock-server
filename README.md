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

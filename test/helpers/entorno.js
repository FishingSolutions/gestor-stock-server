// Se importa PRIMERO en cada archivo de prueba: la configuración se lee al
// cargar los módulos, así que estas variables tienen que estar antes.
process.env.NODE_ENV = 'test';
process.env.LOG_ARCHIVO = 'false';
process.env.LOG_NIVEL = 'silent';
process.env.IMPORT_PERMITIR_SIN_AUTH = 'false';

export {};

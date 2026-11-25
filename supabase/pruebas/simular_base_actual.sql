-- Deja la base local como está hoy la de Supabase (antes de la migración):
-- categorías y productos cargados, Admin Prueba sin cuenta de login, 0 movimientos.
insert into public.categoria (nombre) values ('Bebidas'), ('Almacén');

insert into public.producto (codigo, nombre, precio_venta, stock_actual, stock_minimo, stock_maximo, id_categoria)
select 'COCA500', 'Coca-Cola 500ml', 1200, 10, 5, 50, id_categoria from public.categoria where nombre = 'Bebidas';

insert into public.producto (codigo, nombre, precio_venta, stock_actual, stock_minimo, stock_maximo, id_categoria)
select 'YERBA1K', 'Yerba 1kg', 4500, 3, 5, 30, id_categoria from public.categoria where nombre = 'Almacén';

insert into public.usuario (nombre, apellido, email, rol)
values ('Admin', 'Prueba', 'admin@stockfx.com', 'ADMINISTRADOR');

select 'auth.users' as tabla, count(*) from auth.users
union all select 'usuario', count(*) from public.usuario
union all select 'producto', count(*) from public.producto;

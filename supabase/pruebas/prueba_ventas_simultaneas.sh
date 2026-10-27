#!/usr/bin/env bash
# Dos ventas al mismo tiempo sobre el mismo producto (KAN-37).
# Se corre DESPUÉS de pruebas_registrar_movimiento.sql (usa sus usuarios y productos).
#
# Stock inicial: 5. Venta A: 4 unidades. Venta B: 4 unidades, un segundo después.
# Esperado: A se registra (5 -> 1); B espera a que A termine y se rechaza
# con "hay 1, se pidieron 4". El stock nunca queda negativo.
set -u
DB="docker exec -i supabase_db_gestor-stock-server psql -U postgres -d postgres -q"
EMP='{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}'
ID=$($DB -tAc "select id_producto from public.producto where codigo = 'COCA500'")

$DB -c "update public.producto set stock_actual = 5 where id_producto = $ID"

venta() {  # $1 = nombre, $2 = segundos que la transacción queda abierta
  $DB <<SQL 2>&1 | sed "s/^/[$1] /"
begin;
set local role authenticated;
set local request.jwt.claims to '$EMP';
select 'registrada: ' || stock_anterior || ' -> ' || stock_resultante
  from public.registrar_movimiento($ID, 'SALIDA', 4, 'Venta $1');
select pg_sleep($2);
commit;
SQL
}

venta A 3 &
sleep 1
venta B 0 &
wait

echo "Stock final: $($DB -tAc "select stock_actual from public.producto where id_producto = $ID") (esperado: 1)"

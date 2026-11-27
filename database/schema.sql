CREATE TABLE public.usuario (
    id_usuario UUID PRIMARY KEY
        REFERENCES auth.users(id)
        ON DELETE CASCADE,
    nombre VARCHAR(100) NOT NULL,
    apellido VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    rol VARCHAR(20) NOT NULL,

    CONSTRAINT usuario_rol_check
        CHECK (rol IN ('ADMINISTRADOR', 'EMPLEADO'))
);


CREATE TABLE public.categoria (
    id_categoria UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL UNIQUE,
    descripcion TEXT
);


CREATE TABLE public.producto (
    id_producto UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL,
    precio NUMERIC(12,2) NOT NULL,
    descripcion TEXT,
    stock_actual INT NOT NULL,
    stock_minimo INT NOT NULL,
    stock_maximo INT NOT NULL,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    tiene_caducidad BOOLEAN NOT NULL DEFAULT FALSE,
    id_categoria UUID NOT NULL,

    CONSTRAINT producto_precio_check
        CHECK (precio >= 0),

    CONSTRAINT producto_stock_actual_check
        CHECK (stock_actual >= 0),

    CONSTRAINT producto_stock_minimo_check
        CHECK (stock_minimo >= 0),

    CONSTRAINT producto_stock_maximo_check
        CHECK (stock_maximo >= 0),

    CONSTRAINT producto_stock_rango_check
        CHECK (stock_minimo <= stock_maximo),

    CONSTRAINT producto_categoria_fk
        FOREIGN KEY (id_categoria)
        REFERENCES public.categoria(id_categoria)
);


CREATE TABLE public.movimiento_stock (
    id_movimiento UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tipo VARCHAR(20) NOT NULL,
    cantidad INT NOT NULL,
    motivo TEXT NOT NULL,
    id_producto UUID NOT NULL,
    id_usuario UUID NOT NULL,

    CONSTRAINT movimiento_tipo_check
        CHECK (tipo IN ('ENTRADA', 'SALIDA', 'AJUSTE')),

    CONSTRAINT movimiento_cantidad_check
        CHECK (cantidad > 0),

    CONSTRAINT movimiento_producto_fk
        FOREIGN KEY (id_producto)
        REFERENCES public.producto(id_producto),

    CONSTRAINT movimiento_usuario_fk
        FOREIGN KEY (id_usuario)
        REFERENCES public.usuario(id_usuario)
);
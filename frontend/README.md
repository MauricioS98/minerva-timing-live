# Minerva Timing — Frontend

UI React + Vite + TypeScript del panel de eventos, tablero público y overlay.

La documentación del producto (arranque, flujo, feeds, tablero) está en el [README raíz](../README.md).

## Desarrollo

Desde la raíz del repo:

```bash
npm run dev:frontend
```

O con API en paralelo:

```bash
npm run dev
```

- App: http://localhost:5173  
- Proxy/API esperada: http://localhost:4000  

## Entornos

| Archivo | Cuándo |
|---------|--------|
| `.env.development` | `npm run dev` y `npm run build:local` |
| `.env.production` | `npm run build` / `npm run build:production` |

Variables: `VITE_API_BASE_URL`, `VITE_UPLOADS_BASE_URL`, `VITE_BACKEND_ORIGIN`.

## Build

```bash
npm run build:local --prefix frontend       # local
npm run build:production --prefix frontend  # nube
npm run preview --prefix frontend
```

## Rutas principales

| Ruta | Descripción |
|------|-------------|
| `/` | Lista de eventos |
| `/eventos/:id` | Panel de gestión (protegido por contraseña) |
| `/tablero/:id` | Resultados públicos (paginación 10 + rotación) |
| `/overlay/:id` | Overlay para transmisión |

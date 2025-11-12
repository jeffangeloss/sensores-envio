# Sensores Envío — Guía rápida

Este repositorio contiene el firmware del ESP32, el panel web PaginaSemaforos y el servidor proxy que vincula ambos componentes.

## Preparación inicial

1. Clona el repositorio y entra en la carpeta raíz:
   ```bash
   git clone https://github.com/jeffangeloss/sensores-envio.git
   cd sensores-envio
   ```
2. Instala las dependencias del dashboard (solo la primera vez):
   ```bash
   npm --prefix PaginaSemaforos install
   ```
3. Opcional: instala los atajos npm de la raíz si prefieres usarlos:
   ```bash
   npm install
   ```

## Cómo actualizar tu copia local

Si ya tienes el proyecto en `C:\Users\<usuario>\OneDrive\Escritorio\sensores-envio`, puedes sincronizarlo con los últimos cambios con estos pasos:

1. Asegúrate de no tener cambios locales pendientes o hazles commit.
2. Desde la raíz del proyecto, trae la última versión del repositorio remoto:
   ```bash
   git pull
   ```
3. Vuelve a instalar dependencias si hubo cambios en los manifiestos:
   ```bash
   npm install                       # scripts de atajo en la raíz (opcional)
   npm --prefix PaginaSemaforos install
   ```
4. Reconstruye la aplicación web para actualizar `PaginaSemaforos/dist`:
   ```bash
   npm run build
   ```

## Comandos de uso frecuente

* Levantar el entorno de desarrollo del dashboard (Vite):
  ```bash
  npm run dev
  ```
* Levantar Vite expuesto en la red local:
  ```bash
  npm run dev:host
  ```
* Servir la build y levantar el proxy HTTP hacia el ESP32:
  ```bash
  npm run proxy -- --esp32 http://10.122.132.XXX
  ```
  Ajusta los últimos octetos según la IP asignada por tu hotspot.

## Más información

* El firmware del ESP32 está en `Inicio_Semaforos/Inicio_Semaforos.ino`.
* El dashboard React (Vite + Tailwind) vive en `PaginaSemaforos/`.
* El servidor proxy y de archivos estáticos es `Servidor.py`.

Con estos pasos puedes mantener tu entorno local alineado con los cambios realizados en el repositorio y relanzar los servicios necesarios.

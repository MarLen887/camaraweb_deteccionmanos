# AirCanvas · Dibujo con gestos de la mano

Aplicación web que muestra la **cámara web en tiempo real** y permite **dibujar en pantalla mediante señas de la mano**. Cuenta con una paleta de **10 colores** y **4 tamaños de pincel**, y puede operarse tanto con el mouse como con los propios gestos.

La detección de manos se ejecuta **localmente en el navegador** con [MediaPipe Hand Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js). El video no se envía ni se almacena en ningún servidor.

---

## Características

- Vista de la cámara en tiempo real (efecto espejo, más natural para dibujar).
- Detección de una mano y de sus 21 puntos de referencia (*landmarks*).
- Reconocimiento de cuatro gestos: dibujar, mover/seleccionar, borrar y pausa.
- Paleta de 10 colores y 4 grosores de pincel (fino, medio, grueso y extra grueso).
- Selección de colores y herramientas **con gestos**: basta mantener el cursor sobre el botón durante 0.8 s.
- Herramientas: borrador, deshacer, limpiar lienzo (con restauración) y guardar como imagen PNG.
- Suavizado del trazo con el filtro 1€ (ajustable), para reducir el temblor sin añadir retardo notable.
- Fondo configurable: cámara, pizarra clara o pizarra oscura.
- Modo de pantalla completa, atajos de teclado y diseño adaptable (escritorio, tableta y móvil).

## Gestos

| Gesto | Seña | Acción |
|:---:|---|---|
| ☝️ | Solo el dedo **índice** extendido | **Dibujar** con la punta del índice |
| ✌️ | **Índice y medio** extendidos | **Mover el cursor** sin dibujar; mantenerlo 0.8 s sobre un botón lo activa |
| 🖐️ | **Palma abierta** (cuatro dedos extendidos) | **Borrar** donde pase la palma |
| ✊ | **Puño** cerrado | **Pausa** (no se dibuja ni se borra) |

> El pulgar se ignora deliberadamente: su detección es poco fiable y no es necesario para distinguir los cuatro gestos.

## Atajos de teclado

| Tecla | Acción |
|:---:|---|
| `1` – `4` | Tamaño del pincel |
| `E` | Activar / desactivar el borrador |
| `Z` o `Ctrl` + `Z` | Deshacer |
| `Supr` | Limpiar el lienzo |
| `S` | Guardar imagen PNG |
| `F` | Pantalla completa |

## Requisitos

- Navegador moderno con soporte de WebAssembly y `getUserMedia` (Chrome, Edge, Firefox o Safari actualizados).
- Cámara web y permiso para utilizarla.
- Conexión a Internet **en la primera carga**: el módulo de MediaPipe se descarga desde jsDelivr y el modelo (`hand_landmarker.task`) desde Google Cloud Storage.
- La página debe servirse desde un **contexto seguro**: `https://` o `http://localhost`. Si se abre el archivo `index.html` directamente (`file://`), el navegador bloqueará la cámara y los módulos.

## Ejecución local

Desde la carpeta del proyecto, inicie cualquier servidor estático y abra `http://localhost:8080`:

```bash
# Opción 1: Python (macOS / Linux: python3 · Windows: python)
python3 -m http.server 8080

# Opción 2: Node.js
npx serve .
```

También puede utilizarse la extensión **Live Server** de Visual Studio Code.

> En algunos equipos con Windows, Python puede servir los archivos `.js` con un tipo MIME incorrecto, lo que impide cargar los módulos. En ese caso, utilice la Opción 2 o Live Server.

## Publicación en GitHub Pages

Sitio publicado en: **https://marlen887.github.io/camaraweb_deteccionmanos/**

Al tratarse de un sitio estático, no requiere compilación. Para activarlo (una sola vez):

1. En el repositorio, abra **Settings → Pages**.
2. En *Build and deployment → Source*, seleccione **Deploy from a branch**.
3. En *Branch*, elija **`main`** y la carpeta **`/ (root)`**; pulse **Save**.
4. Espere de 1 a 3 minutos a que termine el despliegue (se puede seguir en la pestaña **Actions**).

GitHub Pages sirve el sitio por `https://`, requisito del navegador para acceder a la cámara. Todas las rutas del proyecto son relativas, por lo que funciona en la subruta `/camaraweb_deteccionmanos/`. El archivo `.nojekyll` evita que Pages procese el sitio con Jekyll.

## Estructura del proyecto

```
camaraweb_deteccionmanos/
├── index.html              Estructura de la interfaz
├── css/
│   └── styles.css          Estilos (tema oscuro, diseño adaptable)
├── js/
│   ├── app.js              Cámara, modelo, dibujo, interfaz y selección por gestos
│   └── gestures.js         Lógica pura: clasificación de gestos y filtro 1€ (sin DOM)
├── assets/
│   └── favicon.svg
├── tests/
│   └── gestures.test.mjs   Pruebas unitarias de la lógica de gestos
├── package.json
└── README.md
```

## Funcionamiento técnico

1. **Captura.** `getUserMedia` entrega el video (idealmente 1280 × 720 a 30 FPS). El escenario se dimensiona con la misma relación de aspecto del video para que las coordenadas normalizadas de MediaPipe coincidan exactamente con lo que se observa.
2. **Detección.** En cada fotograma nuevo, `HandLandmarker.detectForVideo()` devuelve 21 puntos por mano. Se intenta usar el delegado GPU y, si no está disponible, se recurre a CPU.
3. **Clasificación.** Un dedo se considera extendido si la razón *distancia muñeca→punta / distancia muñeca→articulación PIP* supera 1.2. Al basarse en distancias, el resultado no depende de la orientación de la mano.
4. **Estabilización.** Un gesto nuevo debe mantenerse 3 fotogramas consecutivos para ser aceptado, y durante las transiciones el trazo se congela, evitando garabatos al cambiar de seña.
5. **Rechazo de saltos.** Si la posición del dedo se desplaza de forma implausible en un fotograma (más del 8 % del lado mayor del lienzo) se conserva la última posición válida, y solo se acepta el nuevo sitio si persiste 4 fotogramas seguidos. Así se descartan los errores puntuales de seguimiento.
6. **Suavizado.** La posición del dedo (o del centro de la palma al borrar) pasa por un filtro 1€, que suaviza intensamente a baja velocidad y poco a alta velocidad.
7. **Dibujo.** Los trazos se almacenan con coordenadas normalizadas, por lo que son independientes de la resolución; esto permite deshacer, restaurar y redibujar sin pérdida de calidad.

## Pruebas

```bash
npm test
```

Ejecuta 17 pruebas unitarias (Node.js ≥ 18, sin dependencias) sobre la clasificación de gestos —incluida su invariancia a la rotación de la mano— el comportamiento del filtro de suavizado y el rechazo de saltos bruscos.

## Consejos de uso y limitaciones

- Utilice **buena iluminación frontal** y un fondo sin otras manos en cuadro; la aplicación rastrea **una sola mano**.
- Mantenga la mano a unos 40–80 cm de la cámara, con la palma orientada hacia ella.
- **No acerque el dedo a la cámara.** El modelo localiza primero la palma completa; si solo se ve un dedo o la palma queda recortada por el borde del cuadro, no hay detección. Si pasan 2 s sin detectar la mano, la aplicación sugiere alejarla.
- Los dedos que apuntan directamente hacia la cámara pueden confundirse con dedos flexionados (efecto de escorzo).
- Si el trazo se siente con retardo, reduzca el control **Suavizado del trazo**; si tiembla, auméntelo.

## Referencias

### Formato APA (7.ª edición)

- Casiez, G., Roussel, N., & Vogel, D. (2012). 1 € filter: A simple speed-based low-pass filter for noisy input in interactive systems. En *Proceedings of the SIGCHI Conference on Human Factors in Computing Systems* (pp. 2527–2530). ACM. https://doi.org/10.1145/2207676.2208639
- Google. (s. f.). *Hand landmarks detection guide for Web*. Google AI Edge. Recuperado el 14 de noviembre de 2026, de https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- Zhang, F., Bazarevsky, V., Vakunov, A., Tkachenka, A., Sung, G., Chang, C.-L., & Grundmann, M. (2020). *MediaPipe Hands: On-device real-time hand tracking*. arXiv. https://arxiv.org/abs/2006.10214

### Formato IEEE

- [1] G. Casiez, N. Roussel, and D. Vogel, "1 € filter: A simple speed-based low-pass filter for noisy input in interactive systems," in *Proc. SIGCHI Conf. Human Factors Comput. Syst. (CHI '12)*, Austin, TX, USA, 2012, pp. 2527–2530, doi: 10.1145/2207676.2208639.
- [2] Google, "Hand landmarks detection guide for Web," Google AI Edge. [Online]. Available: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js (accessed Nov. 14, 2026).
- [3] F. Zhang *et al.*, "MediaPipe Hands: On-device real-time hand tracking," 2020, *arXiv:2006.10214*.

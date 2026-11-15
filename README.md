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
- **Modo Señas (LSM):** reconoce las letras estáticas del alfabeto dactilológico de la Lengua de Señas Mexicana mediante entrenamiento en el navegador y va formando las palabras (ver la sección siguiente).

## Gestos

| Gesto | Seña | Acción |
|:---:|---|---|
| ☝️ | Solo el dedo **índice** extendido | **Dibujar** con la punta del índice |
| ✌️ | **Índice y medio** extendidos | **Mover el cursor** sin dibujar; mantenerlo 0.8 s sobre un botón lo activa |
| 🖐️ | **Palma abierta** (cuatro dedos extendidos) | **Borrar** donde pase la palma |
| ✊ | **Puño** cerrado | **Pausa** (no se dibuja ni se borra) |

> El pulgar se ignora deliberadamente: su detección es poco fiable y no es necesario para distinguir los cuatro gestos.

## Modo Señas (Lengua de Señas Mexicana)

Con las pestañas **✏️ Dibujo / 🤟 Señas (LSM)** de la parte superior se cambia de modo sin apagar la cámara. En el modo Señas, la aplicación reconoce las letras que usted le enseñe y las va uniendo en una palabra.

### Cómo se usa

1. Abra la pestaña **Señas (LSM)** e inicie la cámara.
2. En el panel **Entrenamiento**, seleccione una seña (A, B, C…) y pulse **Grabar ejemplos**. Tras una cuenta regresiva de 3 s se capturan 40 ejemplos; mueva ligeramente la mano y cambie un poco el ángulo.
3. Repita 2 o 3 veces por seña (se recomiendan ≥ 30 ejemplos; el contador del botón se pone verde al alcanzarlos).
4. Entrene también **␣ Espacio** y **⌫ Borrar** con dos señas que no se parezcan a ninguna letra.
5. Pulse **Estimar precisión** para ver qué señas se confunden entre sí y grabe más tomas de ellas.
6. Haga las señas frente a la cámara: un **anillo de progreso** se llena durante 1 s y, al completarse, la letra se añade a la palabra. Para repetir una letra (p. ej., «OO»), retire la mano un instante o cambie de seña.

El entrenamiento se guarda en el navegador (`localStorage`) y puede exportarse o cargarse como archivo JSON. Nada se envía a ningún servidor. La palabra puede copiarse o leerse en voz alta (síntesis de voz del navegador, `es-MX`).

### Alcance y limitaciones

- **Solo letras estáticas.** De las 27 letras del alfabeto de la LSM, 21 son estáticas y 6 son dinámicas, es decir, requieren movimiento (López-Nava, s. f.; coinciden en la cifra Mejía-Pérez et al., 2021, y Sánchez-Vicinaiz et al., 2024). Las **dinámicas (J, K, Ñ, Q, X, Z) no se reconocen** en esta versión: se insertan con los botones del panel. La lista de letras dinámicas proviene de una sola fuente; conviene validarla con intérpretes de LSM.
- **La aplicación no incluye imágenes de las señas ni «sabe» LSM:** aprende únicamente lo que usted le enseñe. Las señas deben ser realizadas o validadas por una persona usuaria de la LSM.
- **Señas parecidas se confunden.** En la literatura se reportan confusiones entre G/H, V/W, D/I y C/O, y las letras peor clasificadas fueron N, M, B, G y H (Sánchez-Vicinaiz et al., 2024). El botón *Estimar precisión* ayuda a detectarlas.
- **La precisión estimada es optimista.** Se calcula con sus propias grabaciones (validación cruzada que excluye la toma del ejemplo evaluado). Con otra persona, otra cámara o distinta luz, la precisión real será menor: el estudio citado obtuvo 83.6 % con personas distintas a la que entrenó el modelo, usando otro método (red neuronal convolucional).
- Se rastrea **una sola mano**; use siempre la misma con la que entrenó. La mano debe verse completa en el cuadro.
- Esta función **no se probó con personas usuarias de LSM ni con una cámara real**; se verificó con pruebas unitarias y con manos sintéticas.

### Funcionamiento técnico

1. **Características.** Los 21 puntos de MediaPipe se convierten en un vector de 60 valores: se resta la muñeca y se divide entre el tamaño de la palma (invariante a posición y tamaño); se conserva la orientación y se da menor peso a la coordenada *z*, más ruidosa.
2. **Clasificación.** k vecinos más cercanos (k = 5) con voto ponderado por distancia (Cover y Hart, 1967). Se **rechaza** una mano que no se parezca a ningún ejemplo (umbral calculado a partir de la variación real entre grabaciones), para no escribir letras durante las transiciones.
3. **Estabilización.** Voto de mayoría sobre los últimos 5 fotogramas.
4. **Formación de palabras.** Un autómata confirma la seña tras 1 s, tolera parpadeos de 0.2 s y exige «soltar» la seña antes de repetirla.
5. **Validación cruzada «dejando fuera la grabación».** Cada ejemplo se evalúa solo con ejemplos de *otras* grabaciones, para no inflar la precisión comparando fotogramas casi idénticos.

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
│   ├── gestures.js         Lógica pura: gestos, filtro 1€, rechazo de saltos y correa (sin DOM)
│   ├── signs.js            Lógica pura del modo Señas: características, k-NN, palabras (sin DOM)
│   └── signs-ui.js         Interfaz del modo Señas: entrenamiento, palabra y persistencia
├── assets/
│   └── favicon.svg
├── tests/
│   ├── gestures.test.mjs   Pruebas unitarias de gestos y estabilización del cursor
│   └── signs.test.mjs      Pruebas unitarias del reconocimiento de señas y las palabras
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
7. **Estabilizador de correa.** El cursor queda unido al punto suavizado por una «correa» (≈10 px con el ajuste por defecto): el temblor dentro de ese radio no mueve el cursor, de modo que con la mano quieta no se generan líneas en zigzag. El radio se ajusta con el control «Suavizado del trazo».
8. **Dibujo.** Los trazos se almacenan con coordenadas normalizadas, por lo que son independientes de la resolución; esto permite deshacer, restaurar y redibujar sin pérdida de calidad.

## Pruebas

```bash
npm test
```

Ejecuta 46 pruebas unitarias (Node.js ≥ 18, sin dependencias): clasificación de gestos —incluida su invariancia a la rotación de la mano—, filtro de suavizado, rechazo de saltos bruscos, estabilizador de temblor, características invariantes a posición y tamaño, clasificador de señas (con rechazo de manos desconocidas), validación cruzada, formación de palabras (confirmación, repetición, espacio y borrado) y exportación/importación del entrenamiento.

## Consejos de uso y limitaciones

- Utilice **buena iluminación frontal** y un fondo sin otras manos en cuadro; la aplicación rastrea **una sola mano**.
- Mantenga la mano a unos 40–80 cm de la cámara, con la palma orientada hacia ella.
- **No acerque el dedo a la cámara.** El modelo localiza primero la palma completa; si solo se ve un dedo o la palma queda recortada por el borde del cuadro, no hay detección. Si pasan 2 s sin detectar la mano, la aplicación sugiere alejarla.
- Los dedos que apuntan directamente hacia la cámara pueden confundirse con dedos flexionados (efecto de escorzo).
- Si el trazo se siente con retardo, reduzca el control **Suavizado del trazo**; si tiembla, auméntelo.

## Referencias

### Formato APA (7.ª edición)

- Casiez, G., Roussel, N., & Vogel, D. (2012). 1 € filter: A simple speed-based low-pass filter for noisy input in interactive systems. En *Proceedings of the SIGCHI Conference on Human Factors in Computing Systems* (pp. 2527–2530). ACM. https://doi.org/10.1145/2207676.2208639
- Cover, T., & Hart, P. (1967). Nearest neighbor pattern classification. *IEEE Transactions on Information Theory, 13*(1), 21–27. https://doi.org/10.1109/TIT.1967.1053964
- Gómez-Terán, A., Priego-Sánchez, B., & Pinto, D. (2020). Postura esquelética de la mano para representar las configuraciones dactilológicas de la lengua de señas mexicana en un entorno virtual. *Research in Computing Science, 149*(8), 227–240. https://www.rcs.cic.ipn.mx/2020_149_8/Postura%20esqueletica%20de%20la%20mano%20para%20representar%20las%20configuraciones%20dactilologicas.pdf
- Google. (s. f.). *Hand landmarks detection guide for Web*. Google AI Edge. Recuperado el 14 de noviembre de 2026, de https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- López-Nava, I. H. (s. f.). *Aprende el alfabeto de la Lengua de Señas Mexicana (LSM) de manera interactiva* [Sitio web]. Recuperado el 15 de noviembre de 2026, de https://sites.google.com/view/husseinlopeznava/lsm
- Mejía-Pérez, K., Córdova-Esparza, D.-M., & del-Río-Magaña, E. (2021). Desarrollo de una base de datos para el reconocimiento de la lengua de señas mexicana. *Research in Computing Science, 150*(6), 393–408. https://www.rcs.cic.ipn.mx/2021_150_6/Desarrollo%20de%20una%20base%20de%20datos%20para%20el%20reconocimiento%20de%20la%20lengua%20de%20senas%20mexicana.pdf
- Sánchez-Vicinaiz, T. J., Camacho-Pérez, E., Castillo-Atoche, A. A., Cruz-Fernandez, M., García-Martínez, J. R., & Rodríguez-Reséndiz, J. (2024). MediaPipe frame and convolutional neural networks-based fingerspelling detection in Mexican Sign Language. *Technologies, 12*(8), Artículo 124. https://doi.org/10.3390/technologies12080124
- Zhang, F., Bazarevsky, V., Vakunov, A., Tkachenka, A., Sung, G., Chang, C.-L., & Grundmann, M. (2020). *MediaPipe Hands: On-device real-time hand tracking*. arXiv. https://arxiv.org/abs/2006.10214

### Formato IEEE

- [1] G. Casiez, N. Roussel, and D. Vogel, "1 € filter: A simple speed-based low-pass filter for noisy input in interactive systems," in *Proc. SIGCHI Conf. Human Factors Comput. Syst. (CHI '12)*, Austin, TX, USA, 2012, pp. 2527–2530, doi: 10.1145/2207676.2208639.
- [2] Google, "Hand landmarks detection guide for Web," Google AI Edge. [Online]. Available: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js (accessed Nov. 14, 2026).
- [3] F. Zhang *et al.*, "MediaPipe Hands: On-device real-time hand tracking," 2020, *arXiv:2006.10214*.
- [4] T. Cover and P. Hart, "Nearest neighbor pattern classification," *IEEE Trans. Inf. Theory*, vol. 13, no. 1, pp. 21–27, Jan. 1967, doi: 10.1109/TIT.1967.1053964.
- [5] A. Gómez-Terán, B. Priego-Sánchez, and D. Pinto, "Postura esquelética de la mano para representar las configuraciones dactilológicas de la lengua de señas mexicana en un entorno virtual," *Res. Comput. Sci.*, vol. 149, no. 8, pp. 227–240, 2020.
- [6] I. H. López-Nava, "Aprende el alfabeto de la Lengua de Señas Mexicana (LSM) de manera interactiva." [Online]. Available: https://sites.google.com/view/husseinlopeznava/lsm (accessed Nov. 15, 2026).
- [7] K. Mejía-Pérez, D.-M. Córdova-Esparza, and E. del-Río-Magaña, "Desarrollo de una base de datos para el reconocimiento de la lengua de señas mexicana," *Res. Comput. Sci.*, vol. 150, no. 6, pp. 393–408, 2021.
- [8] T. J. Sánchez-Vicinaiz *et al.*, "MediaPipe frame and convolutional neural networks-based fingerspelling detection in Mexican Sign Language," *Technologies*, vol. 12, no. 8, Art. no. 124, 2024, doi: 10.3390/technologies12080124.

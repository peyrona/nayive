# `tools/canvas-spike` — ¿aguantaría Canvas-Editor lo que hace Write?

Una **prueba**, no una migración. Nada de `client/apps/write/` se toca, y nada de
esto se despliega: `tools/` no va al VPS.

> **Aparcado el 17-09-2026.** El proyecto saca versión cada dos semanas; se
> espera a que esté más estable y más completo. Write pasó después (21-09) a docx-editor.dev.
> Para retomarlo: `tools/canvas-spike/build.sh <versión nueva>` y `smoke.mjs`,
> y ver si los dos fallos de abajo siguen ahí.

```sh
tools/canvas-spike/build.sh          # una vez: baja y empaqueta el editor (1,2 MB)
node tools/canvas-spike/serve.mjs    # abre http://localhost:8099/
node tools/canvas-spike/smoke.mjs    # pasa TODOS tus .docx por el importador, sin ventana
```

`smoke.mjs` necesita Chromium; `build.sh` necesita node + npm. Sin `node_modules`
permanentes, sin nada instalado fuera de esta carpeta.

## Qué se está preguntando

Write iba entonces montado sobre SuperDoc, cuyo motor `.docx` es propietario — por eso el
bundle no puede vivir en este repo público — y pesa 10,7 MB más un worker de
7,8 MB. Canvas-Editor es MIT, y su plugin oficial de `.docx` también. La duda no
es si funciona, es **qué se pierde**. Así que esto abre tus documentos de verdad
y lo cuenta.

## Lo que salió (17-09-2026, canvas-editor 1.0.3 + plugin docx 1.0.0)

Los 35 `.docx` de `~/Downloads/Telegram Desktop`:

| | |
|---|---|
| abren | **35 de 35**, sin un solo error en consola |
| páginas | se paginan solas; el más largo dio 73 páginas |
| pies de página | **0 perdidos** |
| encabezados | **4 perdidos** de 5 que llevaban algo |
| números de página | **4 congelados** |
| fondo de párrafo | **3 perdidos** de 3 que lo llevaban |
| español | á é í ó ú ü ñ ¿ ¡ « » — € se insertan y se buscan bien (el clic → teclado, míralo tú) |
| tamaño | 1,2 MB, 339 KB comprimido (SuperDoc: 10,7 MB + 7,8 MB) |

**Los cuatro encabezados perdidos son un solo fallo.** Tres llevan un logo en
VML (`<w:pict>`, la imagen a la antigua de Word) y el cuarto, `comments 4_…docx`,
lleva la palabra «Borrador» con una imagen moderna, un único `sectPr` y la
referencia `default` apuntando justo a él. Se pierden los cuatro. El importador
sí sabe leer `w:pict` **en el cuerpo** (`importDocx.ts`, línea 1394); el que lee
encabezados y pies es otro camino (`parseZone`, línea 485) y es el que se deja el
contenido. O sea: **un fallo del plugin en el lector de zonas**, no un límite de
diseño, y 4 de los 5 encabezados con algo dentro caen por él. Vale la pena
abrir una incidencia.

**Los números congelados.** El importador se salta la instrucción del campo y se
queda con el texto que Word dejó dibujado, así que un `PAGE` de Word entra como
un «2» fijo que ya no cuenta. Los que pongas **tú** en Write sí contarían: el
número de página es una opción del editor, y al exportar sale como campo de
verdad. Es decir: se pierde el de los documentos ajenos, no el de los tuyos.

**El fondo de párrafo no llega.** Un párrafo con `<w:pPr><w:shd w:fill="993366">`
y letra blanca — un titular sobre vino tinto — entra en blanco sobre blanco:
invisible, aunque el hueco sigue ahí y al seleccionar con el ratón se ve la
franja. El importador sí lee `w:shd` de un *run* (`importDocx.ts` línea 231) y de
una *celda de tabla* (línea 1749), pero `parseParagraphProps` (línea 1221) no lo
mira. Son dos fallos del plugin, entonces, y este es el segundo.

Se puede arreglar: poniendo a mano `highlight: '#993366'` en esos elementos y
`highlightAlpha: 1`, el editor lo pinta igual que LibreOffice. La única
diferencia es que la banda cubre el texto y no el ancho entero de la columna,
porque el editor no tiene fondo de párrafo, sólo resaltado por elemento.

**Y un detalle a comprobar:** la fuente por defecto del número de página es
*Microsoft YaHei*. Mira `getOptions().defaultFont` antes de dar por hecho que el
texto latino sale bien tal cual.

## Lo que aún tienes que ver tú

Esto no lo decide una tabla:

- **Imprimir.** `print()` de Canvas-Editor recibe una lista de imágenes base64 —
  el papel lleva fotos del texto, no letras. Dale a *Imprimir* y júzgalo en papel.
- **Escribir de verdad** un rato: el cursor, la selección, el ratón. Aquí el
  texto se ha metido llamando a `executeFocus()`; que un clic normal deje el
  teclado listo no está comprobado.
- **Volver a .docx**: *Guardar .docx* y abrir el resultado en LibreOffice. La
  exportación no se ha probado todavía, sólo la lectura.

## Cómo está hecho

| archivo | qué es |
|---|---|
| `build.sh` | baja las versiones fijadas y las empaqueta en `lib/` con esbuild |
| `buffer-stub.js` | tapa el `require("buffer")` muerto de docx.js (como `.peer-stub.js`) |
| `index.html` + `spike.js` | la página: barra, editor y la línea que dice qué sobrevivió |
| `serve.mjs` | sirve la raíz del repo (para `theme.css` y `app.css`) y `/corpus/` |
| `smoke.mjs` | la tabla de arriba, sin ventana |

Dos cosas salen más simples que con SuperDoc: los cuatro web workers van
incrustados como `data:` (no hay archivo de worker que fijar, y el servidor Go no
manda `Content-Security-Policy` — si algún día la mandase, necesitaría
`worker-src data:`), y no hay CSS: el editor pinta sobre un `<canvas>`.

Lo que **no** cambia: `proofing.js` habría que rehacerlo. El corrector de
SuperDoc parte el texto, pinta el subrayado y saca el menú; aquí lo hace un
plugin en la versión 0.0.1 que trae su propio diccionario y no acepta el tuyo.

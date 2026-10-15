// ===================================================================
// PhotoStudio Lite · editor de dibujo con la API de Canvas
// Dos lienzos superpuestos: `lienzo` guarda el dibujo y `vista` muestra
// la previsualización de formas mientras se arrastra el ratón.
// ===================================================================

const lienzo = document.getElementById('lienzo');
const vista = document.getElementById('vista');
const ctx = lienzo.getContext('2d', { willReadFrequently: true });
const vctx = vista.getContext('2d');
const $ = (id) => document.getElementById(id);

const NOMBRES = {
  pincel: 'Pincel', goma: 'Goma', linea: 'Línea', rectangulo: 'Rectángulo',
  elipse: 'Elipse', bote: 'Bote de pintura', cuentagotas: 'Cuentagotas', texto: 'Texto',
};
const ATAJOS = { b: 'pincel', e: 'goma', l: 'linea', r: 'rectangulo', o: 'elipse', g: 'bote', i: 'cuentagotas', t: 'texto' };
const PALETA = ['#000000', '#ffffff', '#6b7280', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6',
                '#3b82f6', '#7c3aed', '#ec4899', '#92400e', '#fecaca', '#bbf7d0', '#bfdbfe', '#e9d5ff'];

let herramienta = 'pincel';
let dibujando = false;
let inicio = null;
let ultimo = null;

const opciones = () => ({
  color: $('color').value,
  grosor: +$('grosor').value,
  opacidad: +$('opacidad').value / 100,
  relleno: $('relleno').checked,
});

// ------------------------- Historial (deshacer / rehacer) -------------------------
const historial = [];
let posicion = -1;
const MAX_HISTORIAL = 40;

function guardarEstado() {
  historial.splice(posicion + 1); // al hacer algo nuevo se descarta lo "rehacible"
  historial.push(ctx.getImageData(0, 0, lienzo.width, lienzo.height));
  if (historial.length > MAX_HISTORIAL) historial.shift();
  posicion = historial.length - 1;
}

function moverHistorial(paso) {
  const nueva = posicion + paso;
  if (nueva < 0 || nueva >= historial.length) return;
  posicion = nueva;
  ctx.putImageData(historial[posicion], 0, 0);
}

function lienzoNuevo() {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  guardarEstado();
}

// ------------------------- Coordenadas -------------------------
// El canvas se muestra escalado: se convierte la posición del puntero a píxeles reales
function punto(e) {
  const r = vista.getBoundingClientRect();
  return {
    x: Math.round(((e.clientX - r.left) / r.width) * lienzo.width),
    y: Math.round(((e.clientY - r.top) / r.height) * lienzo.height),
  };
}

// ------------------------- Dibujo de formas -------------------------
function trazarForma(c, tipo, a, b, o) {
  c.save();
  c.globalAlpha = o.opacidad;
  c.strokeStyle = c.fillStyle = o.color;
  c.lineWidth = o.grosor;
  c.lineCap = c.lineJoin = 'round';
  c.beginPath();
  if (tipo === 'linea') {
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
  } else if (tipo === 'rectangulo') {
    c.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (tipo === 'elipse') {
    c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
  }
  if (o.relleno && tipo !== 'linea') c.fill();
  else c.stroke();
  c.restore();
}

// Pincel y goma: se dibuja en `vista` mientras se arrastra (así la opacidad no se acumula
// en los cruces del trazo) y al soltar se vuelca al lienzo.
let trazo = [];
function pintarTrazo(c, puntos, o, goma) {
  c.save();
  c.lineCap = c.lineJoin = 'round';
  c.lineWidth = o.grosor;
  c.strokeStyle = goma ? '#ffffff' : o.color;
  c.beginPath();
  c.moveTo(puntos[0].x, puntos[0].y);
  if (puntos.length === 1) c.lineTo(puntos[0].x + 0.1, puntos[0].y);
  for (let i = 1; i < puntos.length; i++) {
    if ($('suavizado').checked && i < puntos.length - 1) {
      // Curva por el punto medio: trazos suaves aunque el ratón vaya rápido
      const medio = { x: (puntos[i].x + puntos[i + 1].x) / 2, y: (puntos[i].y + puntos[i + 1].y) / 2 };
      c.quadraticCurveTo(puntos[i].x, puntos[i].y, medio.x, medio.y);
    } else c.lineTo(puntos[i].x, puntos[i].y);
  }
  c.stroke();
  c.restore();
}

// ------------------------- Bote de pintura (relleno por inundación) -------------------------
function rellenar(x, y, colorHex, opacidad, tolerancia = 32) {
  const { width: w, height: h } = lienzo;
  const imagen = ctx.getImageData(0, 0, w, h);
  const d = imagen.data;
  const i0 = (y * w + x) * 4;
  const objetivo = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
  const nuevo = [parseInt(colorHex.slice(1, 3), 16), parseInt(colorHex.slice(3, 5), 16), parseInt(colorHex.slice(5, 7), 16)];
  const parecido = (i) =>
    Math.abs(d[i] - objetivo[0]) + Math.abs(d[i + 1] - objetivo[1]) + Math.abs(d[i + 2] - objetivo[2]) + Math.abs(d[i + 3] - objetivo[3]) <= tolerancia * 4;
  if (nuevo.every((v, k) => Math.abs(v - objetivo[k]) < 2) && opacidad === 1) return;

  const visitado = new Uint8Array(w * h);
  const pila = [[x, y]];
  while (pila.length) {
    let [px, py] = pila.pop();
    // Recorre hacia la izquierda hasta el borde y rellena la fila completa (scanline)
    while (px > 0 && parecido((py * w + px - 1) * 4) && !visitado[py * w + px - 1]) px--;
    let arriba = false;
    let abajo = false;
    for (; px < w && parecido((py * w + px) * 4) && !visitado[py * w + px]; px++) {
      const i = (py * w + px) * 4;
      visitado[py * w + px] = 1;
      for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] * (1 - opacidad) + nuevo[k] * opacidad);
      d[i + 3] = 255;
      for (const [dy, flag] of [[-1, 'arriba'], [1, 'abajo']]) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        const coincide = parecido((ny * w + px) * 4) && !visitado[ny * w + px];
        if (flag === 'arriba') {
          if (coincide && !arriba) pila.push([px, ny]);
          arriba = coincide;
        } else {
          if (coincide && !abajo) pila.push([px, ny]);
          abajo = coincide;
        }
      }
    }
  }
  ctx.putImageData(imagen, 0, 0);
}

// ------------------------- Texto -------------------------
function crearTexto(p) {
  const o = opciones();
  const tamano = Math.max(14, o.grosor * 3);
  const escala = vista.getBoundingClientRect().width / lienzo.width;
  const caja = document.createElement('div');
  caja.className = 'editor-texto';
  caja.contentEditable = true;
  Object.assign(caja.style, {
    left: `${p.x * escala}px`,
    top: `${(p.y - tamano / 2) * escala}px`,
    fontSize: `${tamano * escala}px`,
    color: o.color,
  });
  $('lienzos').appendChild(caja);
  setTimeout(() => caja.focus());

  const confirmar = () => {
    const texto = caja.innerText.trim();
    caja.remove();
    if (!texto) return;
    ctx.save();
    ctx.globalAlpha = o.opacidad;
    ctx.fillStyle = o.color;
    ctx.font = `700 ${tamano}px Manrope, sans-serif`;
    ctx.textBaseline = 'top';
    texto.split('\n').forEach((linea, i) => ctx.fillText(linea, p.x, p.y - tamano / 2 + i * tamano * 1.15));
    ctx.restore();
    guardarEstado();
  };
  caja.addEventListener('blur', confirmar, { once: true });
  caja.addEventListener('keydown', (e) => {
    e.stopPropagation(); // que las teclas no activen atajos mientras se escribe
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      caja.blur();
    }
    if (e.key === 'Escape') {
      caja.innerText = '';
      caja.blur();
    }
  });
}

// ------------------------- Eventos del puntero (ratón, lápiz y táctil) -------------------------
vista.addEventListener('pointerdown', (e) => {
  const p = punto(e);
  const o = opciones();

  if (herramienta === 'cuentagotas') {
    const [r, g, b] = ctx.getImageData(p.x, p.y, 1, 1).data;
    cambiarColor('#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''));
    return;
  }
  if (herramienta === 'bote') {
    rellenar(p.x, p.y, o.color, o.opacidad);
    guardarEstado();
    return;
  }
  if (herramienta === 'texto') return crearTexto(p);

  vista.setPointerCapture(e.pointerId);
  dibujando = true;
  inicio = ultimo = p;
  trazo = [p];
});

vista.addEventListener('pointermove', (e) => {
  const p = punto(e);
  $('estado-pos').textContent = `${p.x}, ${p.y}`;
  if (!dibujando) return;
  const o = opciones();
  vctx.clearRect(0, 0, vista.width, vista.height);

  if (herramienta === 'pincel' || herramienta === 'goma') {
    trazo.push(p);
    vctx.globalAlpha = herramienta === 'goma' ? 1 : o.opacidad;
    pintarTrazo(vctx, trazo, o, herramienta === 'goma');
    vctx.globalAlpha = 1;
  } else {
    trazarForma(vctx, herramienta, inicio, p, o);
  }
  ultimo = p;
});

vista.addEventListener('pointerup', () => {
  if (!dibujando) return;
  dibujando = false;
  vctx.clearRect(0, 0, vista.width, vista.height);
  const o = opciones();
  if (herramienta === 'pincel' || herramienta === 'goma') {
    ctx.save();
    ctx.globalAlpha = herramienta === 'goma' ? 1 : o.opacidad;
    pintarTrazo(ctx, trazo, o, herramienta === 'goma');
    ctx.restore();
  } else {
    trazarForma(ctx, herramienta, inicio, ultimo, o);
  }
  guardarEstado();
});
vista.addEventListener('pointerleave', () => ($('estado-pos').textContent = '—'));

// ------------------------- Herramientas y propiedades -------------------------
function elegirHerramienta(nombre) {
  herramienta = nombre;
  document.querySelectorAll('[data-herramienta]').forEach((b) => b.classList.toggle('activa', b.dataset.herramienta === nombre));
  $('estado-herramienta').textContent = NOMBRES[nombre];
  vista.style.cursor = { texto: 'text', cuentagotas: 'copy', bote: 'cell' }[nombre] ?? 'crosshair';
}

function cambiarColor(hex) {
  $('color').value = hex;
  $('hex').textContent = hex.toUpperCase();
}

document.querySelectorAll('[data-herramienta]').forEach((b) => b.addEventListener('click', () => elegirHerramienta(b.dataset.herramienta)));
$('color').addEventListener('input', (e) => cambiarColor(e.target.value));
$('grosor').addEventListener('input', (e) => ($('v-grosor').textContent = `${e.target.value} px`));
$('opacidad').addEventListener('input', (e) => ($('v-opacidad').textContent = `${e.target.value} %`));

PALETA.forEach((hex) => {
  const b = document.createElement('button');
  b.style.background = hex;
  b.title = hex;
  b.addEventListener('click', () => cambiarColor(hex));
  $('paleta').appendChild(b);
});

// Filtros: se redibuja el lienzo sobre sí mismo aplicando un filtro CSS de Canvas
document.querySelectorAll('[data-filtro]').forEach((b) =>
  b.addEventListener('click', () => {
    const copia = document.createElement('canvas');
    copia.width = lienzo.width;
    copia.height = lienzo.height;
    copia.getContext('2d').drawImage(lienzo, 0, 0);
    ctx.save();
    ctx.filter = b.dataset.filtro;
    ctx.drawImage(copia, 0, 0);
    ctx.restore();
    guardarEstado();
  }),
);

// ------------------------- Abrir y guardar -------------------------
function abrirImagen(archivo) {
  if (!archivo?.type.startsWith('image/')) return;
  const img = new Image();
  img.onload = () => {
    lienzoNuevo();
    // Ajusta la imagen al lienzo manteniendo la proporción
    const escala = Math.min(lienzo.width / img.width, lienzo.height / img.height);
    const w = img.width * escala;
    const h = img.height * escala;
    ctx.drawImage(img, (lienzo.width - w) / 2, (lienzo.height - h) / 2, w, h);
    URL.revokeObjectURL(img.src);
    guardarEstado();
  };
  img.src = URL.createObjectURL(archivo);
}

function guardarPng() {
  const enlace = document.createElement('a');
  enlace.download = `photostudio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
  enlace.href = lienzo.toDataURL('image/png');
  enlace.click();
}

$('abrir').addEventListener('change', (e) => abrirImagen(e.target.files[0]));
const area = $('area');
area.addEventListener('dragover', (e) => {
  e.preventDefault();
  area.classList.add('arrastrando');
});
area.addEventListener('dragleave', () => area.classList.remove('arrastrando'));
area.addEventListener('drop', (e) => {
  e.preventDefault();
  area.classList.remove('arrastrando');
  abrirImagen(e.dataTransfer.files[0]);
});

const ACCIONES = {
  nuevo: () => confirm('¿Empezar un lienzo en blanco? Podrás deshacerlo.') && lienzoNuevo(),
  deshacer: () => moverHistorial(-1),
  rehacer: () => moverHistorial(1),
  guardar: guardarPng,
};
document.querySelectorAll('[data-accion]').forEach((b) => b.addEventListener('click', ACCIONES[b.dataset.accion]));

// ------------------------- Atajos de teclado -------------------------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, [contenteditable]')) return;
  const tecla = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (tecla === 'z') moverHistorial(e.shiftKey ? 1 : -1);
    else if (tecla === 'y') moverHistorial(1);
    else if (tecla === 's') guardarPng();
    else return;
    e.preventDefault();
  } else if (ATAJOS[tecla]) elegirHerramienta(ATAJOS[tecla]);
  else if (tecla === '[' || tecla === ']') {
    const g = $('grosor');
    g.value = +g.value + (tecla === ']' ? 2 : -2);
    g.dispatchEvent(new Event('input'));
  }
});

lienzoNuevo();

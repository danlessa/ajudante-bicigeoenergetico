// ============================================================================
// media-pipeline.js — o pipeline de mídia do upload_images.html como módulo ES.
//
// CÓPIA VERBATIM dos helpers do formulário completo (web/upload_images.html),
// gerada mecanicamente por marcador de função — pHash de foto e de vídeo,
// variantes JPEG + cópia do EXIF, fuso, extração de GPS/data do moov,
// transcodificação (WebCodecs via mediabunny → MediaRecorder passe único →
// sequencial). Consumidor: web/subir.html (envio simplificado). O formulário
// completo AINDA carrega as suas próprias cópias inline (é um script de 3.600
// linhas que não foi refatorado pra importar daqui) — ao mudar um helper lá,
// regenere/atualize este arquivo, senão os dois forms divergem (o pHash TEM
// que sair idêntico nos dois, é a base da dedup).
//
// Só o que não existe lá em forma reutilizável foi escrito aqui, no fim:
// `processClipFile` (a cadeia de motores do processClip, sem o card) e
// `probeVideoDuration`.
// ============================================================================

function pad(n) { return String(n).padStart(2, '0'); }
function dateToLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// offsetOverride (ex: "+02:00"/"-03:00", vindo do EXIF OffsetTimeOriginal)
// prevalece sobre o fuso do navegador — o wall-clock em `s` normalmente veio
// do EXIF, que não carrega fuso; só sabemos o fuso real de gravação quando a
// câmera/telefone grava OffsetTimeOriginal (D4). Sem override, comportamento
// antigo (fuso do navegador) é mantido — o caso comum (SP filmado/subido em
// SP) não muda.
function localToXsdDateTime(s, offsetOverride) {
  const d = new Date(s); if (isNaN(d)) return null;
  let m = /^([+-])(\d{2}):?(\d{2})$/.exec(offsetOverride || '');
  let sign, oh, om;
  // Um OffsetTimeOriginal corrompido (ex.: "+45:00") passaria no regex e
  // assaria um xsd:dateTime inválido no catálogo — o XSD limita o fuso a
  // ±14:00. Fora da faixa, ignora o override e cai no fuso do navegador.
  if (m && (parseInt(m[2], 10) > 14 || parseInt(m[3], 10) > 59)) {
    console.warn(`EXIF OffsetTimeOriginal inválido (${offsetOverride}) — usando fuso do navegador`);
    m = null;
  }
  if (m) {
    [, sign, oh, om] = m;
  } else {
    const off = -d.getTimezoneOffset();
    sign = off >= 0 ? '+' : '-';
    oh = pad(Math.floor(Math.abs(off) / 60));
    om = pad(Math.abs(off) % 60);
  }
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
         `${sign}${oh}:${om}`;
}

// ===================== Hash perceptual (pHash) =========================
// pHash (Hacker Factor / Zauner): 32×32 cinza → DCT 2D → bloco 8×8 de
// baixa frequência → bit = 1 se coef > mediana, else 0. Resultado: 64 bits
// (16 hex). Mais robusto a mudanças de brilho/contraste/rotações pequenas
// do que um dHash gradient-based. Fotos quase idênticas → mesmo pHash (cluster id).
function dct1d(input, N) {
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    const f = Math.PI * k / (2 * N);
    for (let n = 0; n < N; n++) sum += input[n] * Math.cos((2 * n + 1) * f);
    out[k] = sum;
  }
  return out;
}
function pHashFromRgba(data, N) {
  // Grayscale matrix (linha-major)
  const m = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    m[i] = data[i*4]*0.299 + data[i*4+1]*0.587 + data[i*4+2]*0.114;
  }
  // DCT 2D separável: linhas, depois colunas
  const tmp = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const out = dct1d(m.subarray(y * N, (y + 1) * N), N);
    for (let x = 0; x < N; x++) tmp[y * N + x] = out[x];
  }
  const dct = new Float32Array(N * N);
  const col = new Float32Array(N);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) col[y] = tmp[y * N + x];
    const out = dct1d(col, N);
    for (let y = 0; y < N; y++) dct[y * N + x] = out[y];
  }
  // Bloco 8×8 de baixa frequência (top-left)
  const block = new Float32Array(64);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) block[y * 8 + x] = dct[y * N + x];

  // Mediana excluindo o termo DC (block[0])
  const sorted = Array.from(block.slice(1)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let hex = '';
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col2 = 0; col2 < 8; col2++) {
      byte = (byte << 1) | (block[row * 8 + col2] > median ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function computePHash(bitmap) {
  const N = 32;
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  c.getContext('2d').drawImage(bitmap, 0, 0, N, N);
  const data = c.getContext('2d').getImageData(0, 0, N, N).data;
  return pHashFromRgba(data, N);
}

// pHash de vídeo: amostra N quadros uniformes na duração, computa pHash
// de cada, e funde via voto majoritário por bit. Resultado é um pHash de
// 16 hex análogo ao de imagens — entra como IRI do clip (phd:video_<vhash>).
// Robusto a re-encoding: cortar/recomprimir o mesmo vídeo devolve pHash igual.
async function computeVideoPHash(file, N = 8) {
  const v = document.createElement('video');
  const url = URL.createObjectURL(file);
  v.src = url;
  const SIDE = 32;
  const C = document.createElement('canvas');
  C.width = SIDE; C.height = SIDE;
  const ctx = C.getContext('2d', { willReadFrequently: true });
  const bitsHistogram = new Uint16Array(64);
  let got = 0;
  // Desenha o quadro ATUAL do vídeo e soma seus bits no histograma.
  const accumulate = () => {
    ctx.drawImage(v, 0, 0, SIDE, SIDE);
    const hex = pHashFromRgba(ctx.getImageData(0, 0, SIDE, SIDE).data, SIDE);
    for (let row = 0; row < 8; row++) {
      const byte = parseInt(hex.substr(row * 2, 2), 16);
      for (let b = 0; b < 8; b++) if (byte & (1 << (7 - b))) bitsHistogram[row * 8 + b]++;
    }
    got++;
  };
  try {
    await primeVideoForFrames(v, 'vídeo não carregou pro pHash');
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (dur > 0.15) {
      // Amostra N quadros ao longo da duração. Alguns navegadores (Firefox/
      // Safari) NÃO conseguem fazer seek em HEVC 4K 10-bit HDR — nesse caso o
      // seek falha; pulamos o quadro e, se NENHUM der certo (bail após 2
      // falhas seguidas sem sucesso), caímos pro quadro já decodificado.
      for (let i = 0; i < N; i++) {
        const t = Math.min(Math.max(0.05, ((i + 0.5) / N) * dur), Math.max(0.05, dur - 0.05));
        try {
          await robustVideoSeek(v, t, 'seek', 6000);
          await new Promise((r) => setTimeout(r, 24));   // deixa pintar o quadro
          accumulate();
        } catch (_) {
          if (got === 0 && i >= 1) break;
        }
      }
    }
    // Sem nenhum seek: usa o quadro já decodificado (o prime garante o 1º).
    if (got === 0) { try { await new Promise((r) => setTimeout(r, 24)); accumulate(); } catch (_) {} }
    // Último recurso: nem o quadro atual deu — hash do conteúdo do arquivo.
    if (got === 0) return await fileFallbackHash(file);
    const half = got / 2;
    let out = '';
    for (let row = 0; row < 8; row++) {
      let byte = 0;
      for (let b = 0; b < 8; b++) if (bitsHistogram[row * 8 + b] > half) byte |= (1 << (7 - b));
      out += byte.toString(16).padStart(2, '0');
    }
    // pHash uniforme (0000…/ffff…) = quadro preto/uniforme — o navegador
    // decodificou mas não desenhou o HEVC/HDR no canvas. Colidiria entre vídeos
    // diferentes (todos viram o mesmo IRI → 2º upload rejeitado como duplicado)
    // → cai pro hash do arquivo, que é único por arquivo.
    if (/^(.)\1{15}$/.test(out)) return await fileFallbackHash(file);
    return out;
  } finally {
    URL.revokeObjectURL(url);
    try { v.pause(); } catch (_) {}
    v.remove();
  }
}

// Fallback quando não dá pra extrair NENHUM quadro (ex.: HEVC 4K HDR que o
// navegador decodifica o 1º quadro mas trava no seek/canvas). Deriva 16 hex do
// início + tamanho do arquivo — dedup de re-upload EXATO (não é perceptual, mas
// evita travar o envio).
async function fileFallbackHash(file) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.slice(0, 1 << 20).arrayBuffer());
    const bytes = new Uint8Array(digest);
    let h = '';
    for (let i = 0; i < 6; i++) h += bytes[i].toString(16).padStart(2, '0');
    return (h + (file.size >>> 0).toString(16)).slice(0, 16).padEnd(16, '0');
  } catch (_) {
    return ((file.size || 0).toString(16) + '0000000000000000').slice(0, 16);
  }
}

// ===================== Processamento de imagem =========================
function drawToCanvas(bitmap, maxDim) {
  const w = bitmap.width, h = bitmap.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  c.getContext('2d').drawImage(bitmap, 0, 0, cw, ch);
  return c;
}
function encodeJpeg(canvas, q) {
  return new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', q));
}
async function compressToTarget(bitmap, maxBytes, startDim = 2400) {
  for (const dim of [startDim, 1800, 1400, 1100, 900, 700, 500]) {
    const canvas = drawToCanvas(bitmap, dim);
    for (const q of [0.85, 0.7, 0.55, 0.4, 0.3]) {
      const blob = await encodeJpeg(canvas, q);
      if (blob.size <= maxBytes) return blob;
    }
  }
  return await encodeJpeg(drawToCanvas(bitmap, 500), 0.3);
}
async function makeThumbnail(bitmap, dim = 256) {
  return await encodeJpeg(drawToCanvas(bitmap, dim), 0.75);
}
async function anonymizeJpeg(bitmap, q = 0.92) {
  // re-encoda sem usar EXIF da origem → strip de metadados
  return await encodeJpeg(drawToCanvas(bitmap, Math.max(bitmap.width, bitmap.height)), q);
}

// Reescreve a tag Orientation (0x0112) do IFD0 para 1 ("normal"). O canvas
// produz pixels já na orientação visual (createImageBitmap aplica EXIF), então
// manter a Orientation original faria o browser rotacionar de novo na exibição.
function normalizeExifOrientation(exifSeg) {
  if (exifSeg.length < 18) return;
  // exifSeg: FFE1 <len:2> "Exif\0\0" <tiff…>  → TIFF começa no offset 10
  const t = 10;
  const le = exifSeg[t] === 0x49 && exifSeg[t+1] === 0x49;
  const be = exifSeg[t] === 0x4D && exifSeg[t+1] === 0x4D;
  if (!le && !be) return;
  const u16 = (o) => le ? exifSeg[o] | (exifSeg[o+1] << 8)
                        : (exifSeg[o] << 8) | exifSeg[o+1];
  const u32 = (o) => le ? ((exifSeg[o]) | (exifSeg[o+1] << 8) | (exifSeg[o+2] << 16) | (exifSeg[o+3] << 24)) >>> 0
                        : ((exifSeg[o] << 24) | (exifSeg[o+1] << 16) | (exifSeg[o+2] << 8) | exifSeg[o+3]) >>> 0;
  if (u16(t + 2) !== 0x002A) return;
  const ifd0 = t + u32(t + 4);
  if (ifd0 + 2 > exifSeg.length) return;
  const n = u16(ifd0);
  for (let e = 0; e < n; e++) {
    const entry = ifd0 + 2 + e * 12;
    if (entry + 12 > exifSeg.length) break;
    if (u16(entry) === 0x0112) {
      // tipo SHORT(3), count 1 → valor fica nos 2 primeiros bytes de [entry+8..]
      exifSeg[entry + 8] = le ? 0x01 : 0x00;
      exifSeg[entry + 9] = le ? 0x00 : 0x01;
      return;
    }
  }
}

// Copia o APP1/Exif do JPEG de origem para um blob JPEG já re-encodado pelo
// canvas (que sempre nasce sem metadados). Se a origem não for JPEG ou não
// tiver Exif, devolve o blob alvo intacto.
async function copyExifSegment(sourceFile, targetBlob) {
  const src = new Uint8Array(await sourceFile.arrayBuffer());
  if (src.length < 4 || src[0] !== 0xFF || src[1] !== 0xD8) return targetBlob;

  let exifSeg = null;
  for (let i = 2; i < src.length - 4; ) {
    if (src[i] !== 0xFF) break;
    const marker = src[i + 1];
    if (marker === 0xDA || marker === 0xD9) break;   // SOS / EOI — acabou o cabeçalho
    const segLen = (src[i + 2] << 8) | src[i + 3];
    if (segLen < 2) break;
    if (marker === 0xE1 &&
        src[i + 4] === 0x45 && src[i + 5] === 0x78 &&    // 'E' 'x'
        src[i + 6] === 0x69 && src[i + 7] === 0x66 &&    // 'i' 'f'
        src[i + 8] === 0x00 && src[i + 9] === 0x00) {
      exifSeg = src.slice(i, i + 2 + segLen);
      break;
    }
    i += 2 + segLen;
  }
  if (!exifSeg) return targetBlob;
  normalizeExifOrientation(exifSeg);

  const tgt = new Uint8Array(await targetBlob.arrayBuffer());
  if (tgt[0] !== 0xFF || tgt[1] !== 0xD8) return targetBlob;
  const out = new Uint8Array(2 + exifSeg.length + (tgt.length - 2));
  out.set(tgt.subarray(0, 2), 0);
  out.set(exifSeg, 2);
  out.set(tgt.subarray(2), 2 + exifSeg.length);
  return new Blob([out], { type: 'image/jpeg' });
}

function hammingDistance(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return Infinity;
  let total = 0;
  for (let i = 0; i < h1.length; i += 2) {
    let x = parseInt(h1.substr(i, 2), 16) ^ parseInt(h2.substr(i, 2), 16);
    while (x) { total += x & 1; x >>>= 1; }
  }
  return total;
}

function isHeicFile(file) {
  const t = (file.type || '').toLowerCase();
  if (t === 'image/heic' || t === 'image/heif') return true;
  return /\.(heic|heif)$/i.test(file.name);
}

function isVideoFile(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(file.name);
}

// ===================== Vídeo: extração de metadados ====================
// Procura ISO 6709 ("+DD.DDDD+DDD.DDDD[+ALT]/") nas pontas do arquivo.
// Em MOV/MP4 da Apple, o moov vem no início (faststart) ou no fim.
async function tryExtractVideoGps(f) {
  const N = 16 * 1024 * 1024;
  const slices = [
    f.slice(0, Math.min(N, f.size)),
    f.size > N ? f.slice(Math.max(0, f.size - N)) : null,
  ].filter(Boolean);
  const re = /([+-]\d{1,3}\.\d{2,})([+-]\d{1,3}\.\d{2,})(?:([+-]\d+\.\d+))?\//;
  for (const sl of slices) {
    const text = new TextDecoder('latin1').decode(await sl.arrayBuffer());
    const m = re.exec(text);
    if (!m) continue;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

// Extrai data/hora de gravação dos metadados do MOV/MP4. Tenta, em ordem:
//   1) ISO 8601 com FUSO HORÁRIO em qualquer lugar do moov — recording
//      time gravado por iPhones (chave `com.apple.quicktime.creationdate`)
//      sempre traz TZ. As outras datas do MP4 (mvhd/tkhd modification)
//      são binárias e UTC implícito, então o filtro "com TZ" naturalmente
//      isola a hora de gravação.
//      Nota: a string da CHAVE e o VALOR ficam em atoms separados
//      (`keys` vs `ilst`), então NÃO procuramos pelo nome da chave —
//      procuramos diretamente por uma datetime com TZ.
//   2) Atom binário `mvhd`: uint32 BE seg. desde 1904-01-01 UTC (v0) ou
//      uint64 (v1). Só usado se não houver ISO+TZ — em iPhones isso vira
//      a hora do "save"/edit, não da gravação; nas câmeras simples sem
//      Apple metadata costuma ser a hora certa.
async function tryExtractVideoCreationDate(f) {
  const N = 16 * 1024 * 1024;
  const slices = [
    f.slice(0, Math.min(N, f.size)),
    f.size > N ? f.slice(Math.max(0, f.size - N)) : null,
  ].filter(Boolean);
  // Datetime com FUSO obrigatório: `YYYY-MM-DDTHH:MM:SS[+HHMM|+HH:MM|Z]`.
  // `g` pra varrer todos os hits — escolhemos o mais antigo entre 1990–2050
  // (mvhd "modification" do iPhone às vezes aparece como ISO num atom legado
  // junto de mtime real; a gravação é a mais antiga das duas).
  const ISO_TZ_RE = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})/g;
  const QT_EPOCH_OFFSET = 2_082_844_800;

  let earliestIso = null;
  for (const sl of slices) {
    const buf  = await sl.arrayBuffer();
    const text = new TextDecoder('latin1').decode(buf);
    ISO_TZ_RE.lastIndex = 0;
    let m;
    while ((m = ISO_TZ_RE.exec(text))) {
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}`;
      const dt = new Date(iso);
      if (isNaN(dt.getTime())) continue;
      // Sanidade: 1990–2050.
      const y = dt.getUTCFullYear();
      if (y < 1990 || y > 2050) continue;
      if (!earliestIso || dt < earliestIso) earliestIso = dt;
    }
  }
  if (earliestIso) return dateToLocalInput(earliestIso);

  // Fallback binário (câmeras sem Apple metadata).
  for (const sl of slices) {
    const buf  = await sl.arrayBuffer();
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length - 20; i++) {
      if (bytes[i] !== 0x6d || bytes[i+1] !== 0x76 ||
          bytes[i+2] !== 0x68 || bytes[i+3] !== 0x64) continue;
      const version = bytes[i + 4];
      let qtSec = 0;
      if (version === 0) {
        qtSec = view.getUint32(i + 8, false);
      } else if (version === 1) {
        const hi = view.getUint32(i + 8, false);
        const lo = view.getUint32(i + 12, false);
        qtSec = hi * 0x100000000 + lo;
      } else {
        continue;
      }
      if (!qtSec) continue;
      const unix = qtSec - QT_EPOCH_OFFSET;
      if (unix < 631_152_000 || unix > 2_524_608_000) continue;
      const dt = new Date(unix * 1000);
      if (!isNaN(dt.getTime())) return dateToLocalInput(dt);
    }
  }
  return null;
}

// Decodifica o 1º quadro do vídeo num blob JPEG (thumb do card).
async function videoFirstFrameBlob(file) {
  const v = document.createElement('video');
  const url = URL.createObjectURL(file);
  v.src = url;
  try {
    await primeVideoForFrames(v, 'vídeo não pôde carregar');
    // Seek pra ~5% da duração — evita o frame todo preto da partida. Se o seek
    // falhar (HEVC 4K HDR no Firefox/Safari), usa o quadro já decodificado.
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (dur > 0.4) {
      const t = Math.min(Math.max(0.2, dur * 0.05), Math.max(0.2, dur - 0.1));
      try { await robustVideoSeek(v, t, 'seek', 6000); } catch (_) { /* usa o 1º quadro */ }
    }
    await new Promise((r) => setTimeout(r, 24));
    const W = Math.min(320, v.videoWidth || 320);
    const H = Math.round((v.videoHeight || 180) * (W / (v.videoWidth || 320)));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(v, 0, 0, W, H);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  } finally {
    URL.revokeObjectURL(url);
    try { v.pause(); } catch (_) {}
    v.remove();
  }
}

// ===================== Vídeo: transcodificação =========================
// MediaRecorder grava o canvas re-escalado + a trilha de áudio do source
// num webm único (vp9+opus ou vp8+opus). Áudio embutido garante som no
// ghost-video player em iOS (iOS Safari muta MediaElementAudioSourceNode
// em algumas configs — som embutido contorna isso). Mantemos extractAudio
// gerando `<vhash>.audio.webm` separado pra o audio loop usar sem precisar
// baixar o webm de vídeo cheio.
// Aguarda um evento de mídia com timeout + tratamento de 'error' — sem isto,
// um `seeked`/`loadedmetadata` que nunca dispara (codec problemático, aba em
// background) pendurava o transcode pra sempre e travava a UI de upload.
function waitVideoEvent(el, name, errMsg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let to = 0;
    const off = () => { clearTimeout(to); el.removeEventListener(name, ok); el.removeEventListener('error', bad); };
    const ok  = () => { off(); resolve(); };
    const bad = () => { off(); reject(new Error(errMsg)); };
    el.addEventListener(name, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
    to = setTimeout(bad, timeoutMs);
  });
}

// iOS Safari é chato pra extrair quadros de <video>: com o elemento DESANEXADO
// e "frio", os seeks muitas vezes não disparam 'seeked' (o pHash/thumb falhava
// com "seek falhou"). Anexa fora da tela, espera decodificar (loadeddata) e
// esquenta o decoder com um play/pause mudo — aí os seeks passam a funcionar.
async function primeVideoForFrames(v, errMsg = 'vídeo não decodificou') {
  v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
  Object.assign(v.style, {
    position: 'fixed', left: '-9999px', top: '0', width: '1px', height: '1px',
    opacity: '0', pointerEvents: 'none',
  });
  if (!v.isConnected) document.body.appendChild(v);
  await waitVideoEvent(v, 'loadeddata', errMsg, 20000);
  try { const p = v.play(); if (p) await p; v.pause(); } catch (_) { /* autoplay bloqueado: segue */ }
}
// Seek robusto: resolve no 'seeked' OU quando currentTime chega perto do alvo
// (poll) — contorna o iOS, que às vezes não emite 'seeked'. `v` já deve estar
// "quente" (ver primeVideoForFrames).
function robustVideoSeek(v, t, errMsg = 'seek falhou', timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onErr);
      clearInterval(iv); clearTimeout(to);
      ok ? resolve() : reject(new Error(errMsg));
    };
    const onSeeked = () => { if (!v.seeking) finish(true); };
    const onErr = () => finish(false);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onErr);
    const iv = setInterval(() => {
      if (!v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) < 0.1) finish(true);
    }, 80);
    const to = setTimeout(() => finish(false), timeoutMs);
    try { v.currentTime = t; } catch (_) { finish(false); }
  });
}

async function transcodeAtShortSide(blob, startSec, endSec, shortSide, onProgress) {
  return new Promise(async (resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    video.src = url;
    video.muted = false;
    video.playsInline = true;
    video.preload = 'auto';
    let audioCtx = null, audioSrc = null, videoStream = null, combined = null;
    let raf = 0, watchdog = 0, settled = false;
    // Cleanup ÚNICO e idempotente, alcançado por onstop, onerror, o catch E o
    // watchdog. Antes o cleanup vivia só no onstop, então um erro async do
    // recorder vazava AudioContext (browsers limitam a ~6) + blob URL.
    const cleanup = () => {
      cancelAnimationFrame(raf);
      clearTimeout(watchdog);
      try { videoStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
      try { combined?.getTracks().forEach(t => t.stop()); } catch (_) {}
      try { audioSrc?.disconnect(); } catch (_) {}
      try { audioCtx?.close(); } catch (_) {}
      try { video.pause(); } catch (_) {}
      URL.revokeObjectURL(url);
    };
    const done = (out) => { if (settled) return; settled = true; cleanup(); resolve(out); };
    const fail = (err) => { if (settled) return; settled = true; cleanup(); reject(err instanceof Error ? err : new Error(String(err))); };
    try {
      await waitVideoEvent(video, 'loadedmetadata', 'vídeo não carregou');
      const iw = video.videoWidth, ih = video.videoHeight;
      if (!iw || !ih) throw new Error('vídeo sem dimensões');
      const aspect = iw / ih;
      let outW, outH;
      if (iw >= ih) { outH = shortSide; outW = Math.round(shortSide * aspect); }
      else          { outW = shortSide; outH = Math.round(shortSide / aspect); }
      outW -= outW % 2; outH -= outH % 2;
      const canvas = document.createElement('canvas');
      canvas.width = outW; canvas.height = outH;
      const ctx = canvas.getContext('2d');
      videoStream = canvas.captureStream(30);
      // Grafo de áudio: source → destination stream (sem tocar enquanto
      // transcoda). Combinado com o videoStream num único MediaStream.
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioSrc = audioCtx.createMediaElementSource(video);
      const audioDest = audioCtx.createMediaStreamDestination();
      audioSrc.connect(audioDest);
      combined = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioDest.stream.getAudioTracks(),
      ]);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            ? 'video/webm;codecs=vp8,opus' : 'video/webm');
      const recorder = new MediaRecorder(combined, {
        mimeType: mime,
        videoBitsPerSecond: shortSide >= 720 ? 1_600_000 : 700_000,
        audioBitsPerSecond: 128_000,
      });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.onerror = (e) => fail(e.error || new Error('recorder error'));
      recorder.onstop = () => done(new Blob(chunks, { type: 'video/webm' }));
      video.currentTime = startSec;
      await waitVideoEvent(video, 'seeked', 'seek falhou');
      let stopped = false;
      const dur = Math.max(0.001, endSec - startSec);
      recorder.start(250);
      // Watchdog: se o playback nunca avançar (play() rejeitado/travado), o
      // loop de render nunca encerraria — aborta após o tempo real + folga.
      watchdog = setTimeout(() => fail(new Error('transcode timeout')), dur * 1000 + 8000);
      video.play().catch((e) => fail(new Error('play() rejeitado: ' + (e?.message || e))));
      const render = () => {
        if (stopped || settled) return;
        if (video.currentTime >= endSec || video.ended) {
          stopped = true;
          recorder.stop();
          return;
        }
        ctx.drawImage(video, 0, 0, outW, outH);
        if (onProgress) onProgress(Math.min(1, (video.currentTime - startSec) / dur));
        raf = requestAnimationFrame(render);
      };
      raf = requestAnimationFrame(render);
    } catch (e) {
      fail(e);
    }
  });
}

// Um único passe de reprodução alimenta os TRÊS encoders (áudio-only, 720p,
// 360p). O MediaRecorder grava em TEMPO REAL, então os três passes em série
// (extractAudio + 2× transcodeAtShortSide) custavam 3× a duração do recorte
// só de espera depois do "Enviar" — um clipe de 40 s eram 2 min. Aqui: um
// <video>, um grafo de áudio, dois canvases desenhados no MESMO rAF, três
// recorders (a trilha de áudio clonada pra cada um). Se o browser recusar
// três recorders simultâneos, o chamador cai pro caminho sequencial antigo
// (as funções abaixo continuam existindo por isso).
async function transcodeClip(blob, startSec, endSec, { want720 = true, want360 = true, onProgress, signal } = {}) {
  return new Promise(async (resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    video.src = url;
    video.muted = false;
    video.playsInline = true;
    video.preload = 'auto';
    let audioCtx = null, audioSrc = null;
    const streams = [], recorders = [];
    let raf = 0, watchdog = 0, settled = false;
    const cleanup = () => {
      cancelAnimationFrame(raf);
      clearTimeout(watchdog);
      for (const s of streams) { try { s.getTracks().forEach(t => t.stop()); } catch (_) {} }
      try { audioSrc?.disconnect(); } catch (_) {}
      try { audioCtx?.close(); } catch (_) {}
      try { video.pause(); } catch (_) {}
      URL.revokeObjectURL(url);
    };
    // A miniatura sai do MESMO passe (frame ~5% adentro do recorte, ou 0,5 s
    // no máximo) — antes era um segundo decode+seek (videoFirstFrameBlob)
    // em série antes de transcodar.
    let thumbPromise = null, thumbTaken = false;
    const thumbAt = startSec + Math.min(0.5, Math.max(0.001, endSec - startSec) * 0.05);
    const takeThumb = () => {
      if (thumbTaken) return;
      thumbTaken = true;
      try {
        const W = Math.min(320, video.videoWidth || 320);
        const H = Math.round((video.videoHeight || 180) * (W / (video.videoWidth || 320)));
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        c.getContext('2d').drawImage(video, 0, 0, W, H);
        thumbPromise = new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
      } catch (_) { thumbPromise = null; }
    };
    const onAbort = () => fail(abortError());
    const done = (out) => {
      if (settled) return;
      settled = true; cleanup(); signal?.removeEventListener('abort', onAbort);
      Promise.resolve(thumbPromise).then((t) => resolve({ ...out, thumb: t || null }), () => resolve({ ...out, thumb: null }));
    };
    const fail = (err) => { if (settled) return; settled = true; cleanup(); signal?.removeEventListener('abort', onAbort); reject(err instanceof Error ? err : new Error(String(err))); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await waitVideoEvent(video, 'loadedmetadata', 'vídeo não carregou');
      const iw = video.videoWidth, ih = video.videoHeight;
      if ((want720 || want360) && (!iw || !ih)) throw new Error('vídeo sem dimensões');
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioSrc = audioCtx.createMediaElementSource(video);
      const audioDest = audioCtx.createMediaStreamDestination();
      audioSrc.connect(audioDest);
      streams.push(audioDest.stream);
      const audioTrack = audioDest.stream.getAudioTracks()[0];
      const vmime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm');
      const amime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const outs = {};   // key → { rec, chunks, type }
      const mk = (key, stream, opts, type) => {
        const rec = new MediaRecorder(stream, opts);
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
        rec.onerror = (e) => fail(e.error || new Error(`recorder ${key} error`));
        outs[key] = { rec, chunks, type };
        recorders.push(rec);
      };
      mk('audio', audioDest.stream, { mimeType: amime, audioBitsPerSecond: 192_000 }, 'audio/webm');
      const draws = [];
      const aspect = iw / ih;
      for (const [key, shortSide, vbr, want] of [['blob720', 720, 1_600_000, want720], ['blob360', 360, 700_000, want360]]) {
        if (!want) continue;
        let outW, outH;
        if (iw >= ih) { outH = shortSide; outW = Math.round(shortSide * aspect); }
        else          { outW = shortSide; outH = Math.round(shortSide / aspect); }
        outW -= outW % 2; outH -= outH % 2;
        const canvas = document.createElement('canvas');
        canvas.width = outW; canvas.height = outH;
        const ctx = canvas.getContext('2d');
        const vs = canvas.captureStream(30);
        streams.push(vs);
        let atrack = audioTrack;
        try { atrack = audioTrack.clone(); } catch (_) { /* sem clone: compartilha a trilha */ }
        const combined = new MediaStream([...vs.getVideoTracks(), atrack]);
        streams.push(combined);
        mk(key, combined, { mimeType: vmime, videoBitsPerSecond: vbr, audioBitsPerSecond: 128_000 }, 'video/webm');
        draws.push(() => ctx.drawImage(video, 0, 0, outW, outH));
      }
      let pending = recorders.length;
      const results = {};
      for (const [key, o] of Object.entries(outs)) {
        o.rec.onstop = () => {
          results[key] = new Blob(o.chunks, { type: o.type });
          if (--pending === 0) done(results);
        };
      }
      video.currentTime = startSec;
      await waitVideoEvent(video, 'seeked', 'seek falhou');
      let stopped = false;
      const dur = Math.max(0.001, endSec - startSec);
      for (const r of recorders) r.start(250);
      watchdog = setTimeout(() => fail(new Error('transcode timeout')), dur * 1000 + 8000);
      video.play().catch((e) => fail(new Error('play() rejeitado: ' + (e?.message || e))));
      const render = () => {
        if (stopped || settled) return;
        if (video.currentTime >= endSec || video.ended) {
          stopped = true;
          takeThumb();   // recorte curtíssimo: garante a miniatura no último quadro
          for (const r of recorders) { try { r.stop(); } catch (_) {} }
          return;
        }
        for (const d of draws) d();
        if (!thumbTaken && video.currentTime >= thumbAt) takeThumb();
        if (onProgress) onProgress(Math.min(1, (video.currentTime - startSec) / dur));
        raf = requestAnimationFrame(render);
      };
      raf = requestAnimationFrame(render);
    } catch (e) {
      fail(e);
    }
  });
}

// ===================== Vídeo: caminho rápido (WebCodecs) ================
// O MediaRecorder grava em TEMPO REAL: um recorte de 40 s custa 40 s de
// espera por construção, por mais rápido que seja o aparelho. Com WebCodecs
// (VideoDecoder/VideoEncoder/AudioEncoder, nos codecs de hardware) o mesmo
// recorte sai em poucos segundos. Demux/decode/encode/mux ficam com a
// mediabunny (vendorada em lib/mediabunny.min.mjs, MPL-2.0, carregada sob
// demanda). Só entra quando o navegador ENCODA VP9 ou VP8 + opus — é o que o
// WebM (que o catálogo e o mapa esperam) exige; o Safari só encoda H.264 e
// cai pro MediaRecorder. Qualquer falha aqui cai pro passe único acima, e
// dele pro sequencial — a cadeia mora em processClip.
let _mediabunnyPromise = null;
function loadMediabunny() {
  if (!_mediabunnyPromise) _mediabunnyPromise = import('./mediabunny.min.mjs');
  return _mediabunnyPromise;
}
// Debug: `?slow=1` força o caminho MediaRecorder (pra comparar/reproduzir).
const FORCE_SLOW_TRANSCODE = new URLSearchParams(location.search).has('slow');
let _fastProbe = null;
// Resolve o codec de vídeo do caminho rápido ('vp9' | 'vp8') ou false.
function fastTranscodeCodec() {
  if (_fastProbe) return _fastProbe;
  _fastProbe = (async () => {
    if (FORCE_SLOW_TRANSCODE) return false;
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof AudioEncoder === 'undefined') return false;
    const mb = await loadMediabunny();
    const [vp9, vp8, opus] = await Promise.all([
      mb.canEncodeVideo('vp9', { width: 1280, height: 720 }),
      mb.canEncodeVideo('vp8', { width: 1280, height: 720 }),
      mb.canEncodeAudio('opus'),
    ]);
    if (!opus) return false;
    return vp9 ? 'vp9' : (vp8 ? 'vp8' : false);
  })().catch(() => false);
  return _fastProbe;
}
function abortError() { return new DOMException('processamento cancelado', 'AbortError'); }
function isAbortError(e) { return e?.name === 'AbortError'; }
// Dimensões de saída pro lado curto pedido (mesma regra do MediaRecorder:
// mantém a proporção, arredonda pra par).
function outputDims(iw, ih, shortSide) {
  const aspect = iw / ih;
  let w, h;
  if (iw >= ih) { h = shortSide; w = Math.round(shortSide * aspect); }
  else          { w = shortSide; h = Math.round(shortSide / aspect); }
  return { width: w - (w % 2), height: h - (h % 2) };
}
const VIDEO_BITRATE = { 720: 1_600_000, 360: 700_000 };   // iguais aos do MediaRecorder
function canvasToJpeg(canvas) {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  }
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
}
async function transcodeClipFast(file, startSec, endSec, { want720 = true, want360 = true, onProgress, signal } = {}) {
  const vcodec = await fastTranscodeCodec();
  if (!vcodec) throw new Error('WebCodecs indisponível');
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const [vtrack, atrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
  if (!atrack) throw new Error('sem trilha de áudio');   // ph:audio é obrigatório
  const wantVideo = want720 || want360;
  if (wantVideo && !vtrack) throw new Error('sem trilha de vídeo');
  if (!(await atrack.canDecode())) throw new Error(`áudio (${atrack.codec}): decoder indisponível`);
  if (wantVideo && !(await vtrack.canDecode())) throw new Error(`vídeo (${vtrack.codec}): decoder indisponível`);
  const throwIfAborted = () => { if (signal?.aborted) throw abortError(); };
  throwIfAborted();
  const iw = vtrack?.displayWidth || 0, ih = vtrack?.displayHeight || 0;
  const weights = { audio: 0.15, blob720: want720 ? 0.5 : 0, blob360: want360 ? 0.35 : 0 };
  const wsum = Object.values(weights).reduce((a, b) => a + b, 0);
  const prog = {};
  const report = () => {
    if (!onProgress) return;
    let acc = 0;
    for (const [k, f] of Object.entries(prog)) acc += f * weights[k];
    onProgress(Math.min(1, acc / wsum));
  };
  const run = async (key, shortSide) => {
    throwIfAborted();
    const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
    const video = shortSide
      ? { codec: vcodec, ...outputDims(iw, ih, shortSide), fit: 'contain', bitrate: VIDEO_BITRATE[shortSide],
          frameRate: 30, forceTranscode: true }
      : { discard: true };
    const conv = await mb.Conversion.init({
      input, output, trim: { start: startSec, end: endSec }, showWarnings: false, copy: false,
      video,
      audio: { codec: 'opus', bitrate: shortSide ? 128_000 : 192_000, forceTranscode: true },
    });
    if (!conv.isValid) {
      throw new Error(`conversão inválida (${key}): ` + conv.discardedTracks.map((d) => d.reason).join(', '));
    }
    conv.onProgress = (f) => { prog[key] = f; report(); };
    const onAbort = () => { conv.cancel().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await conv.execute();
    } catch (e) {
      if (signal?.aborted || e instanceof mb.ConversionCanceledError) throw abortError();
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    prog[key] = 1; report();
    return new Blob([output.target.buffer], { type: shortSide ? 'video/webm' : 'audio/webm' });
  };
  // Áudio ∥ 720p (o áudio não ocupa decoder de vídeo), depois o 360p: dois
  // decoders de vídeo de hardware simultâneos estouram em celular.
  const [audio, blob720] = await Promise.all([run('audio', 0), want720 ? run('blob720', 720) : null]);
  const blob360 = want360 ? await run('blob360', 360) : null;
  let thumb = null;
  if (vtrack) {
    try {
      const sink = new mb.CanvasSink(vtrack, { width: 320, fit: 'contain' });
      const wc = await sink.getCanvas(startSec + Math.min(0.5, (endSec - startSec) * 0.05));
      if (wc) thumb = await canvasToJpeg(wc.canvas);
    } catch (e) { console.warn('miniatura (WebCodecs) falhou:', e.message); }
  }
  return { audio, blob720, blob360, thumb };
}

async function extractAudio(blob, startSec, endSec, onProgress) {
  return new Promise(async (resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    video.src = url;
    video.muted = false;
    video.playsInline = true;
    video.preload = 'auto';
    let audioCtx = null, audioSrc = null, audioDest = null;
    let raf = 0, watchdog = 0, settled = false;
    const cleanup = () => {
      cancelAnimationFrame(raf);
      clearTimeout(watchdog);
      try { audioDest?.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      try { audioSrc?.disconnect(); } catch (_) {}
      try { audioCtx?.close(); } catch (_) {}
      try { video.pause(); } catch (_) {}
      URL.revokeObjectURL(url);
    };
    const done = (out) => { if (settled) return; settled = true; cleanup(); resolve(out); };
    const fail = (err) => { if (settled) return; settled = true; cleanup(); reject(err instanceof Error ? err : new Error(String(err))); };
    try {
      await waitVideoEvent(video, 'loadedmetadata', 'mídia não carregou');
      // audioCtx hoisted (declarado fora do try) pra que o cleanup feche o
      // contexto mesmo se a falha vier depois da criação dele.
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioSrc = audioCtx.createMediaElementSource(video);
      audioDest = audioCtx.createMediaStreamDestination();
      audioSrc.connect(audioDest);
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(audioDest.stream, {
        mimeType: mime,
        audioBitsPerSecond: 192_000,
      });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.onerror = (e) => fail(e.error || new Error('audio recorder error'));
      recorder.onstop = () => done(new Blob(chunks, { type: 'audio/webm' }));
      video.currentTime = startSec;
      await waitVideoEvent(video, 'seeked', 'seek falhou');
      let stopped = false;
      const dur = Math.max(0.001, endSec - startSec);
      recorder.start(250);
      watchdog = setTimeout(() => fail(new Error('audio extract timeout')), dur * 1000 + 8000);
      video.play().catch((e) => fail(new Error('play() rejeitado: ' + (e?.message || e))));
      const tick = () => {
        if (stopped || settled) return;
        if (video.currentTime >= endSec || video.ended) {
          stopped = true;
          recorder.stop();
          return;
        }
        if (onProgress) onProgress(Math.min(1, (video.currentTime - startSec) / dur));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch (e) {
      fail(e);
    }
  });
}

function makeLimiter(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };
  return async (fn) => {
    if (active < max) active++;
    else await new Promise(res => waiting.push(res));
    try { return await fn(); } finally { release(); }
  };
}

// ===================== Só deste módulo ==================================
// Duração do arquivo (s) pelos metadados — o form completo lê do <video> de
// preview do card; aqui não há card.
export function probeVideoDuration(file) {
  const v = document.createElement('video');
  const url = URL.createObjectURL(file);
  v.preload = 'metadata'; v.muted = true; v.playsInline = true;
  const p = waitVideoEvent(v, 'loadedmetadata', 'vídeo não carregou', 20000)
    .then(() => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0))
    .finally(() => { URL.revokeObjectURL(url); try { v.remove(); } catch (_) {} });
  v.src = url;
  return p;
}
// A cadeia de motores do processClip do form completo, sobre um File em vez de
// um card: WebCodecs → MediaRecorder passe único → sequencial. Devolve
// { audio, blob360, blob720, thumb, engine }.
export async function processClipFile(file, p, { onProgress, signal, onEngine } = {}) {
  const opts = { want720: !p.audioOnly && p.hd, want360: !p.audioOnly, onProgress, signal };
  try {
    onEngine?.('WebCodecs');
    const out = await transcodeClipFast(file, p.tStart, p.tEnd, opts);
    return { ...out, engine: 'WebCodecs' };
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw abortError();
    console.warn('transcode WebCodecs indisponível/falhou — caindo pro MediaRecorder:', e.message);
  }
  try {
    onEngine?.('MediaRecorder');
    const out = await transcodeClip(file, p.tStart, p.tEnd, opts);
    return { ...out, engine: 'MediaRecorder' };
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw abortError();
    console.warn('transcode em passe único falhou — caindo pro sequencial:', e.message);
  }
  onEngine?.('sequencial');
  const thumb = await videoFirstFrameBlob(file).catch(() => null);
  if (signal?.aborted) throw abortError();
  const audio = await extractAudio(file, p.tStart, p.tEnd, onProgress);
  let blob720 = null, blob360 = null;
  if (!p.audioOnly) {
    if (signal?.aborted) throw abortError();
    if (p.hd) blob720 = await transcodeAtShortSide(file, p.tStart, p.tEnd, 720, onProgress);
    if (signal?.aborted) throw abortError();
    blob360 = await transcodeAtShortSide(file, p.tStart, p.tEnd, 360, onProgress);
  }
  return { audio, blob720, blob360, thumb, engine: 'sequencial' };
}

export {
  pad, dateToLocalInput, localToXsdDateTime,
  pHashFromRgba, computePHash, computeVideoPHash, fileFallbackHash,
  drawToCanvas, encodeJpeg, compressToTarget, makeThumbnail, anonymizeJpeg,
  normalizeExifOrientation, copyExifSegment, hammingDistance,
  isHeicFile, isVideoFile,
  tryExtractVideoGps, tryExtractVideoCreationDate, videoFirstFrameBlob,
  waitVideoEvent, primeVideoForFrames, robustVideoSeek,
  transcodeAtShortSide, transcodeClip, loadMediabunny, fastTranscodeCodec,
  abortError, isAbortError, transcodeClipFast, extractAudio, makeLimiter,
};

// convertidor.mjs (resumible con checkpoint y resumen)
// Convierte imágenes de una carpeta a JPG manteniendo estructura de subcarpetas.
// Soporta: png, jpg/jpeg/jfif, webp, avif, heic/heif, tiff, bmp, gif, svg.
//
// ✅ Edita solo esta sección:
const CONFIG = {
  INPUT_DIR:  "./img",   // carpeta de entrada
  OUTPUT_DIR: "./jpgs",  // carpeta de salida

  QUALITY: 82,           // 1..100
  CONCURRENCY: 6,        // archivos en paralelo
  BG: "#FFFFFF",         // fondo para transparencias
  KEEP_EXIF: false,      // conservar EXIF/ICC si existen
  SKIP_JPEG: false,      // si ya es jpg/jpeg/jfif, copiar sin re-encode
  DRY_RUN: false,        // simular sin escribir
  VERBOSE: true,         // logs detallados

  // ⚙️ Resumen y reanudación
  RESUME: true,            // leer/usar estado previo para continuar
  CHECKPOINT_EVERY: 25,    // guarda estado cada N archivos
  SUMMARY_MAX_ERRORS: 200  // límite de errores listados en el resumen
};
// ⬆️ Fin de la sección editable

import { promises as fs } from "fs";
import path from "path";
import { globby } from "globby";     // globby v14+: named import
import sharp from "sharp";
import pLimit from "p-limit";

// Extensiones soportadas
const exts = ["png","jpg","jpeg","jfif","webp","avif","heic","heif","tif","tiff","bmp","gif","svg"];

function clamp(n, min, max){ return Math.min(Math.max(n, min), max); }
function nowIso(){ return new Date().toISOString(); }
function tsFileStamp(){
  const d = new Date();
  const pad = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Normaliza config
const inDir       = CONFIG.INPUT_DIR;
const outDir      = CONFIG.OUTPUT_DIR;
const quality     = clamp(Number(CONFIG.QUALITY) || 82, 1, 100);
const concurrency = Math.max(1, Number(CONFIG.CONCURRENCY) || 6);
const bgColor     = String(CONFIG.BG || "#FFFFFF");
const keepExif    = Boolean(CONFIG.KEEP_EXIF);
const skipJpeg    = Boolean(CONFIG.SKIP_JPEG);
const dryRun      = Boolean(CONFIG.DRY_RUN);
const verbose     = Boolean(CONFIG.VERBOSE);
const resume      = Boolean(CONFIG.RESUME);
const checkpointEvery = Math.max(1, Number(CONFIG.CHECKPOINT_EVERY) || 25);
const summaryMaxErrors = Math.max(1, Number(CONFIG.SUMMARY_MAX_ERRORS) || 200);

const limit = pLimit(concurrency);

// Archivos de estado / logs
const STATE_FILE   = () => path.join(outDir, ".convert-jpg-state.json");
const EVENTS_LOG   = () => path.join(outDir, `.convert-events.jsonl`);
const SUMMARY_FILE = () => path.join(outDir, `convert-summary-${tsFileStamp()}.txt`);

// Estructuras en memoria para estado
let state = {
  version: 1,
  createdAt: null,
  updatedAt: null,
  inDir: null,
  outDir: null,
  processed: {},   // relPath -> { out, action, at }
  failed: {},      // relPath -> { count, lastError, at }
  stats: { ok: 0, fail: 0, copied: 0, converted: 0, dry: 0 }
};

// --- utilidades de fs/paths ---
async function ensureDirFor(filePath){
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}
async function uniquePath(targetPath){
  // evita sobrescribir añadiendo -1, -2, ...
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let i = 1;
  while (true) {
    try { await fs.access(candidate); }
    catch { return candidate; }
    candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    i++;
  }
}
function relToOut(absFile){
  const rel = path.relative(inDir, absFile);
  const parsed = path.parse(rel);
  return { rel, outAbs: path.join(outDir, parsed.dir, parsed.name + ".jpg") };
}
function isImageAbs(abs){
  const ext = path.extname(abs).slice(1).toLowerCase();
  return exts.includes(ext);
}

// --- checkpoint / logs / resumen ---
async function readStateIfAny(){
  try {
    const raw = await fs.readFile(STATE_FILE(), "utf8");
    const data = JSON.parse(raw);
    // Validación mínima: misma in/out
    if (data && data.inDir && data.outDir && data.version === 1) {
      if (data.inDir === inDir && data.outDir === outDir) {
        state = data;
        if (verbose) console.log(`Estado cargado de ${STATE_FILE()}. Procesados previos: ${Object.keys(state.processed).length}`);
      } else if (verbose) {
        console.log("Se encontró estado previo pero con rutas distintas. Se ignorará.");
      }
    }
  } catch { /* no-op */ }
}
async function writeState(){
  try {
    state.updatedAt = nowIso();
    await ensureDirFor(STATE_FILE());
    await fs.writeFile(STATE_FILE(), JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("No se pudo escribir estado:", e.message);
  }
}
async function appendEvent(ev){
  try {
    await ensureDirFor(EVENTS_LOG());
    await fs.appendFile(EVENTS_LOG(), JSON.stringify(ev) + "\n", "utf8");
  } catch { /* no-op */ }
}
async function writeSummary(finalInfo){
  const lines = [];
  const keysProcessed = Object.keys(state.processed);
  const keysFailed = Object.keys(state.failed);

  lines.push(`Resumen conversión a JPG`);
  lines.push(`Fecha: ${nowIso()}`);
  lines.push(`Entrada: ${inDir}`);
  lines.push(`Salida:  ${outDir}`);
  lines.push(`Archivos procesados totales (histórico estado): ${keysProcessed.length}`);
  lines.push(`Éxitos (sesión): ${finalInfo.ok} | Errores (sesión): ${finalInfo.fail}`);
  lines.push(`- Copiados (JPEG saltado): ${finalInfo.copied}`);
  lines.push(`- Convertidos: ${finalInfo.converted}`);
  lines.push(`- Dry-run: ${finalInfo.dry}`);
  lines.push(`Concurrencia: ${concurrency} | Calidad: ${quality} | Fondo alfa: ${bgColor}`);
  if (keepExif) lines.push(`Mantener EXIF: activado`);
  if (skipJpeg) lines.push(`Saltar re-encode de JPEG: activado`);
  if (dryRun)   lines.push(`DRY RUN: activo (no se escribieron archivos)`);

  // errores recientes
  const failedEntries = Object.entries(state.failed);
  if (failedEntries.length) {
    lines.push(`\nÚltimos errores (máx ${summaryMaxErrors}):`);
    let shown = 0;
    for (const [rel, info] of failedEntries) {
      lines.push(`- ${rel} :: ${info.lastError} (reintentos: ${info.count}, último: ${info.at})`);
      if (++shown >= summaryMaxErrors) break;
    }
  }

  lines.push(`\nNota: puedes reanudar corriendo el script de nuevo. Se saltarán los ya procesados.`);

  const summaryPath = SUMMARY_FILE();
  await fs.writeFile(summaryPath, lines.join("\n"), "utf8");
  return summaryPath;
}

// --- conversión / copia ---
async function copyIfSkipJpeg(absFile, outAbs){
  const ext = path.extname(absFile).toLowerCase().replace(".", "");
  if (skipJpeg && ["jpg","jpeg","jfif"].includes(ext)) {
    const finalDest = await uniquePath(outAbs);
    if (!dryRun) {
      await ensureDirFor(finalDest);
      await fs.copyFile(absFile, finalDest);
    }
    return { action: "copied", out: finalDest, format: "jpeg", hasAlpha: false };
  }
  return null;
}
async function convertFile(absFile){
  const { rel, outAbs } = relToOut(absFile);

  // si ya está en el estado como procesado, saltar
  if (resume && state.processed[rel]) {
    if (verbose) console.log(`[skip] ya procesado: ${rel}`);
    return { action: "skipped", out: state.processed[rel].out, format: state.processed[rel].format || "jpeg" };
  }

  const maybeCopy = await copyIfSkipJpeg(absFile, outAbs);
  if (maybeCopy) return { ...maybeCopy, rel };

  const instance = sharp(absFile, { failOn: "none" });
  const meta = await instance.metadata();

  let pipe = instance;
  const withAlphaFormats = ["png","webp","avif","heic","heif","tif","tiff","gif","svg"];
  const needsFlatten = meta.hasAlpha === true || withAlphaFormats.includes((meta.format || "").toLowerCase());
  if (needsFlatten) pipe = pipe.flatten({ background: bgColor });
  if (keepExif) pipe = pipe.withMetadata();
  pipe = pipe.jpeg({ quality, mozjpeg: true, force: true });

  const finalDest = await uniquePath(outAbs);
  if (dryRun) {
    return { action: "dry-run", out: finalDest, hasAlpha: !!meta.hasAlpha, format: meta.format, rel };
  }
  await ensureDirFor(finalDest);
  await pipe.toFile(finalDest);
  return { action: "converted", out: finalDest, hasAlpha: !!meta.hasAlpha, format: meta.format, rel };
}

// --- main ---
(async () => {
  if (!inDir || !outDir) {
    console.error("Error: define INPUT_DIR y OUTPUT_DIR en CONFIG.");
    process.exit(1);
  }
  const inStat = await fs.stat(inDir).catch(() => null);
  if (!inStat || !inStat.isDirectory()) {
    console.error(`Error: carpeta de entrada no existe o no es carpeta: ${inDir}`);
    process.exit(1);
  }

  await fs.mkdir(outDir, { recursive: true });

  // cargar/crear estado
  if (resume) await readStateIfAny();
  if (!state.createdAt) {
    state.createdAt = nowIso();
    state.inDir = inDir;
    state.outDir = outDir;
  }

  // Buscar archivos (recursivo)
  const patterns = exts.map(e => `**/*.${e}`);
  const absFiles = (await globby(patterns, { cwd: inDir, absolute: true, dot: false, followSymbolicLinks: false }))
    .filter(isImageAbs);

  if (absFiles.length === 0) {
    console.log("No se encontraron imágenes para convertir.");
    process.exit(0);
  }

  // Si RESUME, filtramos ya procesados
  const toDo = resume
    ? absFiles.filter(f => !state.processed[path.relative(inDir, f)])
    : absFiles;

  console.log(`Total encontrados: ${absFiles.length} | Pendientes: ${toDo.length}`);
  console.log(`Convirtiendo a JPG... Calidad: ${quality} | Concurrencia: ${concurrency} | Fondo alfa: ${bgColor}`);
  if (keepExif) console.log("Mantener EXIF: activado");
  if (skipJpeg) console.log("Saltar re-encode de JPEG: activado");
  if (dryRun)   console.log("DRY RUN: activo (no se escribirán archivos)");

  // para checkpoint y resumen
  let doneThisRun = 0;
  const sessionStats = { ok: 0, fail: 0, copied: 0, converted: 0, dry: 0 };

  const finalizeAndExit = async (signalName = null) => {
    // Guardar estado y resumen
    await writeState();
    const summaryPath = await writeSummary(sessionStats);
    if (signalName) {
      console.log(`\nInterrumpido con ${signalName}. Resumen en: ${summaryPath}`);
    } else {
      console.log(`\nListo. Resumen en: ${summaryPath}`);
    }
    process.exit(signalName ? 130 : 0); // 130 = SIGINT
  };

  // Manejo de Ctrl+C para reanudar luego
  const onSigInt = async () => {
    console.log("\n↩ Guardando estado para reanudar...");
    await finalizeAndExit("SIGINT");
  };
  process.on("SIGINT", onSigInt);

  // Procesar con límite de concurrencia
  let idx = 0;
  await Promise.all(
    toDo.map(abs => limit(async () => {
      const rel = path.relative(inDir, abs);
      try {
        const res = await convertFile(abs);

        // actualizar estado
        if (res.action === "copied") { sessionStats.ok++; sessionStats.copied++; }
        else if (res.action === "converted") { sessionStats.ok++; sessionStats.converted++; }
        else if (res.action === "dry-run") { sessionStats.ok++; sessionStats.dry++; }
        else if (res.action === "skipped") { /* no suma */ return; }

        state.processed[rel] = {
          out: res.out,
          action: res.action,
          format: res.format || "jpeg",
          at: nowIso()
        };
        delete state.failed[rel]; // limpiar si antes falló

        if (verbose) {
          console.log(`[${res.action}] ${path.relative(process.cwd(), res.out)} ` +
            (res.format ? `(src:${res.format}${res.hasAlpha ? " +alpha" : ""})` : ""));
        }
        await appendEvent({ t: nowIso(), level: "info", rel, action: res.action, out: res.out });

      } catch (err) {
        sessionStats.fail++;
        const prev = state.failed[rel] || { count: 0 };
        state.failed[rel] = { count: prev.count + 1, lastError: String(err.message || err), at: nowIso() };
        console.error(`Error en ${rel}: ${err.message}`);
        if (verbose) console.error(err);
        await appendEvent({ t: nowIso(), level: "error", rel, err: String(err.message || err) });
      } finally {
        doneThisRun++;
        idx++;
        // checkpoint periódico
        if (doneThisRun % checkpointEvery === 0) {
          if (verbose) console.log(`💾 Checkpoint: ${doneThisRun} procesados en esta sesión...`);
          await writeState();
        }
      }
    }))
  );

  // quitar listener para que no atrape el cierre normal
  process.off("SIGINT", onSigInt);

  // estado final + resumen
  await finalizeAndExit(null);
})().catch(async (e) => {
  console.error("Fallo inesperado:", e);
  try { await writeState(); } catch {}
  process.exit(1);
});

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

function normalizePath(value) {
  return decodeURIComponent(String(value).replaceAll("\\", "/").split("?")[0].split("#")[0]);
}

export function fileMapFromList(files) {
  const map = new Map();
  for (const file of files) {
    const rel = normalizePath(file.webkitRelativePath || file.name);
    const parts = rel.split("/").filter(Boolean);
    map.set(rel.toLowerCase(), file);
    map.set(parts[parts.length - 1].toLowerCase(), file);
    for (let i = 1; i < parts.length; i += 1) {
      map.set(parts.slice(i).join("/").toLowerCase(), file);
    }
  }
  return map;
}

export function resolveFile(map, url) {
  const path = normalizePath(url).replace(/^blob:.*\//, "");
  const candidates = [path, path.split("/").pop()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const hit = map.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  const lower = path.toLowerCase();
  for (const [key, file] of map) {
    if (key.endsWith(lower) || lower.endsWith(key)) return file;
  }
  return null;
}

{
  const sample = new File([], "wood.png");
  Object.defineProperty(sample, "webkitRelativePath", { value: "hero/textures/wood.png" });
  const map = fileMapFromList([sample]);
  console.assert(resolveFile(map, "textures/wood.png") === sample, "gltf sidecar path");
  console.assert(resolveFile(map, "wood.png") === sample, "gltf sidecar basename");
}

function blobUrl(cache, file) {
  if (!cache.has(file)) cache.set(file, URL.createObjectURL(file));
  return cache.get(file);
}

function revokeAll(cache) {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}

function pickGltfFile(files) {
  const models = files
    .filter((file) => /\.gltf$/i.test(file.name))
    .sort((a, b) => (a.webkitRelativePath || a.name).split("/").length - (b.webkitRelativePath || b.name).split("/").length);
  return models[0] || null;
}

function loadWithLoader(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

function parseWithLoader(loader, text, path) {
  return new Promise((resolve, reject) => {
    loader.parse(text, path, resolve, reject);
  });
}

export async function filesFromDropEvent(event) {
  const items = [...(event.dataTransfer?.items || [])];
  if (items.some((item) => item.webkitGetAsEntry?.())) {
    const files = [];
    await Promise.all(
      items.map(async (item) => {
        const entry = item.webkitGetAsEntry?.();
        if (entry) await walkEntry(entry, files);
      }),
    );
    if (files.length) return files;
  }
  return [...(event.dataTransfer?.files || [])];
}

async function walkEntry(entry, out, prefix = "") {
  if (!entry) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    Object.defineProperty(file, "webkitRelativePath", { value: prefix + entry.name });
    out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  const next = prefix + entry.name + "/";
  const readBatch = async () => {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return;
    for (const child of batch) await walkEntry(child, out, next);
    await readBatch();
  };
  await readBatch();
}

export async function exportGlb(gltf) {
  const exporter = new GLTFExporter();
  const result = await new Promise((resolve, reject) => {
    exporter.parse(gltf.scene, resolve, reject, {
      binary: true,
      animations: gltf.animations || [],
    });
  });
  return new Blob([result], { type: "model/gltf-binary" });
}

export async function loadModelFromFiles(fileList) {
  const files = [...fileList];
  if (!files.length) throw Object.assign(new Error("gltf.empty"), { i18n: "gltf.empty" });

  const glb = files.find((file) => /\.glb$/i.test(file.name));
  const gltfFile = pickGltfFile(files);

  if (gltfFile) {
    const sidecars = files.filter((file) => file !== gltfFile);
    const hasBin = sidecars.some((file) => /\.bin$/i.test(file.name));
    const map = fileMapFromList(files);
    const cache = new Map();
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      const file = resolveFile(map, url);
      return file ? blobUrl(cache, file) : url;
    });
    const loader = new GLTFLoader(manager);
    const rel = normalizePath(gltfFile.webkitRelativePath || gltfFile.name);
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";

    try {
      const text = await gltfFile.text();
      if (text.trim().startsWith("{") && !hasBin && /"uri"\s*:\s*"[^"]+\.bin"/i.test(text)) {
        throw new Error("missing-bin");
      }
      const gltf = await parseWithLoader(loader, text, dir);
      const blob = await exportGlb(gltf);
      return { gltf, blob, name: gltfFile.name };
    } catch (error) {
      if (error?.message === "missing-bin") {
        throw Object.assign(new Error("gltf.missingBin"), { i18n: "gltf.missingBin" });
      }
      throw Object.assign(new Error("gltf.resources"), { i18n: "gltf.resources" });
    } finally {
      revokeAll(cache);
    }
  }

  if (glb) {
    const cache = new Map();
    const loader = new GLTFLoader();
    try {
      const gltf = await loadWithLoader(loader, blobUrl(cache, glb));
      return { gltf, blob: glb, name: glb.name };
    } finally {
      revokeAll(cache);
    }
  }

  throw Object.assign(new Error("gltf.need"), { i18n: "gltf.need" });
}

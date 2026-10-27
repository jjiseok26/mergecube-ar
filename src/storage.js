const DB_NAME = "mergecube-ar";
const STORE = "project";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveMeta(meta) {
  const db = await openDb();
  await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(meta, "meta"));
  db.close();
}

export async function saveFaceBlob(faceId, blob) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  if (blob) tx.objectStore(STORE).put(blob, `blob:${faceId}`);
  else tx.objectStore(STORE).delete(`blob:${faceId}`);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadLocalProject() {
  const db = await openDb();
  const meta = (await idbReq(db.transaction(STORE, "readonly").objectStore(STORE).get("meta"))) || null;
  const blobs = {};
  if (meta?.faces) {
    for (const id of Object.keys(meta.faces)) {
      const blob = await idbReq(db.transaction(STORE, "readonly").objectStore(STORE).get(`blob:${id}`));
      if (blob) blobs[id] = blob;
    }
  }
  db.close();
  return { meta, blobs };
}

let storageModePromise;

function storageMode() {
  if (!storageModePromise) {
    storageModePromise = fetch("/api/hosts", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { storage: "fs" }))
      .then((data) => data.storage || "fs")
      .catch(() => "fs");
  }
  return storageModePromise;
}

async function uploadBlob(pathname, body) {
  const { upload } = await import("@vercel/blob/client");
  await upload(pathname, body, {
    access: "public",
    handleUploadUrl: "/api/blob",
    multipart: body.size > 4 * 1024 * 1024,
  });
}

export async function publishMeta(meta) {
  if ((await storageMode()) === "blob") {
    await uploadBlob("project/meta.json", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    return;
  }
  const res = await fetch("/api/meta", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  });
  if (!res.ok) throw Object.assign(new Error("save.meta"), { i18n: "save.meta" });
}

export async function publishFace(faceId, blob) {
  if ((await storageMode()) === "blob") {
    if (blob) {
      await uploadBlob(`project/${faceId}.glb`, blob);
      return;
    }
    const res = await fetch(`/api/model?face=${encodeURIComponent(faceId)}`, { method: "DELETE" });
    if (!res.ok) throw Object.assign(new Error("save.model"), { i18n: "save.model" });
    return;
  }
  if (blob) {
    const res = await fetch(`/api/model?face=${encodeURIComponent(faceId)}`, { method: "PUT", body: blob });
    if (!res.ok) throw Object.assign(new Error("save.model"), { i18n: "save.model" });
    return;
  }
  await fetch(`/api/model?face=${encodeURIComponent(faceId)}`, { method: "DELETE" });
}

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { cloneTransform, DEFAULT_TRANSFORM, emptyFaceMeta, FACES } from "./cube.js";
import { filesFromDropEvent, loadModelFromFiles } from "./load-gltf.js";
import { loadLocalProject, publishFace, publishMeta, saveFaceBlob, saveMeta } from "./storage.js";
import { bindQrDialog } from "./share-qr.js";

const canvas = document.querySelector("#view");
const fileInput = document.querySelector("#file");
const folderInput = document.querySelector("#folder");
const fileLabel = document.querySelector("#file-label");
const statusEl = document.querySelector("#status");
const dropzone = document.querySelector("#dropzone");
const showCube = document.querySelector("#show-cube");
const faceGrid = document.querySelector("#face-grid");
const faceHint = document.querySelector("#face-hint");

const sliders = {
  scale: document.querySelector("#scale"),
  px: document.querySelector("#px"),
  py: document.querySelector("#py"),
  pz: document.querySelector("#pz"),
  rx: document.querySelector("#rx"),
  ry: document.querySelector("#ry"),
  rz: document.querySelector("#rz"),
};

const FACE_TEXTURES = [
  "/markers/letterB.png",
  "/markers/letterD.png",
  "/markers/kanji.png",
  "/markers/letterF.png",
  "/markers/letterA.png",
  "/markers/letterC.png",
];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141414);

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 50);
camera.position.set(1.6, 1.2, 2.1);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
keyLight.position.set(2, 3, 4);
scene.add(keyLight);

const cubeGroup = new THREE.Group();
scene.add(cubeGroup);

const textureLoader = new THREE.TextureLoader();
const cubeMaterials = FACE_TEXTURES.map((url) => {
  const map = textureLoader.load(url);
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
});

const cubeMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cubeMaterials);
cubeGroup.add(cubeMesh);
cubeGroup.add(
  new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0xc8f14a }),
  ),
);

const contentRoot = new THREE.Group();
scene.add(contentRoot);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const loader = new GLTFLoader();
const clock = new THREE.Clock();
const slots = {};

let selectedId = FACES[0].id;
let saveTimer = 0;
let dragging = false;

function degToRad(value) {
  return (Number(value) * Math.PI) / 180;
}

function readTransform() {
  return {
    position: [Number(sliders.px.value), Number(sliders.py.value), Number(sliders.pz.value)],
    rotation: [degToRad(sliders.rx.value), degToRad(sliders.ry.value), degToRad(sliders.rz.value)],
    scale: Number(sliders.scale.value),
  };
}

function applyTransform(slot, transform) {
  const next = cloneTransform(transform);
  slot.transform = next;
  slot.userGroup.position.fromArray(next.position);
  slot.userGroup.rotation.set(...next.rotation);
  slot.userGroup.scale.setScalar(next.scale);
}

function writeSliders(transform) {
  const next = cloneTransform(transform);
  sliders.scale.value = String(next.scale);
  sliders.px.value = String(next.position[0]);
  sliders.py.value = String(next.position[1]);
  sliders.pz.value = String(next.position[2]);
  sliders.rx.value = String(Math.round((next.rotation[0] * 180) / Math.PI));
  sliders.ry.value = String(Math.round((next.rotation[1] * 180) / Math.PI));
  sliders.rz.value = String(Math.round((next.rotation[2] * 180) / Math.PI));
  document.querySelector("#scale-out").textContent = next.scale.toFixed(2);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function t(key, vars) {
  return window.I18N.t(key, vars);
}

function faceTitle(face) {
  const mark = face.id === "kanji" ? "人" : face.id.replace("letter", "");
  return `${mark} · ${t("side." + face.side)}`;
}

let said = null;

function say(key, vars, isError = false) {
  said = { key, vars, isError };
  setStatus(t(key, vars), isError);
}

function report(error, fallback) {
  if (error?.i18n) say(error.i18n, null, true);
  else setStatus(error?.message || t(fallback), true);
}

function selectedSlot() {
  return slots[selectedId];
}

function selectedFace() {
  return FACES.find((face) => face.id === selectedId);
}

function clearSlotModel(slot) {
  slot.mixer = null;
  while (slot.fitGroup.children.length) slot.fitGroup.remove(slot.fitGroup.children[0]);
}

function emptySlot(slot) {
  clearSlotModel(slot);
  slot.blob = null;
  slot.name = "";
  applyTransform(slot, DEFAULT_TRANSFORM);
}

function fitSlot(slot) {
  if (!slot.fitGroup.children.length) return;
  const object = slot.fitGroup.children[0];
  slot.fitGroup.scale.set(1, 1, 1);
  object.position.set(0, 0, 0);
  const temp = new THREE.Group();
  temp.add(object);
  temp.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(temp);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z, 0.0001);
  object.position.set(-center.x, -box.min.y, -center.z);
  slot.fitGroup.add(object);
  slot.fitGroup.scale.setScalar(0.72 / longest);
}

function buildMeta() {
  const faces = {};
  for (const face of FACES) {
    const slot = slots[face.id];
    faces[face.id] = {
      name: slot.name,
      transform: cloneTransform(slot.transform),
      hasModel: Boolean(slot.blob),
    };
  }
  return { version: 2, faces, updatedAt: Date.now() };
}

async function persistMetaOnly() {
  const meta = buildMeta();
  await saveMeta(meta);
  try {
    await publishMeta(meta);
  } catch {
    say("status.localOnly");
  }
}

async function persistFace(slot) {
  await saveFaceBlob(slot.id, slot.blob);
  try {
    await publishFace(slot.id, slot.blob);
  } catch {
    say("status.localOnly");
    return;
  }
  await persistMetaOnly();
}

function queueSave() {
  const slot = selectedSlot();
  applyTransform(slot, readTransform());
  document.querySelector("#scale-out").textContent = slot.transform.scale.toFixed(2);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    persistMetaOnly().catch((error) => report(error, "status.localOnly"));
  }, 250);
}

function highlightFace() {
  for (const face of FACES) {
    cubeMaterials[face.materialIndex].opacity = face.id === selectedId ? 0.92 : 0.32;
  }
  for (const button of faceGrid.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.id === selectedId);
    button.classList.toggle("filled", Boolean(slots[button.dataset.id]?.blob));
  }
  const face = selectedFace();
  const slot = selectedSlot();
  faceHint.textContent = slot.blob ? `${faceTitle(face)} · ${slot.name}` : t("status.emptyFace", { face: faceTitle(face) });
  fileLabel.textContent = slot.blob ? slot.name : t("upload.title");
  for (const button of faceGrid.querySelectorAll("button")) {
    const item = FACES.find((face) => face.id === button.dataset.id);
    if (item) button.title = faceTitle(item);
  }
}

function selectFace(id) {
  if (!slots[id]) return;
  selectedId = id;
  writeSliders(slots[id].transform);
  applyTransform(slots[id], slots[id].transform);
  highlightFace();
  const face = selectedFace();
  const slot = slots[id];
  say(slot.blob ? "status.editing" : "status.pick", slot.blob ? { face: faceTitle(face) } : null);
}

function keepMaterialColor(object) {
  object.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      material.side = THREE.DoubleSide;
      if (child.geometry?.getAttribute?.("color")) material.vertexColors = true;
      for (const key of ["map", "emissiveMap"]) {
        const texture = material[key];
        if (texture && "colorSpace" in texture) texture.colorSpace = THREE.SRGBColorSpace;
      }
      material.needsUpdate = true;
    }
  });
}

function makeSlot(face) {
  const faceRoot = new THREE.Group();
  faceRoot.position.set(face.normal[0] * 0.5, face.normal[1] * 0.5, face.normal[2] * 0.5);
  faceRoot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...face.normal));
  const userGroup = new THREE.Group();
  const fitGroup = new THREE.Group();
  userGroup.add(fitGroup);
  faceRoot.add(userGroup);
  contentRoot.add(faceRoot);
  faceRoot.userData.faceId = face.id;
  slots[face.id] = {
    id: face.id,
    faceRoot,
    userGroup,
    fitGroup,
    mixer: null,
    blob: null,
    name: "",
    transform: cloneTransform(),
  };
  applyTransform(slots[face.id], DEFAULT_TRANSFORM);
}

async function useFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const slot = selectedSlot();
  const face = selectedFace();
  say("status.loading", { face: faceTitle(face) });
  try {
    const { gltf, blob, name } = await loadModelFromFiles(files);
    clearSlotModel(slot);
    keepMaterialColor(gltf.scene);
    slot.fitGroup.add(gltf.scene);
    slot.mixer = gltf.animations?.length ? new THREE.AnimationMixer(gltf.scene) : null;
    gltf.animations?.forEach((clip) => slot.mixer?.clipAction(clip).play());
    fitSlot(slot);
    slot.blob = blob;
    slot.name = name;
    highlightFace();
    say("status.loaded", { face: faceTitle(face), name });
    await persistFace(slot);
  } catch (error) {
    report(error, "status.readFail");
    console.error(error);
  }
}

async function loadSlotFromBlob(slot, blob, meta) {
  const url = URL.createObjectURL(blob);
  try {
    const gltf = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    clearSlotModel(slot);
    keepMaterialColor(gltf.scene);
    slot.fitGroup.add(gltf.scene);
    slot.mixer = gltf.animations?.length ? new THREE.AnimationMixer(gltf.scene) : null;
    gltf.animations?.forEach((clip) => slot.mixer?.clipAction(clip).play());
    fitSlot(slot);
    slot.blob = blob;
    slot.name = meta?.name || "model.glb";
    applyTransform(slot, meta?.transform);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function resize() {
  const { clientWidth, clientHeight } = canvas.parentElement;
  const height = Math.max(clientHeight, 320);
  camera.aspect = clientWidth / height;
  camera.updateProjectionMatrix();
  renderer.setSize(clientWidth, height, false);
}

function render() {
  requestAnimationFrame(render);
  const delta = clock.getDelta();
  for (const slot of Object.values(slots)) slot.mixer?.update(delta);
  controls.update();
  renderer.render(scene, camera);
}

function faceIdFromObject(object) {
  let node = object;
  while (node) {
    if (node.userData?.faceId) return node.userData.faceId;
    node = node.parent;
  }
  return null;
}

function pickFace(event) {
  if (dragging) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const cubeHit = raycaster.intersectObject(cubeMesh, false)[0];
  const modelHit = raycaster.intersectObject(contentRoot, true)[0];
  if (modelHit && (!cubeHit || modelHit.distance <= cubeHit.distance)) {
    const faceId = faceIdFromObject(modelHit.object);
    if (faceId) {
      selectFace(faceId);
      return;
    }
  }
  if (!cubeHit) return;
  const materialIndex = cubeHit.face?.materialIndex ?? Math.floor(cubeHit.faceIndex / 2);
  const face = FACES.find((item) => item.materialIndex === materialIndex);
  if (face) selectFace(face.id);
}

async function restore() {
  const local = await loadLocalProject().catch(() => ({ meta: null, blobs: {} }));
  let meta = local.meta;
  const blobs = { ...local.blobs };
  try {
    const metaRes = await fetch("/project/meta.json", { cache: "no-store" });
    if (metaRes.ok) meta = await metaRes.json();
  } catch {
    /* keep IndexedDB meta */
  }

  if (meta && !meta.faces && meta.hasModel) {
    meta = {
      version: 2,
      faces: {
        letterA: { name: meta.name, transform: meta.transform, hasModel: true },
      },
    };
  }

  for (const face of FACES) {
    const faceMeta = meta?.faces?.[face.id] || emptyFaceMeta();
    applyTransform(slots[face.id], faceMeta.transform);
    if (!faceMeta.hasModel) continue;
    let blob = blobs[face.id];
    if (!blob) {
      const res = await fetch(`/project/${face.id}.glb`, { cache: "no-store" });
      if (res.ok) blob = await res.blob();
    }
    if (!blob && face.id === "letterA") {
      const res = await fetch("/project/model.glb", { cache: "no-store" });
      if (res.ok) blob = await res.blob();
    }
    if (blob) await loadSlotFromBlob(slots[face.id], blob, faceMeta);
  }

  const filledFaces = FACES.filter((face) => slots[face.id].blob);
  selectFace(filledFaces[0]?.id || selectedId);
  say(filledFaces.length ? "status.restored" : "status.pick", filledFaces.length ? { count: filledFaces.length } : null);
}

FACES.forEach(makeSlot);

for (const face of FACES) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.id = face.id;
  button.className = "face-btn";
  button.textContent = face.id === "kanji" ? "人" : face.id.replace("letter", "");
  button.title = faceTitle(face);
  button.addEventListener("click", () => selectFace(face.id));
  faceGrid.append(button);
}

selectFace(selectedId);
resize();
render();
restore().catch((error) => {
  console.error(error);
  selectFace(selectedId);
});

window.addEventListener("resize", resize);
canvas.addEventListener("pointerdown", () => {
  dragging = false;
});
canvas.addEventListener("pointermove", (event) => {
  if (event.buttons) dragging = true;
});
canvas.addEventListener("pointerup", pickFace);

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) useFiles(fileInput.files);
  fileInput.value = "";
});

folderInput.addEventListener("change", () => {
  if (folderInput.files?.length) useFiles(folderInput.files);
  folderInput.value = "";
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
});

dropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  const files = await filesFromDropEvent(event);
  if (files.length) useFiles(files);
});

Object.values(sliders).forEach((input) => input.addEventListener("input", queueSave));

document.querySelector("#fit").addEventListener("click", () => {
  fitSlot(selectedSlot());
  persistMetaOnly().catch((error) => report(error, "status.localOnly"));
});

document.querySelector("#reset").addEventListener("click", () => {
  writeSliders(DEFAULT_TRANSFORM);
  applyTransform(selectedSlot(), DEFAULT_TRANSFORM);
  persistMetaOnly().catch((error) => report(error, "status.localOnly"));
});

document.querySelector("#clear-face").addEventListener("click", async () => {
  const slot = selectedSlot();
  emptySlot(slot);
  writeSliders(DEFAULT_TRANSFORM);
  highlightFace();
  say("status.cleared", { face: faceTitle(selectedFace()) });
  await persistFace(slot).catch((error) => report(error, "status.localOnly"));
});

document.querySelector("#clear-all").addEventListener("click", async () => {
  if (!window.confirm(t("confirm.clearAll"))) return;
  for (const face of FACES) {
    emptySlot(slots[face.id]);
    await saveFaceBlob(face.id, null);
    try {
      await publishFace(face.id, null);
    } catch {
      say("status.localOnly");
    }
  }
  writeSliders(DEFAULT_TRANSFORM);
  highlightFace();
  say("status.clearedAll");
  await persistMetaOnly().catch((error) => report(error, "status.localOnly"));
});

showCube.addEventListener("change", () => {
  cubeGroup.visible = showCube.checked;
});

bindQrDialog();
window.addEventListener("langchange", () => {
  highlightFace();
  if (said) setStatus(t(said.key, said.vars), said.isError);
});

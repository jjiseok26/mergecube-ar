(() => {
  const CUBE_SIZE = 1.25;
  const FACES = [
    { id: "letterA", rot: [-Math.PI / 2, 0, 0], normal: [0, 0, 1] },
    { id: "letterB", rot: [0, -Math.PI / 2, Math.PI / 2], normal: [1, 0, 0] },
    { id: "letterC", rot: [Math.PI / 2, 0, Math.PI], normal: [0, 0, -1] },
    { id: "letterD", rot: [-Math.PI / 2, Math.PI / 2, 0], normal: [-1, 0, 0] },
    { id: "letterF", rot: [Math.PI, 0, 0], normal: [0, -1, 0] },
    { id: "kanji", rot: [0, 0, 0], normal: [0, 1, 0] },
  ];

  const statusEl = document.querySelector("#ar-status");
  const startBtn = document.querySelector("#ar-start");

  let renderer;
  let scene;
  let camera;
  let arToolkitSource;
  let arToolkitContext;
  let markerRoots = [];
  let markerGroups = [];
  let contentRoot;
  let mixers = [];
  let clock;
  let running = false;
  let ticking = false;
  let resizeBound = false;
  let viewHandle;
  const view = { scale: 1, rotX: 0, rotY: 0, rotZ: 0, x: 0, y: 0 };

  let statusState = { key: "ar.ready", vars: null };

  function setStatus(key, vars) {
    if (Array.isArray(key)) {
      vars = key[1];
      key = key[0];
    }
    statusState = { key, vars: vars || null };
    statusEl.textContent = window.I18N.t(key, vars);
  }

  function cameraErrorMessage(error) {
    const name = error?.name || "";
    const message = error?.message || "";
    if (!window.isSecureContext || name === "SecurityError") return "ar.https";
    if (/KAKAOTALK|NAVER|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent || "")) return "ar.inapp";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") return "ar.denied";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "ar.missing";
    if (message.includes("WebRTC") || name === "NotSupportedError" || !navigator.mediaDevices?.getUserMedia) return "ar.unsupported";
    return message ? ["ar.failDetail", { message }] : "ar.fail";
  }

  async function openCamera() {
    if (!window.isSecureContext) {
      throw Object.assign(new Error("ar.https"), { i18n: "ar.https" });
    }
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      throw Object.assign(new Error("ar.unsupported"), { i18n: "ar.unsupported" });
    }
    if (!media.enumerateDevices) media.enumerateDevices = async () => [];
    const tries = [
      { audio: false, video: { facingMode: { ideal: "environment" } } },
      { audio: false, video: true },
    ];
    let lastError;
    for (const constraints of tries) {
      try {
        return await media.getUserMedia(constraints);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function waitForVideo(video) {
    if (video.videoWidth) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("ar.noVideo"), { i18n: "ar.noVideo" })), 12000);
      video.addEventListener(
        "loadedmetadata",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  async function playVideo(video) {
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    try {
      await video.play();
    } catch {
      setStatus("ar.tap");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error("ar.noPlay"), { i18n: "ar.noPlay" })), 20000);
        const resume = () => {
          video
            .play()
            .then(() => {
              clearTimeout(timer);
              resolve();
            })
            .catch(reject);
        };
        window.addEventListener("touchend", resume, { once: true });
        window.addEventListener("click", resume, { once: true });
      });
    }
  }

  function applyTransform(object, transform) {
    const t = transform || { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
    object.position.fromArray(t.position);
    object.rotation.set(t.rotation[0], t.rotation[1], t.rotation[2]);
    object.scale.setScalar(t.scale);
  }

  function fitModel(fitGroup, object) {
    fitGroup.scale.set(1, 1, 1);
    object.position.set(0, 0, 0);
    const temp = new THREE.Group();
    temp.add(object);
    temp.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(temp);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z, 0.0001);
    object.position.set(-center.x, -box.min.y, -center.z);
    fitGroup.add(object);
    fitGroup.scale.setScalar(0.72 / longest);
  }

  async function loadProject() {
    let meta = null;
    try {
      const metaRes = await fetch("/project/meta.json", { cache: "no-store" });
      if (metaRes.ok) meta = await metaRes.json();
    } catch (_) {
      /* IndexedDB fallback */
    }

    if (meta && !meta.faces && meta.hasModel) {
      meta = {
        version: 2,
        faces: { letterA: { name: meta.name, transform: meta.transform, hasModel: true } },
      };
    }

    if (meta) return meta;

    return new Promise((resolve) => {
      const request = indexedDB.open("mergecube-ar", 2);
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("project")) {
          resolve(null);
          return;
        }
        const tx = db.transaction("project", "readonly");
        const get = tx.objectStore("project").get("meta");
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      };
    });
  }

  function loadGltfFromBlob(blob) {
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      new THREE.GLTFLoader().load(
        url,
        (gltf) => {
          URL.revokeObjectURL(url);
          resolve(gltf);
        },
        undefined,
        (error) => {
          URL.revokeObjectURL(url);
          reject(error);
        },
      );
    });
  }

  async function blobForFace(faceId, meta) {
    const urls = [`/project/${faceId}.glb`];
    if (faceId === "letterA") urls.push("/project/model.glb");
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) return res.blob();
      } catch (_) {
        /* try next */
      }
    }

    return new Promise((resolve) => {
      const request = indexedDB.open("mergecube-ar", 2);
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("project")) {
          resolve(null);
          return;
        }
        const get = db.transaction("project", "readonly").objectStore("project").get(`blob:${faceId}`);
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      };
    });
  }

  function makeDemoModel() {
    return new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), new THREE.MeshNormalMaterial());
  }

  function keepMaterialColor(object) {
    object.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material) continue;
        material.side = THREE.DoubleSide;
        if (child.geometry?.getAttribute?.("color")) material.vertexColors = true;
        material.needsUpdate = true;
      }
    });
  }

  function addFaceContent(face, transform, object, animations) {
    const faceRoot = new THREE.Group();
    faceRoot.position.set(face.normal[0] * 0.5, face.normal[1] * 0.5, face.normal[2] * 0.5);
    faceRoot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...face.normal));
    const userGroup = new THREE.Group();
    const fitGroup = new THREE.Group();
    userGroup.add(fitGroup);
    faceRoot.add(userGroup);
    keepMaterialColor(object);
    viewHandle.add(faceRoot);
    applyTransform(userGroup, transform);
    fitGroup.add(object);
    fitModel(fitGroup, object);
    if (animations?.length) {
      const mixer = new THREE.AnimationMixer(object);
      animations.forEach((clip) => mixer.clipAction(clip).play());
      mixers.push(mixer);
    }
  }

  async function buildContent() {
    if (contentRoot?.parent) contentRoot.parent.remove(contentRoot);
    contentRoot = new THREE.Group();
    contentRoot.scale.setScalar(CUBE_SIZE);
    viewHandle = new THREE.Group();
    contentRoot.add(viewHandle);
    applyViewHandle();
    mixers = [];

    const meta = await loadProject();
    let loaded = 0;
    let failed = 0;

    for (const face of FACES) {
      const faceMeta = meta?.faces?.[face.id];
      if (!faceMeta?.hasModel) continue;
      const blob = await blobForFace(face.id, faceMeta);
      if (!blob) {
        failed += 1;
        continue;
      }
      try {
        const gltf = await loadGltfFromBlob(blob);
        addFaceContent(face, faceMeta.transform, gltf.scene, gltf.animations);
        loaded += 1;
      } catch (error) {
        failed += 1;
        console.error(error);
      }
    }

    if (!loaded && !failed) {
      addFaceContent(FACES[0], { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, makeDemoModel(), []);
      setStatus("ar.demo");
    } else if (!loaded) {
      setStatus("ar.loadFail", { failed });
    } else if (failed) {
      setStatus("ar.partial", { count: loaded, failed });
    } else {
      setStatus("ar.tracking", { count: loaded });
    }

    viewHandle.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
        new THREE.LineBasicMaterial({ color: 0xc8f14a }),
      ),
    );
  }

  function onResize() {
    if (!arToolkitSource) return;
    arToolkitSource.onResizeElement();
    arToolkitSource.copyElementSizeTo(renderer.domElement);
    if (arToolkitContext && arToolkitContext.arController !== null) {
      arToolkitSource.copyElementSizeTo(arToolkitContext.arController.canvas);
    }
    liftRenderer();
  }

  function liftRenderer() {
    if (!renderer) return;
    renderer.domElement.style.zIndex = "2";
    const video = arToolkitSource?.domElement;
    if (video) video.style.pointerEvents = "none";
    const detect = arToolkitContext?.arController?.canvas;
    if (detect && detect !== renderer.domElement) {
      detect.style.pointerEvents = "none";
      detect.style.zIndex = "0";
    }
  }

  function initScene() {
    scene = new THREE.Scene();
    camera = new THREE.Camera();
    scene.add(camera);
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const light = new THREE.DirectionalLight(0xffffff, 0.8);
    light.position.set(1, 2, 1);
    scene.add(light);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(new THREE.Color("black"), 0);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.zIndex = "2";
    document.body.appendChild(renderer.domElement);
    if (THREE.RoomEnvironment && THREE.PMREMGenerator) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    bindViewGestures(renderer.domElement);
  }

  function applyViewHandle() {
    if (!viewHandle) return;
    viewHandle.position.set(view.x, view.y, 0);
    viewHandle.scale.setScalar(view.scale);
    viewHandle.rotation.set(view.rotX, view.rotY, view.rotZ);
  }

  function stepView(state, key, amount) {
    const next = { scale: state.scale, rotX: state.rotX, rotY: state.rotY, rotZ: state.rotZ, x: state.x, y: state.y };
    if (key === "scale") next.scale = Math.min(4, Math.max(0.25, state.scale * amount));
    else if (key === "x" || key === "y") next[key] = Math.min(1.2, Math.max(-1.2, state[key] + amount));
    else if (key === "rotX" || key === "rotY" || key === "rotZ") next[key] = state[key] + amount;
    return next;
  }

  function nudge(key, amount) {
    Object.assign(view, stepView(view, key, amount));
    applyViewHandle();
  }

  function resetView() {
    view.scale = 1;
    view.rotX = 0;
    view.rotY = 0;
    view.rotZ = 0;
    view.x = 0;
    view.y = 0;
    applyViewHandle();
  }

  function bindHold(button, fn) {
    let timer = 0;
    const stop = () => {
      window.clearInterval(timer);
      timer = 0;
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      try {
        button.setPointerCapture(event.pointerId);
      } catch (_) {
        /* some browsers reject capture on a disappearing button */
      }
      fn();
      stop();
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      timer = window.setInterval(fn, 120);
    });
  }

  function bindViewControls() {
    document.querySelectorAll("#ar-controls [data-view]").forEach((button) => {
      bindHold(button, () => nudge(button.dataset.view, Number(button.dataset.step)));
    });
    document.querySelector("#ar-reset").addEventListener("click", resetView);
  }

  function bindViewGestures(el) {
    const pointers = new Map();
    let pinchStartDist = 1;
    let pinchStartScale = 1;
    let twistStart = 0;
    let twistStartRotZ = 0;
    let lastX = 0;
    let lastY = 0;

    function pointList() {
      return [...pointers.values()];
    }

    function span(a, b) {
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    function yaw(a, b) {
      return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
    }

    el.addEventListener("pointerdown", (event) => {
      el.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, event);
      lastX = event.clientX;
      lastY = event.clientY;
      if (pointers.size === 2) {
        const [a, b] = pointList();
        pinchStartDist = span(a, b) || 1;
        pinchStartScale = view.scale;
        twistStart = yaw(a, b);
        twistStartRotZ = view.rotZ;
      }
    });

    el.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, event);
      if (pointers.size >= 2) {
        const [a, b] = pointList();
        view.scale = Math.min(4, Math.max(0.25, pinchStartScale * (span(a, b) / pinchStartDist)));
        view.rotZ = twistStartRotZ + (yaw(a, b) - twistStart);
      } else {
        view.rotY += (event.clientX - lastX) * 0.01;
        view.rotX += (event.clientY - lastY) * 0.01;
        lastX = event.clientX;
        lastY = event.clientY;
      }
      applyViewHandle();
    });

    function clearPointer(event) {
      pointers.delete(event.pointerId);
      if (pointers.size === 1) {
        const leftover = pointList()[0];
        lastX = leftover.clientX;
        lastY = leftover.clientY;
      }
    }

    el.addEventListener("pointerup", clearPointer);
    el.addEventListener("pointercancel", clearPointer);
    el.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        view.scale = Math.min(4, Math.max(0.25, view.scale * (event.deltaY > 0 ? 0.92 : 1.08)));
        applyViewHandle();
      },
      { passive: false },
    );
  }

  function initMarkers() {
    markerRoots.forEach((root) => scene.remove(root));
    markerRoots = [];
    markerGroups = [];

    FACES.forEach((face) => {
      const markerRoot = new THREE.Group();
      scene.add(markerRoot);
      new THREEx.ArMarkerControls(arToolkitContext, markerRoot, {
        type: "pattern",
        patternUrl: `/data/${face.id}.patt`,
      });

      const markerGroup = new THREE.Group();
      markerGroup.position.y = -CUBE_SIZE / 2;
      markerGroup.rotation.set(face.rot[0], face.rot[1], face.rot[2]);
      markerRoot.add(markerGroup);

      markerRoots.push(markerRoot);
      markerGroups.push(markerGroup);
    });
  }

  function initAR(stream) {
    return new Promise((resolve, reject) => {
      if (arToolkitSource?.domElement) {
        const oldVideo = arToolkitSource.domElement;
        oldVideo.srcObject?.getTracks?.().forEach((track) => track.stop());
        oldVideo.remove();
        arToolkitSource = null;
        arToolkitContext = null;
      }
      const media = navigator.mediaDevices;
      const originalGetUserMedia = media.getUserMedia.bind(media);
      media.getUserMedia = () => Promise.resolve(stream);

      arToolkitSource = new THREEx.ArToolkitSource({
        sourceType: "webcam",
      });

      let settled = false;
      const restore = () => {
        media.getUserMedia = originalGetUserMedia;
      };
      const fail = (error) => {
        restore();
        if (settled) return;
        settled = true;
        startBtn.hidden = false;
        setStatus(cameraErrorMessage(error));
        reject(error);
      };

      const source = arToolkitSource.init(() => {
        restore();
        const video = arToolkitSource.domElement;
        playVideo(video)
          .then(() => waitForVideo(video))
          .then(() => {
            onResize();
            arToolkitContext = new THREEx.ArToolkitContext({
              cameraParametersUrl: "/data/camera_para.dat",
              detectionMode: "mono",
              maxDetectionRate: 30,
            });
            arToolkitContext.init(() => {
              camera.projectionMatrix.copy(arToolkitContext.getProjectionMatrix());
              initMarkers();
              onResize();
              setStatus("ar.point");
              if (settled) return;
              settled = true;
              resolve();
            });
          })
          .catch(fail);
      }, fail);

      if (!source) fail({ name: "NotSupportedError", message: "WebRTC issue" });
      if (!resizeBound) {
        resizeBound = true;
        window.addEventListener("resize", onResize);
      }
    });
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!clock) clock = new THREE.Clock();
    const delta = clock.getDelta();
    mixers.forEach((mixer) => mixer.update(delta));

    if (contentRoot && arToolkitSource && arToolkitSource.ready && arToolkitContext) {
      arToolkitContext.update(arToolkitSource.domElement);
      for (let i = 0; i < markerRoots.length; i += 1) {
        if (markerRoots[i].visible) {
          markerGroups[i].add(contentRoot);
          break;
        }
      }
    }

    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  async function start() {
    if (running) return;
    running = true;
    startBtn.hidden = true;
    setStatus("ar.preparing");
    try {
      const stream = await openCamera();
      if (!renderer) initScene();
      await initAR(stream);
      if (!ticking) {
        ticking = true;
        tick();
      }
      await buildContent();
    } catch (error) {
      running = false;
      throw error;
    }
  }

  startBtn.addEventListener("click", () => {
    start().catch((error) => {
      console.error(error);
      startBtn.hidden = false;
      setStatus(error?.i18n || cameraErrorMessage(error));
    });
  });

  setStatus("ar.ready");
  if (!window.isSecureContext) setStatus("ar.https");
  else if (/KAKAOTALK|NAVER|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent || "")) setStatus("ar.inapp");
  window.addEventListener("langchange", () => {
    if (statusState) statusEl.textContent = window.I18N.t(statusState.key, statusState.vars);
  });
  bindViewControls();

  const stepCheck = stepView({ scale: 1, rotX: 0, rotY: 0, rotZ: 0, x: 0, y: 0 }, "scale", 10);
  const shiftCheck = stepView({ scale: 1, rotX: 0, rotY: 0, rotZ: 0, x: 0, y: 0 }, "x", -5);
  const turnCheck = stepView({ scale: 1, rotX: 0, rotY: 0, rotZ: 0, x: 0, y: 0 }, "rotY", -0.4);
  if (stepCheck.scale !== 4 || shiftCheck.x !== -1.2 || turnCheck.rotY !== -0.4) {
    console.error("stepView check failed", stepCheck, shiftCheck, turnCheck);
  }
})();

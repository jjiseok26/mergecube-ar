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
  let viewHandle;
  const view = { scale: 1, rotX: 0, rotY: 0, rotZ: 0 };

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function cameraErrorMessage(error) {
    const name = error?.name || "";
    const message = error?.message || "";
    if (!window.isSecureContext) {
      return "태블릿 카메라는 HTTPS가 필요합니다. PC에서 서버를 재시작한 뒤 태블릿 QR을 다시 만들어 주세요.";
    }
    if (/KAKAOTALK|NAVER|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent || "")) {
      return "앱 속 브라우저에서는 카메라가 막힙니다. 오른쪽 아래 Safari 또는 Chrome으로 열기를 누르세요.";
    }
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "카메라 권한이 거부되었습니다. 주소창 옆 사이트 설정에서 카메라를 허용하세요.";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "이 기기에서 쓸 수 있는 카메라를 찾지 못했습니다.";
    }
    if (message.includes("WebRTC") || !navigator.mediaDevices?.getUserMedia) {
      return "이 브라우저에서는 카메라를 쓸 수 없습니다. Safari 또는 Chrome으로 열어 주세요.";
    }
    return message ? `카메라를 시작할 수 없습니다: ${message}` : "카메라를 시작할 수 없습니다.";
  }

  async function openCamera() {
    if (!window.isSecureContext) {
      throw new Error(cameraErrorMessage({ name: "SecurityError" }));
    }
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      throw new Error(cameraErrorMessage({ name: "NotSupportedError" }));
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
      const timer = setTimeout(() => reject(new Error("카메라 영상이 시작되지 않았습니다.")), 12000);
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
      setStatus("화면을 한 번 탭하면 카메라가 켜집니다.");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("카메라를 재생할 수 없습니다. 화면을 탭해 주세요.")), 20000);
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

  function visibleMaterial(material, mesh) {
    if (!material) return material;
    const color = material.color?.clone?.() || new THREE.Color(0xffffff);
    const emissive = material.emissive;
    if (emissive && color.r + color.g + color.b < 0.04 && emissive.r + emissive.g + emissive.b > 0.04) color.copy(emissive);
    return new THREE.MeshBasicMaterial({
      color,
      map: material.map || material.emissiveMap || null,
      transparent: Boolean(material.transparent),
      opacity: material.opacity ?? 1,
      alphaTest: material.alphaTest || 0,
      side: THREE.DoubleSide,
      vertexColors: Boolean(mesh.geometry?.getAttribute?.("color")),
    });
  }

  function keepMaterialColor(object) {
    object.traverse((child) => {
      if (!child.isMesh) return;
      const sources = Array.isArray(child.material) ? child.material : [child.material];
      const next = sources.map((material) => visibleMaterial(material, child));
      child.material = Array.isArray(child.material) ? next : next[0];
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
    contentRoot = new THREE.Group();
    contentRoot.scale.setScalar(CUBE_SIZE);
    viewHandle = new THREE.Group();
    contentRoot.add(viewHandle);
    applyViewHandle();
    mixers = [];

    const meta = await loadProject();
    let loaded = 0;

    for (const face of FACES) {
      const faceMeta = meta?.faces?.[face.id];
      if (!faceMeta?.hasModel) continue;
      const blob = await blobForFace(face.id, faceMeta);
      if (!blob) continue;
      try {
        const gltf = await loadGltfFromBlob(blob);
        addFaceContent(face, faceMeta.transform, gltf.scene, gltf.animations);
        loaded += 1;
      } catch (error) {
        console.error(error);
      }
    }

    if (!loaded) {
      addFaceContent(FACES[0], { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, makeDemoModel(), []);
      setStatus("올린 모델이 없어 기본 도형을 표시합니다. 한 손가락으로 회전, 두 손가락으로 확대하세요.");
    } else {
      setStatus(`추적 중: ${loaded}개 면 · 한 손가락 회전, 두 손가락 확대`);
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.touchAction = "none";
    document.body.appendChild(renderer.domElement);
    bindViewGestures(renderer.domElement);
  }

  function applyViewHandle() {
    if (!viewHandle) return;
    viewHandle.scale.setScalar(view.scale);
    viewHandle.rotation.set(view.rotX, view.rotY, view.rotZ);
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
              if (settled) return;
              settled = true;
              resolve();
            });
          })
          .catch(fail);
      }, fail);

      if (!source) fail({ name: "NotSupportedError", message: "WebRTC issue" });
      window.addEventListener("resize", onResize);
    });
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!clock) clock = new THREE.Clock();
    const delta = clock.getDelta();
    mixers.forEach((mixer) => mixer.update(delta));

    if (arToolkitSource && arToolkitSource.ready && arToolkitContext) {
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
    setStatus("카메라를 준비하는 중...");
    try {
      const stream = await openCamera();
      if (!renderer) initScene();
      await initAR(stream);
      tick();
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
      setStatus(error?.message || cameraErrorMessage(error));
    });
  });

  if (!window.isSecureContext) {
    setStatus("태블릿에서는 HTTPS 주소의 QR이 필요합니다. PC에서 태블릿 QR을 다시 만들어 주세요.");
  } else if (/KAKAOTALK|NAVER|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent || "")) {
    setStatus("앱 속 브라우저입니다. Safari 또는 Chrome으로 열어 카메라를 켜세요.");
  }
})();

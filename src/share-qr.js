const PAGES = [
  { path: "/ar.html", label: "AR 보기" },
  { path: "/", label: "스튜디오" },
  { path: "/print.html", label: "큐브 인쇄" },
];

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

async function lanOrigins() {
  const origins = [];
  if (!isLoopback(location.hostname)) origins.push(location.origin);
  try {
    const res = await fetch("/api/hosts", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      for (const origin of data.hosts || []) {
        if (!origins.includes(origin)) origins.push(origin);
      }
    }
  } catch {
    /* keep whatever we have */
  }
  if (!origins.length) origins.push(location.origin);
  return origins;
}

function qrSrc(url) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=10&data=${encodeURIComponent(url)}`;
}

export function bindQrDialog() {
  const dialog = document.querySelector("#qr-dialog");
  const openBtn = document.querySelector("#qr-open");
  if (!dialog || !openBtn) return;

  const img = dialog.querySelector("#qr-image");
  const link = dialog.querySelector("#qr-url");
  const note = dialog.querySelector("#qr-note");
  const originSelect = dialog.querySelector("#qr-origin");
  const pageSelect = dialog.querySelector("#qr-page");
  const copyBtn = dialog.querySelector("#qr-copy");

  function currentUrl() {
    const origin = originSelect.value || location.origin;
    return origin.replace(/\/$/, "") + pageSelect.value;
  }

  function render() {
    const url = currentUrl();
    img.src = qrSrc(url);
    img.alt = `${url} QR 코드`;
    link.textContent = url;
    link.href = url;
    const loopback = isLoopback(new URL(url).hostname);
    const https = url.startsWith("https:");
    if (loopback) {
      note.textContent = "localhost 주소는 태블릿에서 열리지 않습니다. 아래 네트워크 주소를 선택하세요.";
    } else if (!https) {
      note.textContent = "HTTP 주소는 태블릿 카메라가 막힙니다. HTTPS 주소의 QR을 사용하세요.";
    } else {
      note.textContent =
        "같은 Wi‑Fi에서 Safari 또는 Chrome으로 여세요. 보안 경고가 나오면 '고급 → 계속' 또는 '방문'을 누르세요. 카메라 앱 미리보기 창이 아니라 브라우저에서 열어야 합니다.";
    }
  }

  openBtn.addEventListener("click", async () => {
    pageSelect.innerHTML = PAGES.map((page) => `<option value="${page.path}">${page.label}</option>`).join("");
    const origins = await lanOrigins();
    originSelect.innerHTML = origins.map((origin) => `<option value="${origin}">${origin.replace(/^https?:\/\//, "")}</option>`).join("");
    const preferred = origins.find((origin) => !isLoopback(new URL(origin).hostname)) || origins[0];
    originSelect.value = preferred;
    pageSelect.value = "/ar.html";
    render();
    dialog.showModal();
  });

  originSelect.addEventListener("change", render);
  pageSelect.addEventListener("change", render);
  copyBtn.addEventListener("click", async () => {
    const url = currentUrl();
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = "복사됨";
      setTimeout(() => {
        copyBtn.textContent = "주소 복사";
      }, 1200);
    } catch {
      window.prompt("주소를 복사하세요", url);
    }
  });
  dialog.querySelector("#qr-close").addEventListener("click", () => dialog.close());
}

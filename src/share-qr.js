const PAGES = [
  { path: "/ar.html", label: "nav.ar" },
  { path: "/", label: "nav.studio" },
  { path: "/print.html", label: "nav.print" },
  { path: "/help.html", label: "nav.help" },
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

  function fillPages() {
    const selected = pageSelect.value;
    pageSelect.innerHTML = PAGES.map((page) => `<option value="${page.path}">${window.I18N.t(page.label)}</option>`).join("");
    if (selected) pageSelect.value = selected;
  }

  function render() {
    const url = currentUrl();
    img.src = qrSrc(url);
    img.alt = window.I18N.t("qr.alt", { url });
    link.textContent = url;
    link.href = url;
    const loopback = isLoopback(new URL(url).hostname);
    const https = url.startsWith("https:");
    if (loopback) note.textContent = window.I18N.t("qr.loopback");
    else if (!https) note.textContent = window.I18N.t("qr.http");
    else note.textContent = window.I18N.t("qr.https");
  }

  openBtn.addEventListener("click", async () => {
    fillPages();
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
      copyBtn.textContent = window.I18N.t("qr.copied");
      setTimeout(() => {
        copyBtn.textContent = window.I18N.t("qr.copy");
      }, 1200);
    } catch {
      window.prompt(window.I18N.t("qr.prompt"), url);
    }
  });
  dialog.querySelector("#qr-close").addEventListener("click", () => dialog.close());
  window.addEventListener("langchange", () => {
    if (!dialog.open) return;
    fillPages();
    render();
  });
}

(async function () {
  "use strict";
  const channel = location.hash.slice(1);
  if (parent === window || !/^[0-9a-f-]{36}$/.test(channel)) return;
  const authorization = await chrome.runtime.sendMessage({
    type: "PANEL_AUTHORIZE",
    channel,
  }).catch(() => null);
  if (!authorization?.ok) return;

  const host = document.createElement("div");
  const surface = host.attachShadow({ mode: "closed" });
  const style = new CSSStyleSheet();
  style.replaceSync(PageReviewStyles);
  surface.adoptedStyleSheets = [style];
  document.body.append(host);

  let port, revision, context, composer, watch;
  const post = (kind, data = {}) => port.postMessage({ kind, revision, ...data });
  const panel = () => surface.querySelector(".panel");
  function layout() {
    const element = panel();
    if (!element || !context) return;
    const { width, height } = element.getBoundingClientRect();
    const { anchor, dock, recording } = context;
    let position;
    if (element.classList.contains("recording-control") && recording)
      position = PageReviewMedia.controls(recording.rect, recording.viewport, { width, height });
    else if (element.classList.contains("media-view"))
      position = { left: Math.max(12, (innerWidth - width) / 2), top: Math.max(12, (innerHeight - height) / 2) };
    else if (element.classList.contains("popover")) {
      const visible = anchor && anchor.top + anchor.height > 0 && anchor.top < innerHeight;
      position = PageReviewCore.placePopover(
        visible ? anchor : null, { width: innerWidth, height: innerHeight }, { width, height },
      );
    } else if (!element.classList.contains("drawer")) {
      position = {
        left: Math.max(12, Math.min(dock.side === "left" ? dock.x + 56 : dock.x - width - 12, innerWidth - width - 12)),
        top: Math.max(12, Math.min(dock.y + 44 - height, innerHeight - height - 12)),
      };
    }
    if (position) Object.assign(element.style, { left: position.left + "px", top: position.top + "px" });
    const bounds = surface.querySelector(".drawer-backdrop") || element;
    const { left, top, right, bottom } = bounds.getBoundingClientRect();
    post("bounds", { left, top, right, bottom });
  }

  function updateComposer() {
    const input = surface.getElementById("review-comment");
    if (!input || !composer) return;
    input.style.height = "auto";
    input.style.height = Math.max(26, Math.min(144, input.scrollHeight)) + "px";
    surface.querySelectorAll("[data-feedback]").forEach((button) => {
      const selected = button.dataset.feedback === composer.feedback;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    surface.querySelector(".composer-submit").disabled =
      !composer.canSave || !(input.value.trim() || composer.feedback);
  }

  function receive(event) {
    const data = event.data;
    if (data?.kind === "render") {
      revision = data.revision;
      context = data.context;
      composer = data.composer;
      watch?.disconnect();
      surface.innerHTML = data.html;
      updateComposer();
      const element = panel();
      if (element) {
        watch = new ResizeObserver(layout);
        watch.observe(element);
        element.addEventListener("animationend", layout, { once: true });
        layout();
      }
      const input = surface.getElementById("review-comment");
      if (data.focus && input) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }
      const manual = surface.getElementById("manual-copy");
      if (manual) {
        manual.focus({ preventScroll: true });
        manual.select();
      }
    } else if (data?.revision === revision) {
      if (data.kind === "position") { context = data.context; layout(); }
      if (data.kind === "composer") { composer = data.composer; updateComposer(); }
    }
  }

  function initialize(event) {
    if (!event.isTrusted || event.source !== parent || event.data?.type !== "PAGE_REVIEW_PANEL_INIT" ||
        event.data.channel !== channel || event.ports.length !== 1) return;
    removeEventListener("message", initialize);
    port = event.ports[0];
    port.onmessage = receive;
    post("ready");
  }

  function comment() { return surface.getElementById("review-comment")?.value; }

  surface.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!event.isTrusted || !button || button.disabled) return;
    event.preventDefault();
    if (button.dataset.action === "seek-frame") {
      const video = surface.querySelector("video");
      const time = Number(button.dataset.at);
      if (video && Number.isFinite(time) && time >= 0) {
        video.currentTime = time;
        video.play().catch(() => {});
      }
      return;
    }
    post("action", { dataset: { ...button.dataset }, comment: comment() });
  });
  surface.addEventListener("input", (event) => {
    if (!event.isTrusted || event.target.id !== "review-comment") return;
    updateComposer();
    layout();
    post("input", { comment: comment() });
  });
  addEventListener("keydown", (event) => {
    if (!port || !event.isTrusted || !(event.key === "Escape" ||
        (event.key === "Enter" && (event.metaKey || event.ctrlKey)))) return;
    event.preventDefault();
    post("key", {
      key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey, comment: comment(),
    });
  });
  addEventListener("message", initialize);
  parent.postMessage({ type: "PAGE_REVIEW_PANEL_READY" }, "*");
})();

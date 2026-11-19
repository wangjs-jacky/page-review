(function (root) {
  "use strict";
  root.PageReviewPrivatePanel = function ({ container, send, onEvent, onError }) {
    const url = new URL(chrome.runtime.getURL("panel.html"));
    const origin = url.protocol + "//" + url.host;
    let frame, port, channel, timer, revision = 0, model, loaded, connecting;
    const listener = new AbortController();

    function reset() {
      clearTimeout(timer);
      port?.close();
      frame?.remove();
      port = frame = channel = null;
      loaded = false;
    }

    function fail(error) {
      reset();
      if (model?.html) onError(error);
    }

    function receive(event) {
      const data = event.data;
      if (data?.kind === "ready") {
        loaded = true;
        clearTimeout(timer);
        if (model) port.postMessage(model);
        return;
      }
      if (!loaded || data?.revision !== revision) return;
      if (data.kind === "bounds") {
        const { left, top, right, bottom } = data;
        if (![left, top, right, bottom].every(Number.isFinite)) return;
        if (!model?.html || right <= left || bottom <= top) return;
        frame.style.clipPath = `inset(${Math.max(0, top)}px ${Math.max(0, frame.clientWidth - right)}px ${Math.max(0, frame.clientHeight - bottom)}px ${Math.max(0, left)}px)`;
        frame.style.pointerEvents = "auto";
        return;
      }
      if (model?.html && ["action", "input", "key"].includes(data.kind))
        onEvent(data);
    }

    window.addEventListener("message", (event) => {
      if (!event.isTrusted || !frame || port || event.source !== frame.contentWindow ||
          event.origin !== origin || event.data?.type !== "PAGE_REVIEW_PANEL_READY") return;
      const transport = new MessageChannel();
      port = transport.port1;
      port.onmessage = receive;
      frame.contentWindow.postMessage({
        type: "PAGE_REVIEW_PANEL_INIT",
        channel,
      }, origin, [transport.port2]);
    }, { signal: listener.signal });

    async function connect() {
      connecting = true;
      try {
        const token = await send("PANEL_BIND");
        if (listener.signal.aborted) return;
        channel = token;
        frame = document.createElement("iframe");
        frame.title = "Page Review 私有评注";
        frame.referrerPolicy = "no-referrer";
        frame.src = url.href + "#" + channel;
        Object.assign(frame.style, {
          position: "fixed",
          inset: "0",
          width: "100%",
          height: "100%",
          border: "0",
          zIndex: "80",
          clipPath: "inset(100%)",
          pointerEvents: "none",
        });
        frame.hidden = !model?.html;
        container.append(frame);
        timer = setTimeout(() => fail(new Error("私有评注面板无法打开，请重试")), 4500);
      } catch (error) {
        if (!listener.signal.aborted) fail(error);
      } finally {
        connecting = false;
      }
    }

    function prepare() {
      if (!frame && !connecting) void connect();
    }

    return {
      prepare,
      render(html, context, options) {
        model = { kind: "render", revision: ++revision, html, context, ...options };
        if (frame) {
          frame.style.pointerEvents = "none";
          // A hidden panel must release keyboard focus back to the page.
          frame.hidden = !html;
          if (!html) frame.style.clipPath = "inset(100%)";
        }
        if (loaded) port.postMessage(model);
        else if (html) prepare();
      },
      position(context) {
        if (!model?.html) return;
        model.context = context;
        if (loaded) port.postMessage({ kind: "position", revision, context });
      },
      composer(composer) {
        if (!model?.html) return;
        model.composer = composer;
        if (loaded) port.postMessage({ kind: "composer", revision, composer });
      },
      destroy() {
        listener.abort();
        model = null;
        reset();
      },
    };
  };
})(globalThis);

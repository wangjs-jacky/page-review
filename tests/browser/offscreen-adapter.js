/* Only served by the loopback integration server, never packaged. */
window.chrome = {
  runtime: {
    id: parent.chrome.runtime.id,
    onMessage: { addListener: (fn) => (window.__offscreenListener = fn) },
    sendMessage: (message) => parent.__adapterOffscreenEvent(message),
  },
};
navigator.mediaDevices.getUserMedia = async () =>
  parent.__syntheticCaptureSource();

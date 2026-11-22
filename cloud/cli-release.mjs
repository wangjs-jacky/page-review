// Shared by the Worker, CLI and installer renderer. Published paths are immutable.
export const CLI_VERSION = "0.4.4";
export const READ_PROTOCOL = 1;
export const CLI_FILES = Object.freeze([
  "page-review-darwin-arm64.tar.gz",
  "page-review-darwin-x64.tar.gz",
  "SHA256SUMS",
  "page-review-node.tar.gz",
  "SHA256SUMS.node",
]);
export const INSTALLER_KEY = `installers/${CLI_VERSION}-r1.sh`;
export const CLI_CAPABILITIES = Object.freeze({
  version: CLI_VERSION,
  readProtocol: READ_PROTOCOL,
  livePageReferences: 1,
  syncAfter: 1,
});

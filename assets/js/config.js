// APP_VERSION is rewritten by tools/stamp-version.mjs on deploy and must match
// the APP_VERSION constant at the top of sw.js.
export const CONFIG = Object.freeze({
  APP_VERSION: "dev",
  HUB: "https://huggingface.co",
  REPO: "arjun10g/acoustify-library",
  LIBRARY_FILE: "library.json",
  BUNDLED_LIBRARY_URL: "./data/library.json",
  TOKEN_HELP_URL: "https://huggingface.co/settings/tokens/new?tokenType=fineGrained"
});
